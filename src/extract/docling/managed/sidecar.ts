import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { abortError } from '../../../core/errors';
import { LineReader } from './lines';
import { managedEnv } from './paths';
import type { ManagedPaths } from './paths';

/** JSON-RPC 2.0 over stdio, one message per line. Protocol: python/docling_sidecar.py. */
interface RpcMessage {
	jsonrpc: '2.0';
	id?: number | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

interface Pending {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	/** `seconds`: a recording's length, sent once before Whisper starts. */
	onProgress?: (done: number, total: number, detail?: string, seconds?: number) => void;
	/** The sidecar took the request up; each of its lanes runs one at a time, so others wait until then. */
	onStarted?: () => void;
}

/** The sidecar process ended (crash, kill, or never started); every open request rejects with this. */
export class SidecarExited extends Error {
	constructor(
		message: string,
		/** Last stderr lines, for the job log. */
		readonly stderrTail: string,
		/** Set when kill() stopped it for this request's stall; the others it took down did nothing wrong. */
		readonly killedFor?: number,
	) {
		super(message);
		this.name = 'SidecarExited';
	}
}

/** The sidecar answered a request with a JSON-RPC error. */
export class SidecarError extends Error {
	constructor(
		message: string,
		readonly code: number,
	) {
		super(message);
		this.name = 'SidecarError';
	}
}

export interface SidecarOptions {
	/** Each stderr line: Docling's logging and Python tracebacks. */
	onStderr: (line: string) => void;
	/** Started, stopped or crashed. */
	onStateChange: () => void;
	/** How long the sidecar may sit idle before it is stopped. */
	idleMs: number;
	/** How long to wait for `ready` after spawning. */
	startTimeoutMs: number;
	/** Whether the process may fetch models now: only during an install. */
	online?: () => boolean;
	/** Runs before each spawn, e.g. to check the script on disk. */
	beforeSpawn?: () => Promise<void>;
}

const STDERR_TAIL_LINES = 20;
/** After closing stdin, how long to wait before killing. */
const STOP_GRACE_MS = 2000;

/**
 * One long-lived Python process running Docling. Started on first use, stopped
 * after `idleMs` without work, and on dispose. It exits by itself when stdin
 * closes, which also covers Obsidian crashing. The sidecar has two lanes,
 * recordings and everything else, each running its requests one at a time in
 * the order sent: a transcription runs beside a document.
 */
export class DoclingSidecar {
	private child: ChildProcessWithoutNullStreams | null = null;
	private starting: Promise<void> | null = null;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private readonly stdout = new LineReader();
	private stderrBuffer = '';
	private stderrTail: string[] = [];
	private idleTimer: number | null = null;
	/** The request the running process was killed for, if it was. */
	private killedFor: number | undefined;
	/** Counts spawns, so callers can tell a fresh process from the one they warmed. */
	generation = 0;

	constructor(
		private readonly paths: ManagedPaths,
		private readonly options: SidecarOptions,
	) {}

	get running(): boolean {
		return this.child !== null && this.starting === null;
	}

	/** Spawns the sidecar if needed and waits for its `ready` notification. */
	start(): Promise<void> {
		if (this.child && !this.starting) return Promise.resolve();
		if (!this.starting) this.starting = (this.options.beforeSpawn?.() ?? Promise.resolve()).then(() => this.spawn()).finally(() => (this.starting = null));
		return this.starting;
	}

