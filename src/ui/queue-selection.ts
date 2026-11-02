/**
 * Selection and filters for the queue panel, kept free of Obsidian so they
 * can be tested. Methods take the visible job ids in display order, since a
 * range or an arrow key means "what the user sees", not the queue's order.
 */
import type { Job, SkipReason } from '../core/types';
import { isRetryable, jobName } from '../core/types';
import { type FileKind, kindOfExtension } from '../extract/kinds';
import { queueCounts } from './format';

export interface ClickModifiers {
	/** Shift: select from the anchor to this row. */
	range: boolean;
	/** Cmd on macOS, Ctrl elsewhere: add or remove this row. */
	toggle: boolean;
}

/** Selected rows, plus the anchor ranges grow from and the row the keyboard is on, as in the file explorer. */
export class Selection {
	private selected = new Set<string>();
	private anchorId: string | null = null;
	private focusId: string | null = null;

	get anchor(): string | null {
		return this.anchorId;
	}

	get focus(): string | null {
		return this.focusId;
	}

	get size(): number {
		return this.selected.size;
	}

	has(id: string): boolean {
		return this.selected.has(id);
	}

	/** The selected ids in display order. */
	ids(visible: readonly string[]): string[] {
		return visible.filter((id) => this.selected.has(id));
	}

	click(id: string, visible: readonly string[], { range, toggle }: ClickModifiers): void {
		if (range && this.anchorId !== null && visible.includes(this.anchorId) && visible.includes(id)) {
			const span = between(visible, this.anchorId, id);
			// Shift with Cmd adds the range to what is there, as the file explorer does
			if (!toggle) this.selected.clear();
			for (const v of span) this.selected.add(v);
			this.focusId = id;
			return;
		}
		if (toggle) {
			if (this.selected.has(id)) this.selected.delete(id);
			else this.selected.add(id);
		} else {
			this.selected = new Set([id]);
		}
		this.anchorId = id;
		this.focusId = id;
	}

	/** Arrow keys: move the focus row by `delta`, selecting it, or extending the range from the anchor. Returns the new focus. */
	move(delta: number, visible: readonly string[], extend: boolean): string | null {
		if (visible.length === 0) return null;
		const at = this.focusId === null ? -1 : visible.indexOf(this.focusId);
		const next = at === -1 ? (delta > 0 ? 0 : visible.length - 1) : clamp(at + delta, 0, visible.length - 1);
		const id = visible[next] as string;
		if (extend) {
			if (this.anchorId === null || !visible.includes(this.anchorId)) this.anchorId = at === -1 ? id : (visible[at] as string);
			this.selected = new Set(between(visible, this.anchorId, id));
		} else {
			this.selected = new Set([id]);
			this.anchorId = id;
		}
		this.focusId = id;
		return id;
	}

	selectAll(visible: readonly string[]): void {
		this.selected = new Set(visible);
		if (visible.length === 0) return;
		if (this.anchorId === null || !visible.includes(this.anchorId)) this.anchorId = visible[0] as string;
		if (this.focusId === null || !visible.includes(this.focusId)) this.focusId = this.anchorId;
	}

	/** Makes `id` the only selected row, the anchor and the focus. */
	select(id: string): void {
		this.selected = new Set([id]);
		this.anchorId = id;
		this.focusId = id;
	}

	/** The row Enter opens: the focus row, else the first selected one. */
	primary(visible: readonly string[]): string | null {
		if (this.focusId !== null && visible.includes(this.focusId)) return this.focusId;
		return this.ids(visible)[0] ?? null;
	}

	clear(): void {
		this.selected.clear();
		this.anchorId = null;
		this.focusId = null;
	}

	/** After a filter change or a removal: hidden or gone rows leave the selection. */
	retain(visible: readonly string[]): void {
		const shown = new Set(visible);
		for (const id of this.selected) if (!shown.has(id)) this.selected.delete(id);
		if (this.anchorId !== null && !shown.has(this.anchorId)) this.anchorId = null;
		if (this.focusId !== null && !shown.has(this.focusId)) this.focusId = null;
	}

