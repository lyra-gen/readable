import { isActive, isQueued } from '../core/types';
import type { Job, JobState } from '../core/types';

/**
 * One reading of the queue for the status bar and the folder count: paused
 * jobs are neither finished nor being processed, they wait for the user.
 */
export function queueCounts(jobs: readonly Job[]): { queued: number; paused: number; finished: number; total: number } {
	const queued = jobs.filter(isQueued).length;
	const paused = jobs.filter((j) => j.state === 'paused').length;
	return { queued, paused, finished: jobs.filter((j) => !isActive(j)).length, total: jobs.length };
}

/** Running first, then waiting, then paused, then finished newest-first, then the files not to process. */
const STATE_ORDER: Record<JobState, number> = { running: 0, pending: 1, paused: 2, failed: 3, cancelled: 4, skipped: 5, done: 6, excluded: 7 };

export function sortJobs(jobs: readonly Job[]): Job[] {
	return [...jobs].sort((a, b) => {
		const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
		if (byState !== 0) return byState;
		// Waiting and paused jobs keep queue order, the order they run in (sort is stable); most recent first for finished ones
		if (a.state === 'pending' || a.state === 'paused') return 0;
		return (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
	});
}

/** "just now", "3 min ago", "2 h ago", "yesterday", or a short date. */
export function relativeTime(ts: number, now = Date.now()): string {
	const sec = Math.round((now - ts) / 1000);
	if (sec < 45) return 'just now';
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} min ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr} h ago`;
	const day = Math.round(hr / 24);
	if (day === 1) return 'yesterday';
	if (day < 7) return `${day} days ago`;
	return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The timestamp that best describes where a job is now. */
export function jobTime(job: Job): number {
	return job.finishedAt ?? job.startedAt ?? job.createdAt;
}
