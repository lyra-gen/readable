import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { requestUrl } from 'obsidian';
import type { LocalModel } from './catalog';
import type { LlamaPaths } from './paths';
import { readGgufInfo } from './gguf';
import { CONTEXT_TOKENS } from './release';

export interface LlamaServerOptions {
	/** Each stderr line, for the dev log. */
	onStderr: (line: string) => void;
	onStateChange: () => void;
	/** Read at each request, so a settings change applies from the next one. */
	idleMs: () => number;
	/** Loading 3 GB of weights from a cold disk takes a while. */
	startTimeoutMs: number;
}

/** First port tried; the next few are tried when it is taken. */
const FIRST_PORT = 11480;
const PORT_TRIES = 5;
const HEALTH_POLL_MS = 500;
const STOP_GRACE_MS = 3000;
const STDERR_TAIL_LINES = 20;

export class LlamaServerFailed extends Error {
	constructor(
		message: string,
		readonly stderrTail: string,
	) {
		super(message);
		this.name = 'LlamaServerFailed';
	}
}

/**
 * One llama-server process serving the built-in model on localhost. Started
 * on first use, stopped after `idleMs` without requests, and on dispose.
 * Only this machine can reach it: it binds 127.0.0.1 with no key.
 *
 * llama-server cannot notice its parent dying, so it runs under a watchdog
 * (`sh` on macOS and Linux, PowerShell on Windows) that waits on stdin and
 * kills the server when the pipe closes. An Obsidian crash therefore never
 * leaves 4 GB of model in memory.
 */
export class LlamaServer {
	private child: ChildProcessWithoutNullStreams | null = null;
	private port: number | null = null;
	private starting: Promise<string> | null = null;
	private idleTimer: number | null = null;
	private stderrTail: string[] = [];
	private stderrBuffer = '';
	/** The model the running (or starting) process serves. */
	private model: LocalModel | null = null;

	constructor(
		private readonly paths: LlamaPaths,
		private readonly options: LlamaServerOptions,
	) {}

	get running(): boolean {
		return this.child !== null && this.port !== null && this.starting === null;
	}

	/** The server's base URL while it runs, e.g. `http://127.0.0.1:11480`. */
	get baseUrl(): string | null {
		return this.running && this.port !== null ? `http://127.0.0.1:${this.port}` : null;
	}

	/**
	 * The key every request must carry, new for each start. The server listens
	 * on loopback, where any program or browser tab could otherwise use it.
	 */
	get apiKey(): string | null {
		return this.running ? this.key : null;
	}

	/** The model loaded now; null when stopped. */
	get loadedModel(): LocalModel | null {
		return this.running ? this.model : null;
	}

	/**
	 * Serves `model`, starting the server or restarting it with this model
	 * when another one is loaded; resolves with the base URL once it answers.
	 */
	async start(model: LocalModel): Promise<string> {
		this.touch();
		while (this.starting) {
			const pending = this.starting;
			await pending.catch(() => undefined);
		}
		const url = this.baseUrl;
		if (url && this.model?.path === model.path) return url;
		if (url) this.stop();
		this.model = model;
		this.starting = this.spawnAndWait(model).finally(() => (this.starting = null));
		return this.starting;
	}

