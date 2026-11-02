import type { IngestEvent, JobTrigger, LogEntry, QueueSnapshot } from './types';

/** Everything the UI needs from the ingestion backend; implemented by the persistent queue. */
export interface IngestService {
	getSnapshot(): QueueSnapshot;
	/** Returns an unsubscribe function. */
	subscribe(listener: (event: IngestEvent) => void): () => void;

	/**
	 * Queues vault-relative paths. Paths already pending or running are ignored.
	 * A paused path is resumed when added by hand, and left paused otherwise.
	 * A finished path is queued again; the pipeline skips it when a note for the
	 * same content already exists, and reprocesses it when the file changed.
	 */
	enqueue(sourcePaths: string[], trigger: JobTrigger): void;
	cancel(jobId: string): void;
	retry(jobId: string): void;
	remove(jobId: string): void;

	// Bulk forms for a selection. Each ignores jobs it does not apply to, and saves and notifies once.
	/** Running jobs stop (a PDF keeps its finished pages) and pending ones are held back. */
	pauseJobs(jobIds: readonly string[]): void;
	/** Paused jobs wait again, in their place in the line. */
	resumeJobs(jobIds: readonly string[]): void;
	/** Moves pending and paused jobs, resuming the paused ones, to the front of the line in their current order. */
	runNext(jobIds: readonly string[]): void;
	/** Stops running jobs; they end cancelled. */
	cancelJobs(jobIds: readonly string[]): void;
	/** Failed and cancelled jobs, and skips a setting change can undo, wait again. */
	retryJobs(jobIds: readonly string[]): void;
	/** Drops jobs from the queue; running ones are stopped first. */
	removeJobs(jobIds: readonly string[]): void;
	/**
	 * Don't process: the jobs end excluded (running ones are stopped first), and
	 * nothing queues those files again on its own: not the watched folder's
	 * sweep, not a change to the file, not clearing the queue.
	 */
	excludeJobs(jobIds: readonly string[]): void;
	/** Don't process, by file: files without a job get an excluded one. */
	excludePaths(sourcePaths: readonly string[]): void;
	/** Process again: excluded jobs wait in line. */
	includeJobs(jobIds: readonly string[]): void;
	/** A file was renamed or moved: its jobs follow it, so a paused or excluded file stays so. */
	renamePath(oldPath: string, newPath: string): void;
	/** A running job told to pause that has not stopped yet; it still shows as running until it has. */
	isPausing(jobId: string): boolean;
	retryAllFailed(): void;
	clearFinished(): void;
	/** The whole queue, apart from any job's own pause. */
	pause(): void;
	resume(): void;

	getLog(jobId: string): readonly LogEntry[];
}