	/**
	 * Sends a request and resolves with its result. `signal` only stops the
	 * caller waiting; use cancel() to tell the sidecar.
	 */
	async request<T>(
		method: string,
		params: Record<string, unknown>,
		opts: { onProgress?: (done: number, total: number, detail?: string, seconds?: number) => void; onStarted?: () => void; signal?: AbortSignal; onId?: (id: number) => void } = {},
	): Promise<T> {
		await this.start();
		const child = this.child;
		if (!child) throw new SidecarExited('Docling stopped before the request was sent', this.tail());
		this.clearIdle();
		const id = this.nextId++;
		opts.onId?.(id);
		const result = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject, onProgress: opts.onProgress, onStarted: opts.onStarted });
		});
		this.write({ jsonrpc: '2.0', id, method, params });
		if (!opts.signal) return result.finally(() => this.scheduleIdle());
		const signal = opts.signal;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				// The sidecar may keep converting until the next chunk; its progress belongs to no job now
				const pending = this.pending.get(id);
				if (pending) pending.onProgress = undefined;
				reject(abortError());
			};
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
			result.then(resolve, reject).finally(() => {
				signal.removeEventListener('abort', onAbort);
				this.scheduleIdle();
			});
		});
	}

	/** Asks the sidecar to stop a convert at the next page chunk. */
	cancel(id: number): void {
		if (this.child) this.write({ jsonrpc: '2.0', method: 'cancel', params: { id } });
	}

	/** Closes stdin so the sidecar exits; kills it if it has not after a grace period. */
	stop(): void {
		const child = this.child;
		if (!child) return;
		child.stdin.end();
		window.setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		}, STOP_GRACE_MS);
	}

	/**
	 * Immediate stop, e.g. after a timeout: the work in progress is lost, in
	 * both lanes. `forRequest`: the request that stalled, so the others can be
	 * told apart and sent again.
	 */
	kill(forRequest?: number): void {
		if (!this.child) return;
		this.killedFor ??= forRequest;
		this.child.kill('SIGKILL');
	}

	dispose(): void {
		this.clearIdle();
		this.stop();
	}

	private spawn(): Promise<void> {
		this.stdout.reset();
		this.stderrBuffer = '';
		this.stderrTail = [];
		this.killedFor = undefined;
		this.generation++;
		// -I: isolated, so neither the environment nor the script's folder adds anything to what Python imports
		const child = spawn(this.paths.python, ['-I', '-u', this.paths.sidecar], {
			cwd: this.paths.root,
			env: managedEnv(this.paths, { online: this.options.online?.() ?? false }),
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child = child;

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = window.setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill('SIGKILL');
				reject(new SidecarExited('Docling did not start in time', this.tail()));
			}, this.options.startTimeoutMs);

			const onReady = () => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve();
				this.options.onStateChange();
			};

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => this.onStdout(chunk, onReady));
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
			child.on('error', (error) => {
				// spawn failure (missing interpreter); 'exit' may not follow
				this.onExit(child, `Couldn't start Docling: ${error.message}`);
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				reject(new SidecarExited(`Couldn't start Docling: ${error.message}`, this.tail()));
			});
			child.on('exit', (code, signal) => {
				const why = signal ? `Docling stopped (${signal})` : `Docling exited with code ${String(code)}`;
				this.onExit(child, why);
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				reject(new SidecarExited(why, this.tail()));
			});
		});
	}

	private onExit(child: ChildProcessWithoutNullStreams, why: string): void {
		if (this.child !== child) return;
		this.child = null;
		this.clearIdle();
		const error = new SidecarExited(why, this.tail(), this.killedFor);
		for (const p of this.pending.values()) p.reject(error);
		this.pending.clear();
		this.options.onStateChange();
	}

	private onStdout(chunk: string, onReady: () => void): void {
		for (const raw of this.stdout.push(chunk)) {
			const line = raw.trim();
			if (!line) continue;
			let message: RpcMessage;
			try {
				message = JSON.parse(line) as RpcMessage;
			} catch {
				this.options.onStderr(`[stdout] ${line}`);
				continue;
			}
			this.dispatch(message, onReady);
		}
	}

	private dispatch(message: RpcMessage, onReady: () => void): void {
		if (message.method === 'ready') return onReady();
		if (message.method === 'started') {
			this.pending.get(Number(message.params?.id))?.onStarted?.();
			return;
		}
		if (message.method === 'progress') {
			const params = message.params ?? {};
			const pending = this.pending.get(Number(params.id));
			const detail = typeof params.detail === 'string' ? params.detail : undefined;
			const seconds = typeof params.seconds === 'number' ? params.seconds : undefined;
			pending?.onProgress?.(Number(params.done), Number(params.total), detail, seconds);
			return;
		}
		if (typeof message.id !== 'number') {
			if (message.error) this.options.onStderr(`[rpc] ${message.error.message}`);
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) pending.reject(new SidecarError(message.error.message, message.error.code));
		else pending.resolve(message.result ?? null);
	}

	private onStderr(chunk: string): void {
		this.stderrBuffer += chunk;
		const lines = this.stderrBuffer.split(/\r?\n|\r/);
		this.stderrBuffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			this.stderrTail.push(line);
			if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
			this.options.onStderr(line);
		}
	}

	private write(message: RpcMessage): void {
		this.child?.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private tail(): string {
		return this.stderrTail.join('\n');
	}

	private scheduleIdle(): void {
		this.clearIdle();
		if (this.pending.size > 0 || !this.child) return;
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null;
			if (this.pending.size === 0) this.stop();
		}, this.options.idleMs);
	}

	private clearIdle(): void {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}
}
