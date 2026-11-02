/** Shared domain types. UI and services depend on these, never on each other. */

/** `paused`: held back by the user; the worker passes it over until it is resumed. */
/** `excluded`: the user said not to process this file; nothing queues it again until they say otherwise. */
export type JobState = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'skipped' | 'excluded';

/** How a job entered the queue. */
export type JobTrigger = 'manual' | 'context-menu' | 'auto-ingest' | 'backfill';

/** Why a job was skipped rather than failed. */
export type SkipReason = 'ignored' | 'already-processed' | 'unsupported-type' | 'disabled';

/** Coarse stage shown next to the progress bar. */
export type JobStage = 'hashing' | 'extracting' | 'summarising' | 'writing';

export interface Job {
	// Identity and source
	/** Stable per-job uuid. Dedupe uses `hash`, never the id. */
	id: string;
	/** Vault-relative path at enqueue time. */
	sourcePath: string;
	/** sha256 of the file bytes. Kept separate from id so the id scheme can change. */
	hash?: string;

	// State and timing (epoch ms)
	state: JobState;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** 0–100 through the current stage, while running; unset when the stage cannot say. */
	progress?: number;
	stage?: JobStage;
	/** The step within the stage, e.g. "page 15 of 62"; shown next to the stage. */
	detail?: string;

	// Outcome
	/** Runs so far, shown in the job log. */
	attempts: number;
	/** Short user-facing reason when failed. */
	error?: string;
	/** Stable code for grouping failures, e.g. "engine-unavailable", "missing". */
	errorCode?: string;
	/** Why the job was skipped rather than failed. */
	skipReason?: SkipReason;
	/** Written note, set on done. */
	notePath?: string;
	/** Engine that produced the text: "docling" or "text". */
	extractor?: string;
	/** LLM used for the summary. */
	model?: string;

	// Origin and context
	trigger: JobTrigger;
	/** Notes that embed the source, resolved at run time. */
	referencedBy?: string[];
}

/** Waiting, running or paused, as opposed to finished in any way. */
export const isActive = (j: Job): boolean => j.state === 'pending' || j.state === 'running' || j.state === 'paused';

/** Waiting or running: what the worker still has to do. Paused jobs wait for the user instead. */
export const isQueued = (j: Job): boolean => j.state === 'pending' || j.state === 'running';

/** Skips that a setting change can turn into a run; the others would only be skipped again. */
const RETRYABLE_SKIPS: ReadonlySet<SkipReason> = new Set(['unsupported-type', 'disabled']);

/** Failed, cancelled, or skipped for a reason a retry can change. */
export const isRetryable = (j: Job): boolean =>
	j.state === 'failed' || j.state === 'cancelled' || (j.state === 'skipped' && j.skipReason !== undefined && RETRYABLE_SKIPS.has(j.skipReason));

/** Derived for display; never stored. */
export const jobName = (job: Job): string => job.sourcePath.split('/').pop() ?? job.sourcePath;

export interface QueueSnapshot {
	paused: boolean;
	jobs: readonly Job[];
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
	ts: number;
	level: LogLevel;
	message: string;
}

/**
 * Job error codes for a fatal engine error: the extraction server cannot be
 * reached, or it rejects the API key. The service pauses the queue instead of
 * failing every job the same way.
 */
export const ENGINE_UNAVAILABLE = 'engine-unavailable';
export const ENGINE_AUTH = 'engine-auth';

export function isEngineFatal(code: string | undefined): boolean {
	return code === ENGINE_UNAVAILABLE || code === ENGINE_AUTH;
}

export type IngestEvent =
	| { type: 'changed' }
	| { type: 'done'; job: Job }
	| { type: 'failed'; job: Job }
	/** The engine is unreachable or rejects the key; the queue has paused. Sent once per pause. */
	| { type: 'engine-unavailable'; job: Job };
