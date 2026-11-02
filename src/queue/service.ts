import { runJob } from '../pipeline/run-job';
import type { JobOutcome, PipelineConfig } from '../pipeline/run-job';
import { LOG_ENTRIES_PER_JOB } from './store';
import type { QueueStore } from './store';
import type { IngestService } from '../core/ingest-service';
import { isActive, isEngineFatal, isRetryable } from '../core/types';
import { laneOf } from '../extract/kinds';
import type { Lane } from '../extract/kinds';
import type { IngestEvent, Job, JobStage, JobTrigger, LogEntry, LogLevel, QueueSnapshot } from '../core/types';

export interface ServiceDeps extends PipelineConfig {
	store: QueueStore;
	concurrency: () => number;
}

/**
 * Retention. The queue is a work list, not the record of what was ingested
 * (the notes are), so old history is dropped on its own and nobody has to
 * clean it. Finished jobs: the newest KEEP_FINISHED, or everything from the
 * last KEEP_FINISHED_MS, whichever keeps more. Failed jobs wait for the user
 * but are capped so a broken run cannot grow the file without limit.
 */
const KEEP_FINISHED = 200;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;
const KEEP_FAILED = 500;

/** How a job ends once the pipeline unwinds: the pipeline's outcome, or what the user asked for while it stopped. */
type Finish = JobOutcome | { kind: 'paused' } | { kind: 'requeued' } | { kind: 'excluded' };

/**
 * The real queue behind IngestService: jobs persisted through QueueStore, a
 * worker that runs each through runJob with its own AbortController, and the
 * events the UI listens to. A file has at most one unfinished job. Adding it
 * again retries a failed or cancelled job in place (a paused or excluded one
 * only when added by hand, and the backfill leaves failed or cancelled ones
 * alone), and a done file gets a new job, the old one staying as history. The
 * concurrency limit is per lane, so recordings are
 * transcribed beside documents rather than behind them; within a lane, jobs run
 * in list order. Pause, exclude or requeue on a running job takes effect once
 * the pipeline unwinds, and a note already written keeps the job done. A fatal
 * engine error pauses the whole queue instead of failing every job. Enqueues
 * that arrive before init() are held until persisted state has loaded.
 */
export class PersistentIngestService implements IngestService {
	private jobs: Job[] = [];
	private paused = false;
	/** An engine-unavailable pause was reported; cleared on resume so the next one notifies again. */
	private engineDownReported = false;
	/**
	 * Bumped on every resume. A job that started before the latest resume and
	 * then hits a fatal engine error is requeued instead of pausing again: the
	 * user has already dealt with the pause (fixed or restarted the server),
	 * and the job was simply still in flight.
	 */
	private resumes = 0;
	private logs = new Map<string, LogEntry[]>();
	private controllers = new Map<string, AbortController>();
	/** The lane of each job the worker runs, fixed at start so a rename does not move it. */
	private lanes = new Map<string, Lane>();
	/**
	 * Running jobs stopped by Pause rather than Cancel: they end paused, or
	 * pending when resumed before the pipeline had unwound. Absent means cancelled.
	 */
	private afterAbort = new Map<string, 'pause' | 'requeue' | 'exclude'>();
	private listeners = new Set<(event: IngestEvent) => void>();
	private disposed = false;
	private initialized = false;
	/** Enqueue calls that arrive before init() has loaded persisted state. */
	private preInit: { paths: string[]; trigger: JobTrigger }[] = [];

	constructor(private readonly deps: ServiceDeps) {}

	/** Loads persisted state and resumes. Jobs left running by a previous session go back to pending; paused ones stay paused. */
	async init(): Promise<void> {
		const state = await this.deps.store.load();
		this.paused = state.paused;
		const interrupted = new Set(state.jobs.filter((j) => j.state === 'running').map((j) => j.id));
		this.jobs = state.jobs.map((job) =>
			interrupted.has(job.id) ? { ...job, state: 'pending', progress: undefined, stage: undefined, detail: undefined } : job,
		);
		this.logs = await this.deps.store.loadLogs();
		// Otherwise the log jumps from one "Started" to the next with no reason given
		for (const job of this.jobs) {
			if (interrupted.has(job.id)) this.log(job, 'info', 'Interrupted: Obsidian closed or Readable reloaded. Starting again.');
		}
		this.dropDuplicates();
		this.prune();
		this.initialized = true;
		const buffered = this.preInit;
		this.preInit = [];
		for (const { paths, trigger } of buffered) this.enqueue(paths, trigger);
		this.changed();
		this.pump();
	}

