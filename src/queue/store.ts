import { promises as fs } from 'fs';
import * as path from 'path';
import type { Job, LogEntry } from '../core/types';

export interface QueueFile {
	version: 1;
	paused: boolean;
	jobs: Job[];
}

const SAVE_DEBOUNCE_MS = 250;
export const LOG_ENTRIES_PER_JOB = 200;

interface LogLine extends LogEntry {
	jobId: string;
}

const EMPTY: QueueFile = { version: 1, paused: false, jobs: [] };

/**
 * Persistence for the queue: a JSON snapshot plus an append-only log, in this
 * vault's folder under app data. The queue is per machine (each machine runs
 * its own jobs and its own Docling), so it never goes into the vault where
 * sync would merge two machines' queues and both might run the same job.
 */
export class QueueStore {
	private readonly queuePath: string;
	private readonly logPath: string;
	private saveTimer: number | null = null;
	private pendingSave: QueueFile | null = null;
	private appendChain: Promise<void> = Promise.resolve();

	constructor(dir: string) {
		this.queuePath = path.join(dir, 'queue.json');
		this.logPath = path.join(dir, 'log.jsonl');
	}

	async load(): Promise<QueueFile> {
		await fs.mkdir(path.dirname(this.queuePath), { recursive: true });
		let text: string;
		try {
			text = await fs.readFile(this.queuePath, 'utf8');
		} catch {
			return { ...EMPTY, jobs: [] };
		}
		return parseQueue(text);
	}

	/** Debounced; the last state wins. */
	save(state: QueueFile): void {
		this.pendingSave = state;
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
	}

	/** Immediate write, bypassing the debounce. Used on unload. */
	async saveNow(state: QueueFile): Promise<void> {
		this.clearTimer();
		this.pendingSave = null;
		await this.writeQueue(state);
	}

	/**
	 * Rewrites the log file to hold only the given jobs, so it does not grow forever.
	 * Queued behind pending appends, so a rewrite never races with them.
	 */
	rewriteLogs(logs: Map<string, LogEntry[]>): Promise<void> {
		const lines: string[] = [];
		for (const [jobId, entries] of logs) {
			for (const entry of entries) lines.push(JSON.stringify({ jobId, ...entry } satisfies LogLine));
		}
		const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
		this.appendChain = this.appendChain.then(() => fs.writeFile(this.logPath, text, 'utf8')).catch(() => undefined);
		return this.appendChain;
	}

	async flush(): Promise<void> {
		this.clearTimer();
		const state = this.pendingSave;
		this.pendingSave = null;
		if (state) await this.writeQueue(state);
	}

	/** Appends run one after another, so lines land in the order they were logged. */
	appendLog(jobId: string, entry: LogEntry): Promise<void> {
		const line: LogLine = { jobId, ...entry };
		this.appendChain = this.appendChain
			.then(() => fs.appendFile(this.logPath, `${JSON.stringify(line)}\n`, 'utf8'))
			.catch(() => undefined);
		return this.appendChain;
	}

	/** Groups the log by job, keeping only recent entries per job. */
	async loadLogs(): Promise<Map<string, LogEntry[]>> {
		let text: string;
		try {
			text = await fs.readFile(this.logPath, 'utf8');
		} catch {
			return new Map();
		}
		return parseLogs(text);
	}

	private async writeQueue(state: QueueFile): Promise<void> {
		// Write then rename, so a crash mid-write never leaves a half-written queue
		const tmp = `${this.queuePath}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(state, null, '\t'), 'utf8');
		await fs.rename(tmp, this.queuePath);
	}

	private clearTimer(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}

function parseQueue(text: string): QueueFile {
	try {
		const parsed = JSON.parse(text) as Partial<QueueFile>;
		return { version: 1, paused: parsed.paused === true, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
	} catch {
		return { ...EMPTY, jobs: [] };
	}
}

function parseLogs(text: string): Map<string, LogEntry[]> {
	const logs = new Map<string, LogEntry[]>();
	for (const raw of text.split('\n')) {
		if (raw.trim() === '') continue;
		try {
			const { jobId, ...entry } = JSON.parse(raw) as LogLine;
			const list = logs.get(jobId) ?? [];
			list.push(entry);
			if (list.length > LOG_ENTRIES_PER_JOB) list.shift();
			logs.set(jobId, list);
		} catch {
			// skip corrupt line
		}
	}
	return logs;
}
