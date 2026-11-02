import { setIcon } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { Job } from '../core/types';

/** A file's mark in the file explorer: its icon, its tooltip, and an extra class for colour. */
export interface Mark {
	icon: string;
	label: string;
	cls?: string;
}

const DONE: Mark = { icon: 'check', label: 'Ingested by Readable' };

const SKIP_REASONS: Record<string, string> = {
	'unsupported-type': 'not a file Readable reads',
	disabled: 'this kind of file is set to Skip',
	ignored: 'its extension is on the ignore list',
};

/**
 * What a file shows. Its newest queue job wins while it says something the
 * note cannot: waiting, running, paused, failed, cancelled, skipped. A file
 * changed after ingesting and failing on the re-run shows the failure, not
 * the old tick. Otherwise a note (or this session's inline output) is a tick.
 */
export function markFor(job: Job | undefined, ingested: boolean): Mark | null {
	switch (job?.state) {
		case 'pending':
			return { icon: 'clock', label: 'Waiting in the Readable queue' };
		case 'running':
			return { icon: 'loader', label: 'Readable is processing this file' };
		case 'paused':
			return { icon: 'pause', label: 'Paused in the Readable queue' };
		case 'failed':
			return { icon: 'x', label: job.error ? `Failed: ${job.error}` : 'Failed', cls: 'is-failed' };
		case 'cancelled':
			return { icon: 'circle-slash', label: 'Cancelled in the Readable queue' };
		case 'excluded':
			return { icon: 'circle-off', label: "Not processed: Readable leaves this file alone" };
		case 'skipped': {
			const reason = job.skipReason ? SKIP_REASONS[job.skipReason] : undefined;
			if (reason) return { icon: 'circle-minus', label: `Skipped: ${reason}` };
			break;
		}
	}
	return ingested || job?.state === 'done' ? DONE : null;
}

/** The newest job for each file. */
export function latestJobs(jobs: readonly Job[]): Map<string, Job> {
	const latest = new Map<string, Job>();
	for (const job of jobs) {
		const seen = latest.get(job.sourcePath);
		if (!seen || job.createdAt >= seen.createdAt) latest.set(job.sourcePath, job);
	}
	return latest;
}

const markKey = (mark: Mark | null) => (mark ? `${mark.icon}|${mark.label}|${mark.cls ?? ''}` : '');

/**
 * Marks files in the file explorer: a tick once ingested (from the notes, so
 * it survives restarts), and the queue state while a file waits, runs, is
 * paused, failed, cancelled or skipped.
 */
export class ExplorerBadges {
	/** Files with output but no note of their own (inline callouts), this session. */
	private readonly paths = new Set<string>();
	private jobs = new Map<string, Job>();
	/** Each file's mark as last computed from the queue, to skip redraws when nothing changed. */
	private jobMarks = new Map<string, string>();
	private enabled = true;
	private observer: MutationObserver | null = null;
	private observed: HTMLElement | null = null;
	private applyTimer: number | null = null;

	constructor(
		private readonly plugin: Plugin,
		private readonly isIngested: (path: string) => boolean,
	) {
		plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.apply()));
		plugin.app.workspace.onLayoutReady(() => this.apply());
		plugin.register(() => this.observer?.disconnect());
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.apply();
	}

	mark(path: string): void {
		this.paths.add(path);
		this.apply();
	}

	clear(): void {
		this.paths.clear();
		this.apply();
	}

	/**
	 * The queue changed. It changes on every progress step, so the explorer is
	 * redrawn only when some file's mark is different.
	 */
	setJobs(jobs: readonly Job[]): void {
		this.jobs = latestJobs(jobs);
		const marks = new Map<string, string>();
		for (const [path, job] of this.jobs) marks.set(path, markKey(markFor(job, false)));
		const changed = marks.size !== this.jobMarks.size || [...marks].some(([path, key]) => this.jobMarks.get(path) !== key);
		this.jobMarks = marks;
		if (changed) this.apply();
	}

	apply(): void {
		const explorer = this.plugin.app.workspace.getLeavesOfType('file-explorer')[0]?.view;
		if (!explorer) return;
		this.observe(explorer.containerEl);
		const titles = explorer.containerEl.querySelectorAll<HTMLElement>('.nav-file-title[data-path]');
		titles.forEach((el) => {
			const path = el.dataset.path ?? '';
			const existing = el.querySelector<HTMLElement>('.readable-badge');
			const mark = this.enabled ? markFor(this.jobs.get(path), this.paths.has(path) || this.isIngested(path)) : null;
			const key = markKey(mark);
			if (existing?.dataset.mark === key) return;
			existing?.remove();
			if (!mark) return;
			const badge = el.createSpan({
				cls: ['nav-file-tag', 'readable-badge', ...(mark.cls ? [mark.cls] : [])],
				attr: { 'aria-label': mark.label, 'data-tooltip-position': 'top', 'data-mark': key },
			});
			setIcon(badge, mark.icon);
		});
	}

	/**
	 * Expanding a folder creates its rows without a layout event, so watch the
	 * explorer's DOM and mark new rows as they appear. Our own edits trigger
	 * the observer too; the debounce makes that a single no-op pass.
	 */
	private observe(container: HTMLElement): void {
		if (this.observed === container) return;
		this.observer?.disconnect();
		this.observed = container;
		this.observer = new MutationObserver((mutations) => {
			if (!mutations.some((m) => m.addedNodes.length > 0)) return;
			if (this.applyTimer !== null) return;
			this.applyTimer = window.setTimeout(() => {
				this.applyTimer = null;
				this.apply();
			}, 50);
		});
		this.observer.observe(container, { childList: true, subtree: true });
	}
}