	dispose(): void {
		this.disposed = true;
		// A job still stopping from a pause stays paused after the reload, rather than starting again
		for (const [id, after] of this.afterAbort) {
			const job = this.find(id);
			if (job && after === 'pause') job.state = 'paused';
			if (job && after === 'exclude') job.state = 'excluded';
		}
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		this.lanes.clear();
		this.listeners.clear();
		// Write the final snapshot immediately; onunload cannot wait for a debounce
		if (this.initialized) void this.deps.store.saveNow({ version: 1, paused: this.paused, jobs: this.jobs });
	}

	// --- IngestService ---

	getSnapshot(): QueueSnapshot {
		return { paused: this.paused, jobs: this.jobs };
	}

	subscribe(listener: (event: IngestEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	enqueue(sourcePaths: string[], trigger: JobTrigger): void {
		if (!this.initialized) {
			this.preInit.push({ paths: sourcePaths, trigger });
			return;
		}
		let added = 0;
		for (const sourcePath of sourcePaths) {
			// One job per file: a file that already has one is retried in place, never queued twice
			const existing = this.latestFor(sourcePath);
			if (existing?.state === 'excluded') {
				// Only adding the file by hand undoes Don't process
				if (trigger !== 'manual' && trigger !== 'context-menu') continue;
				this.includeJob(existing);
				existing.trigger = trigger;
				added++;
				continue;
			}
			if (existing?.state === 'paused') {
				// The user paused it; only adding the file by hand again resumes it
				if (trigger !== 'manual' && trigger !== 'context-menu') continue;
				this.resumeJob(existing);
				existing.trigger = trigger;
				added++;
				continue;
			}
			if (existing && isActive(existing)) continue;
			if (existing && existing.state !== 'done') {
				// The sweep for files without a note leaves a failure or a cancel as it is; the user decides
				if (trigger === 'backfill') continue;
				this.resetForRetry(existing);
				existing.trigger = trigger;
				added++;
				continue;
			}
			const job: Job = {
				id: crypto.randomUUID(),
				sourcePath,
				state: 'pending',
				createdAt: Date.now(),
				attempts: 0,
				trigger,
			};
			this.jobs.push(job);
			this.log(job, 'info', `Queued (${trigger})`);
			added++;
		}
		if (added === 0) return;
		this.changed();
		this.pump();
	}

	cancel(jobId: string): void {
		this.cancelJobs([jobId]);
	}

	retry(jobId: string): void {
		this.retryJobs([jobId]);
	}

	remove(jobId: string): void {
		this.removeJobs([jobId]);
	}

	pauseJobs(jobIds: readonly string[]): void {
		this.update(jobIds, (job) => {
			if (job.state === 'pending') {
				job.state = 'paused';
				this.log(job, 'info', 'Paused');
				return true;
			}
			if (job.state === 'running' && this.afterAbort.get(job.id) !== 'pause') {
				// finishJob marks it paused once the pipeline unwinds; a PDF's checkpoint stays for the resume.
				// Until then it shows as pausing, so it counts as a change.
				this.afterAbort.set(job.id, 'pause');
				this.controllers.get(job.id)?.abort();
				return true;
			}
			return false;
		});
	}

	resumeJobs(jobIds: readonly string[]): void {
		this.update(jobIds, (job) => {
			if (job.state === 'paused') {
				this.resumeJob(job);
				return true;
			}
			if (job.state === 'running' && this.afterAbort.get(job.id) === 'pause') {
				// Resumed while it was still stopping: it goes back in line instead of ending paused
				this.afterAbort.set(job.id, 'requeue');
				this.log(job, 'info', 'Resumed');
				return true;
			}
			return false;
		});
	}

	runNext(jobIds: readonly string[]): void {
		const chosen = this.select(jobIds).filter((j) => j.state === 'pending' || j.state === 'paused');
		if (chosen.length === 0) return;
		for (const job of chosen) {
			if (job.state === 'paused') this.resumeJob(job);
		}
		// The worker takes the first pending job in list order, so the front of the line is just before the first other one
		const moved = new Set(chosen);
		const rest = this.jobs.filter((j) => !moved.has(j));
		const front = rest.findIndex((j) => j.state === 'pending');
		if (front >= 0) this.jobs = [...rest.slice(0, front), ...chosen, ...rest.slice(front)];
		this.changed();
		this.pump();
	}

	cancelJobs(jobIds: readonly string[]): void {
		for (const job of this.select(jobIds)) {
			if (job.state !== 'running') continue;
			// finishJob marks it cancelled once the pipeline unwinds, even if a pause was on its way
			this.afterAbort.delete(job.id);
			this.controllers.get(job.id)?.abort();
		}
	}

	retryJobs(jobIds: readonly string[]): void {
		this.update(jobIds, (job) => {
			if (!isRetryable(job)) return false;
			this.resetForRetry(job);
			return true;
		});
	}

	removeJobs(jobIds: readonly string[]): void {
		const removed = new Set(this.select(jobIds));
		if (removed.size === 0) return;
		for (const job of removed) {
			// finishJob ignores it once the pipeline unwinds
			if (job.state === 'running') this.controllers.get(job.id)?.abort();
			this.afterAbort.delete(job.id);
		}
		this.jobs = this.jobs.filter((j) => !removed.has(j));
		this.dropLogs([...removed].map((j) => j.id));
		this.changed();
	}

	excludeJobs(jobIds: readonly string[]): void {
		this.update(jobIds, (job) => this.excludeJob(job));
	}

	excludePaths(sourcePaths: readonly string[]): void {
		let changed = false;
		for (const sourcePath of new Set(sourcePaths)) {
			const existing = this.latestFor(sourcePath);
			if (existing) {
				changed = this.excludeJob(existing) || changed;
				continue;
			}
			const job: Job = { id: crypto.randomUUID(), sourcePath, state: 'excluded', createdAt: Date.now(), attempts: 0, trigger: 'manual' };
			this.jobs.push(job);
			this.log(job, 'info', "Don't process");
			changed = true;
		}
		if (changed) this.changed();
	}

	includeJobs(jobIds: readonly string[]): void {
		this.update(jobIds, (job) => {
			if (job.state !== 'excluded') return false;
			this.includeJob(job);
			return true;
		});
	}

	renamePath(oldPath: string, newPath: string): void {
		const moved = this.jobs.filter((j) => j.sourcePath === oldPath);
		if (moved.length === 0) return;
		for (const job of moved) job.sourcePath = newPath;
		this.changed();
	}

	retryAllFailed(): void {
		let any = false;
		for (const job of this.jobs) {
			if (job.state !== 'cancelled' && isRetryable(job)) {
				this.resetForRetry(job);
				any = true;
			}
		}
		if (!any) return;
		this.changed();
		this.pump();
	}

	clearFinished(): void {
		// Excluded jobs are the record that a file is not to be processed, so they stay
		const keeps = (j: Job) => isActive(j) || j.state === 'excluded';
		const removed = this.jobs.filter((j) => !keeps(j)).map((j) => j.id);
		this.jobs = this.jobs.filter(keeps);
		this.dropLogs(removed);
		this.changed();
	}

	pause(): void {
		this.paused = true;
		this.changed();
	}

	resume(): void {
		this.paused = false;
		this.engineDownReported = false;
		this.resumes += 1;
		this.changed();
		this.pump();
	}

	isPausing(jobId: string): boolean {
		return this.afterAbort.get(jobId) === 'pause';
	}

	getLog(jobId: string): readonly LogEntry[] {
		return this.logs.get(jobId) ?? [];
	}

	// --- worker ---

	private pump(): void {
		if (this.disposed || this.paused || !this.initialized) return;
		const limit = Math.max(1, this.deps.concurrency());
		// The limit is per lane: recordings are transcribed beside documents. Within a lane, list order
		const busy = (lane: Lane) => [...this.lanes.values()].filter((l) => l === lane).length;
		for (;;) {
			const next = this.jobs.find((j) => j.state === 'pending' && busy(laneOf(j.sourcePath)) < limit);
			if (!next) return;
			void this.start(next);
		}
	}

	private async start(job: Job): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(job.id, controller);
		this.lanes.set(job.id, laneOf(job.sourcePath));
		job.state = 'running';
		job.startedAt = Date.now();
		job.attempts += 1;
		delete job.finishedAt;
		delete job.error;
		delete job.errorCode;
		delete job.skipReason;
		this.log(job, 'info', `Started (attempt ${job.attempts})`);
		this.changed();
		const resumesAtStart = this.resumes;

		const outcome = await runJob(
			{ ...this.deps, log: (j, l, m) => this.log(j, l, m), progress: (j, s, f, d) => this.progress(j, s, f, d) },
			job,
			controller.signal,
		);
		this.controllers.delete(job.id);
		this.lanes.delete(job.id);
		const after = this.afterAbort.get(job.id);
		this.afterAbort.delete(job.id);
		if (this.disposed) return;
		// A note written before the pipeline saw the stop is kept as done, so nothing is lost and Open note works
		const finish: Finish = !controller.signal.aborted || outcome.kind === 'done'
			? outcome
			: after === 'exclude'
			  ? { kind: 'excluded' }
			  : after === 'pause'
			  ? { kind: 'paused' }
			  : after === 'requeue'
				? { kind: 'requeued' }
				: { kind: 'cancelled' };
		this.finishJob(job, finish, resumesAtStart !== this.resumes);
		this.pump();
	}

	/** `startedBeforeResume`: the queue was resumed while this job ran. */
	private finishJob(job: Job, outcome: Finish, startedBeforeResume: boolean): void {
		if (!this.jobs.includes(job)) return; // removed while running
		job.finishedAt = Date.now();
		delete job.progress;
		delete job.stage;
		delete job.detail;
		switch (outcome.kind) {
			case 'done':
				job.state = 'done';
				job.notePath = outcome.notePath;
				job.extractor = outcome.extractor;
				if (outcome.model) job.model = outcome.model;
				this.emit({ type: 'done', job });
				break;
			case 'failed':
				if (isEngineFatal(outcome.code) && startedBeforeResume) {
					this.log(job, 'warn', `${outcome.message}. The queue was resumed since this job started`);
					this.resetForRetry(job);
					break;
				}
				job.state = 'failed';
				job.error = outcome.message;
				job.errorCode = outcome.code;
				if (isEngineFatal(outcome.code)) this.engineUnavailable(job);
				else this.emit({ type: 'failed', job });
				break;
			case 'skipped':
				job.state = 'skipped';
				job.skipReason = outcome.reason;
				break;
			case 'cancelled':
				job.state = 'cancelled';
				this.log(job, 'warn', 'Cancelled');
				break;
			// Not finished: paused or waiting again, so no finish time
			case 'paused':
				job.state = 'paused';
				delete job.finishedAt;
				this.log(job, 'info', 'Paused');
				break;
			case 'requeued':
				job.state = 'pending';
				delete job.finishedAt;
				break;
			case 'excluded':
				job.state = 'excluded';
				this.log(job, 'info', "Don't process");
				break;
		}
		this.prune();
		this.changed();
	}

	/** Drops old history per the retention rules above; see the constants. */
	private prune(): void {
		const now = Date.now();
		const newestFirst = (a: Job, b: Job) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
		const finished = this.jobs.filter((j) => j.state === 'done' || j.state === 'skipped' || j.state === 'cancelled').sort(newestFirst);
		const failed = this.jobs.filter((j) => j.state === 'failed').sort(newestFirst);
		const drop = new Set<string>();
		finished.forEach((job, i) => {
			if (i >= KEEP_FINISHED && (job.finishedAt ?? job.createdAt) < now - KEEP_FINISHED_MS) drop.add(job.id);
		});
		failed.slice(KEEP_FAILED).forEach((job) => drop.add(job.id));
		if (drop.size === 0) return;
		this.jobs = this.jobs.filter((j) => !drop.has(j.id));
		this.dropLogs([...drop]);
	}

	/**
	 * Fatal engine error: pause rather than fail every remaining job the same
	 * way. Jobs already running finish (and fail) on their own; only the first
	 * one is reported.
	 */
	private engineUnavailable(job: Job): void {
		this.paused = true;
		this.log(job, 'error', 'Extraction engine unavailable; queue paused');
		if (this.engineDownReported) return;
		this.engineDownReported = true;
		this.emit({ type: 'engine-unavailable', job });
	}

	/**
	 * The bar shows the current stage, not the whole job: the stages' shares of
	 * the time differ too much between files (a scanned PDF is all extracting,
	 * a long web page mostly summarising) for one bar to be honest. Stages
	 * without a measurable fraction leave `progress` undefined, so the UI shows
	 * an indeterminate bar.
	 */
	private progress(job: Job, stage: JobStage, fraction?: number, detail?: string): void {
		if (job.stage !== stage) delete job.detail;
		job.stage = stage;
		if (detail !== undefined) job.detail = detail;
		if (fraction === undefined) {
			delete job.progress;
		} else {
			job.progress = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
		}
		this.emit({ type: 'changed' });
	}

	private resetForRetry(job: Job): void {
		job.state = 'pending';
		delete job.error;
		delete job.errorCode;
		delete job.skipReason;
		delete job.finishedAt;
		delete job.startedAt;
		this.log(job, 'info', 'Retrying');
	}

	private resumeJob(job: Job): void {
		job.state = 'pending';
		this.log(job, 'info', 'Resumed');
	}

	/** Don't process one job: at once, or once a running one has stopped. False when it already is. */
	private excludeJob(job: Job): boolean {
		if (job.state === 'excluded' || this.afterAbort.get(job.id) === 'exclude') return false;
		if (job.state === 'running') {
			this.afterAbort.set(job.id, 'exclude');
			this.controllers.get(job.id)?.abort();
			return true;
		}
		job.state = 'excluded';
		delete job.error;
		delete job.errorCode;
		delete job.skipReason;
		this.log(job, 'info', "Don't process");
		return true;
	}

	private includeJob(job: Job): void {
		job.state = 'pending';
		delete job.finishedAt;
		this.log(job, 'info', 'Process again');
	}

	/** Applies `change` to the listed jobs in queue order; saves, notifies and wakes the worker once if any changed. */
	private update(jobIds: readonly string[], change: (job: Job) => boolean): void {
		let any = false;
		for (const job of this.select(jobIds)) any = change(job) || any;
		if (!any) return;
		this.changed();
		this.pump();
	}

	// --- helpers ---

	private find(jobId: string): Job | undefined {
		return this.jobs.find((j) => j.id === jobId);
	}

	/** The listed jobs that exist, in queue order. */
	private select(jobIds: readonly string[]): Job[] {
		const ids = new Set(jobIds);
		return this.jobs.filter((j) => ids.has(j.id));
	}

	/** The newest job for a file, in any state. */
	private latestFor(sourcePath: string): Job | undefined {
		let latest: Job | undefined;
		for (const job of this.jobs) {
			if (job.sourcePath === sourcePath && (!latest || job.createdAt >= latest.createdAt)) latest = job;
		}
		return latest;
	}

	/**
	 * Older queues could hold several jobs for one file (each reload's sweep
	 * added another). Keeps the newest unfinished one per file, and drops the
	 * failed, cancelled and skipped jobs it replaces; finished ones stay as history.
	 */
	private dropDuplicates(): void {
		const keep = new Map<string, Job>();
		for (const job of this.jobs) {
			if (job.state === 'done') continue;
			const kept = keep.get(job.sourcePath);
			// An unfinished or excluded job wins over a failed or cancelled one, then the newer one
			const live = (j: Job) => isActive(j) || j.state === 'excluded';
			const better = !kept || (live(job) && !live(kept)) || (live(job) === live(kept) && job.createdAt >= kept.createdAt);
			if (better) keep.set(job.sourcePath, job);
		}
		const drop = this.jobs.filter((j) => j.state !== 'done' && keep.get(j.sourcePath) !== j).map((j) => j.id);
		if (drop.length === 0) return;
		const dropped = new Set(drop);
		this.jobs = this.jobs.filter((j) => !dropped.has(j.id));
		this.dropLogs(drop);
	}

	private log(job: Job, level: LogLevel, message: string): void {
		const entry: LogEntry = { ts: Date.now(), level, message };
		const list = this.logs.get(job.id) ?? [];
		list.push(entry);
		if (list.length > LOG_ENTRIES_PER_JOB) list.shift();
		this.logs.set(job.id, list);
		void this.deps.store.appendLog(job.id, entry);
	}

	/** Persists and notifies after any state change. */
	private changed(): void {
		this.deps.store.save({ version: 1, paused: this.paused, jobs: this.jobs });
		this.emit({ type: 'changed' });
	}

	private dropLogs(jobIds: string[]): void {
		for (const id of jobIds) this.logs.delete(id);
		void this.deps.store.rewriteLogs(this.logs);
	}

	/** A throwing listener must not stall the worker. */
	private emit(event: IngestEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// UI errors are not the queue's problem
			}
		}
	}
}