	/** Call around each request so the idle timer only runs between them. */
	touch(): void {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => this.stop(), this.options.idleMs());
	}

	stop(): void {
		const child = this.child;
		if (!child) return;
		this.child = null;
		this.port = null;
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
		// Closing stdin is the watchdog's stop signal on every platform; the kill is for a stuck one
		child.stdin.end();
		const force = window.setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
		child.once('exit', () => window.clearTimeout(force));
		this.options.onStateChange();
	}

	dispose(): void {
		this.stop();
	}

	private key: string | null = null;

	private async spawnAndWait(model: LocalModel): Promise<string> {
		this.key = randomBytes(24).toString('base64url');
		// Never ask for more context than the model was trained for; Readable needs at most CONTEXT_TOKENS
		const trained = (await readGgufInfo(model.path)).contextLength;
		const context = trained ? Math.min(CONTEXT_TOKENS, trained) : CONTEXT_TOKENS;
		let lastError = '';
		for (let i = 0; i < PORT_TRIES; i++) {
			const port = FIRST_PORT + i;
			// Something else already answers there (another app, or a server orphaned by a crash): leave it alone
			if (await healthy(port)) {
				lastError = `port ${port} is in use`;
				continue;
			}
			const failure = await this.trySpawn(port, model, context);
			if (failure === null) {
				this.port = port;
				this.options.onStateChange();
				return `http://127.0.0.1:${port}`;
			}
			lastError = failure;
			if (!/address already in use|bind/i.test(failure)) break;
		}
		throw new LlamaServerFailed(`The built-in model server did not start: ${lastError}`, this.tail());
	}

	/** Resolves null once /health answers 200, else the reason it did not. */
	private trySpawn(port: number, model: LocalModel, context: number): Promise<string | null> {
		this.stderrTail = [];
		const args = [
			'--model',
			model.path,
			...(model.projector ? ['--mmproj', model.projector] : ['--no-mmproj']),
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--ctx-size',
			String(context),
			'--parallel',
			'1',
			'--jinja',
			// Thinking models (Qwen3.5 and the like) would reason before every answer: slower, and nothing Readable uses
			'--reasoning',
			'off',
			'--alias',
			model.id,
			'--api-key',
			this.key ?? '',
			// Nothing but Readable talks to it: no web UI, no slot listing
			'--no-webui',
			'--no-slots',
			'--log-disable',
		];
		const child = this.spawnWatched(args);
		this.child = child;
		child.stdout.on('data', (chunk: Buffer) => this.onStderr(chunk));
		child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
		return new Promise((resolve) => {
			let settled = false;
			const finish = (result: string | null) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(deadline);
				resolve(result);
			};
			const deadline = window.setTimeout(() => {
				this.stop();
				finish(`no answer within ${Math.round(this.options.startTimeoutMs / 1000)} s`);
			}, this.options.startTimeoutMs);
			child.on('error', (error) => {
				this.child = null;
				finish(error.message);
			});
			child.on('exit', (code) => {
				if (this.child === child) {
					this.child = null;
					this.port = null;
					this.options.onStateChange();
				}
				finish(`exited with code ${String(code)}. ${this.tail()}`.trim());
			});
			const poll = async () => {
				while (!settled && this.child === child) {
					if (await healthy(port)) return finish(null);
					await new Promise((r) => window.setTimeout(r, HEALTH_POLL_MS));
				}
			};
			void poll();
		});
	}

	/** The server under its watchdog; the returned process is the watchdog, whose stdin we hold. */
	private spawnWatched(args: string[]): ChildProcessWithoutNullStreams {
		const opts = { cwd: this.paths.build, windowsHide: true };
		if (process.platform === 'win32') {
			const script = path.join(this.paths.root, 'watchdog.ps1');
			return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, this.paths.server, ...args], opts);
		}
		return spawn('/bin/sh', ['-c', POSIX_WATCHDOG, this.paths.server, ...args], opts);
	}

	private onStderr(chunk: Buffer): void {
		const lines = (this.stderrBuffer + chunk.toString('utf8')).split(/\r?\n/);
		this.stderrBuffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			this.stderrTail.push(line);
			if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
			this.options.onStderr(line);
		}
	}

	private tail(): string {
		return this.stderrTail.join('\n');
	}
}

/**
 * Runs the server ($0, the first argument) with the rest of the arguments,
 * then blocks on stdin; EOF (the parent closed it, or died) kills the server.
 */
const POSIX_WATCHDOG = [
	'"$0" "$@" &',
	'pid=$!',
	'trap \'kill "$pid" 2>/dev/null\' EXIT',
	'cat >/dev/null',
	'kill "$pid" 2>/dev/null',
	'wait "$pid" 2>/dev/null',
].join('\n');

/**
 * The same for PowerShell; written to disk once, since -Command quoting of
 * model paths is fragile. Start-Process joins -ArgumentList with spaces and
 * quotes nothing, so each argument is quoted here the way CommandLineToArgvW
 * reads it: a model path with a space stays one argument, and a file name
 * that looks like flags cannot become them.
 */
export const WINDOWS_WATCHDOG = [
	'$server = $args[0]',
	'$rest = @($args | Select-Object -Skip 1)',
	'function Quote($a) {',
	'  if ($a -eq \'\') { return \'""\' }',
	'  $e = [regex]::Replace($a, \'(\\\\*)"\', { param($m) $m.Groups[1].Value + $m.Groups[1].Value + \'\\"\' })',
	'  $e = [regex]::Replace($e, \'(\\\\+)$\', { param($m) $m.Groups[1].Value + $m.Groups[1].Value })',
	'  return \'"\' + $e + \'"\'',
	'}',
	'$line = ($rest | ForEach-Object { Quote $_ }) -join \' \'',
	'$p = Start-Process -FilePath $server -ArgumentList $line -NoNewWindow -PassThru',
	'try { [void][Console]::In.ReadToEnd() } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }',
].join('\r\n');

/** Writes the Windows watchdog script next to the install; a no-op elsewhere. */
export async function writeWatchdog(root: string): Promise<void> {
	if (process.platform !== 'win32') return;
	await fs.writeFile(path.join(root, 'watchdog.ps1'), WINDOWS_WATCHDOG, 'utf8');
}

/** /health is 503 while the model loads and 200 once ready. */
async function healthy(port: number): Promise<boolean> {
	try {
		const res = await requestUrl({ url: `http://127.0.0.1:${port}/health`, method: 'GET', throw: false });
		return res.status === 200;
	} catch {
		return false;
	}
}