	/**
	 * Right-click: a selected row acts for the whole selection; any other row
	 * becomes the selection first. Pass `visible` to get the ids in display order.
	 */
	contextTarget(id: string, visible?: readonly string[]): string[] {
		if (this.selected.has(id)) return visible ? this.ids(visible) : [...this.selected];
		this.select(id);
		return [id];
	}
}

/**
 * The row to select once `removed` leave the list: the next one below them,
 * else the nearest above, so the keyboard carries on from there as in the
 * file explorer. Null when nothing is left.
 */
export function rowAfterRemoval(visible: readonly string[], removed: readonly string[]): string | null {
	const gone = new Set(removed);
	const last = visible.reduce((at, id, i) => (gone.has(id) ? i : at), -1);
	if (last === -1) return null;
	const below = visible.slice(last + 1).find((id) => !gone.has(id));
	if (below !== undefined) return below;
	const above = visible.slice(0, last).filter((id) => !gone.has(id));
	return above.at(-1) ?? null;
}

/** The ids from `a` to `b` inclusive, in display order whichever comes first. */
function between(visible: readonly string[], a: string, b: string): string[] {
	const i = visible.indexOf(a);
	const j = visible.indexOf(b);
	return visible.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

// Filters

/** Within a group, any checked value matches; groups must all match; an empty group means all. */
export interface QueueFilter {
	/** Job states, e.g. 'pending', 'paused'. Plain strings so new states need no change here. */
	states: string[];
	kinds: FileKind[];
	/** Part of the file name, any case. */
	text: string;
}

export const EMPTY_FILTER: QueueFilter = { states: [], kinds: [], text: '' };

export const STATE_FILTERS: readonly { value: string; label: string }[] = [
	{ value: 'running', label: 'Running' },
	{ value: 'pending', label: 'Waiting' },
	{ value: 'paused', label: 'Paused' },
	{ value: 'done', label: 'Done' },
	{ value: 'failed', label: 'Failed' },
	{ value: 'cancelled', label: 'Cancelled' },
	{ value: 'skipped', label: 'Skipped' },
	{ value: 'excluded', label: 'Not processed' },
];

export const KIND_FILTERS: readonly { value: FileKind; label: string }[] = [
	{ value: 'document', label: 'Documents' },
	{ value: 'image', label: 'Pictures' },
	{ value: 'audio', label: 'Recordings' },
	{ value: 'video', label: 'Videos' },
	{ value: 'text', label: 'Text' },
];

export function isFiltering(filter: QueueFilter): boolean {
	return filter.states.length > 0 || filter.kinds.length > 0 || filter.text.trim() !== '';
}

/** The kind by file extension; null when the name has none or it is not one we know. */
function kindOfJob(job: Job): FileKind | null {
	const name = jobName(job);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? kindOfExtension(name.slice(dot + 1)) : null;
}

export function matchesFilter(job: Job, filter: QueueFilter): boolean {
	if (filter.states.length > 0 && !filter.states.includes(job.state)) return false;
	if (filter.kinds.length > 0) {
		const kind = kindOfJob(job);
		if (kind === null || !filter.kinds.includes(kind)) return false;
	}
	const text = filter.text.trim().toLowerCase();
	return text === '' || jobName(job).toLowerCase().includes(text);
}

export function applyFilter<T extends Job>(jobs: readonly T[], filter: QueueFilter): T[] {
	return isFiltering(filter) ? jobs.filter((j) => matchesFilter(j, filter)) : [...jobs];
}

const STATE_VALUES = new Set(STATE_FILTERS.map((s) => s.value));
const KIND_VALUES = new Set<string>(KIND_FILTERS.map((k) => k.value));

/** Reads a filter back from saved view state, keeping only values this version knows. */
export function normalizeFilter(raw: unknown): QueueFilter {
	if (typeof raw !== 'object' || raw === null) return { states: [], kinds: [], text: '' };
	const r = raw as Record<string, unknown>;
	const pick = (v: unknown, known: Set<string>): string[] =>
		Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && known.has(x)))] : [];
	return {
		states: pick(r.states, STATE_VALUES),
		kinds: pick(r.kinds, KIND_VALUES) as FileKind[],
		text: typeof r.text === 'string' ? r.text : '',
	};
}

// Row text and menu

const SKIP_LABEL: Record<SkipReason, string> = {
	'unsupported-type': 'unsupported',
	'already-processed': 'up to date',
	disabled: 'off in settings',
	ignored: 'ignored',
};

/** Tag text on the right of a row, in the filter menu's words. Skips say why; a job told to pause says so until it stops. */
export function stateLabel(job: Job, pausing = false): string {
	if (job.state === 'running' && pausing) return 'pausing';
	if (job.state === 'skipped') return (job.skipReason && SKIP_LABEL[job.skipReason]) || 'skipped';
	return STATE_FILTERS.find((s) => s.value === job.state)?.label.toLowerCase() ?? job.state;
}

/** The count on the folder: "12 of 294" while filtering, else finished out of all, paused counting as not finished. */
export function folderCount(jobs: readonly Job[], shown: number, filtering: boolean): string {
	if (filtering) return `${shown} of ${jobs.length}`;
	const { finished, total } = queueCounts(jobs);
	return `${finished}/${total}`;
}

export type RowAction = 'open-note' | 'view-log' | 'pause' | 'resume' | 'run-next' | 'retry' | 'cancel' | 'exclude' | 'include' | 'remove';

export interface RowMenuItem {
	action: RowAction;
	label: string;
	/** The selected jobs it acts on, in the order given. */
	ids: string[];
}

/** "Pause" for one file, "Pause 5 files" for several. */
const counted =
	(verb: string, after = '') =>
	(n: number): string =>
		n > 1 ? `${verb} ${n} files${after}` : `${verb}${after}`;

/** Bulk actions: each shows when it applies to any selected job, and runs on those it applies to. */
const BULK: readonly { action: RowAction; label: (n: number) => string; applies: (job: Job, pausing: boolean) => boolean }[] = [
	{ action: 'pause', label: counted('Pause'), applies: (j, pausing) => j.state === 'pending' || (j.state === 'running' && !pausing) },
	// A job still stopping from a pause can be resumed; it goes back in line
	{ action: 'resume', label: counted('Resume'), applies: (j, pausing) => j.state === 'paused' || (j.state === 'running' && pausing) },
	{ action: 'run-next', label: (n) => (n > 1 ? `Run ${n} files next` : 'Run next'), applies: (j) => j.state === 'pending' || j.state === 'paused' },
	{ action: 'retry', label: counted('Retry'), applies: isRetryable },
	{ action: 'cancel', label: counted('Cancel'), applies: (j) => j.state === 'running' },
	{ action: 'exclude', label: counted("Don't process"), applies: (j) => j.state !== 'excluded' },
	{ action: 'include', label: counted('Process', ' again'), applies: (j) => j.state === 'excluded' },
];

/**
 * The right-click menu for a selection, as groups to separate: opening a
 * single job, the bulk actions, then removal last. Remove covers every
 * job; running ones are stopped first, as the queue does for any removal.
 */
export function rowMenuItems(jobs: readonly Job[], isPausing: (id: string) => boolean): RowMenuItem[][] {
	const single = jobs.length === 1 ? jobs[0] : undefined;
	const open: RowMenuItem[] = [];
	if (single?.state === 'done') open.push({ action: 'open-note', label: 'Open note', ids: [single.id] });
	if (single) open.push({ action: 'view-log', label: 'View log', ids: [single.id] });
	const bulk: RowMenuItem[] = [];
	for (const { action, label, applies } of BULK) {
		const ids = jobs.filter((j) => applies(j, isPausing(j.id))).map((j) => j.id);
		if (ids.length > 0) bulk.push({ action, label: label(ids.length), ids });
	}
	const remove: RowMenuItem[] =
		jobs.length > 0 ? [{ action: 'remove', label: counted('Remove', ' from queue')(jobs.length), ids: jobs.map((j) => j.id) }] : [];
	return [open, bulk, remove].filter((group) => group.length > 0);
}
