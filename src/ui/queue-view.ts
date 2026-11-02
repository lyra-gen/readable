import { ConfirmationModal, ItemView, Menu, Platform, SearchComponent, setIcon } from 'obsidian';
import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type { IngestService } from '../core/ingest-service';
import { jobName } from '../core/types';
import type { Job } from '../core/types';
import type { UiActions } from './actions';
import { devNotice } from './dev-log';
import { openJobLog } from './log-modal';
import { jobTime, relativeTime, sortJobs } from './format';
import { showContextMenu, showMenuForButton } from './menu';
import {
	applyFilter,
	EMPTY_FILTER,
	folderCount,
	isFiltering,
	KIND_FILTERS,
	normalizeFilter,
	rowAfterRemoval,
	rowMenuItems,
	Selection,
	STATE_FILTERS,
	stateLabel,
} from './queue-selection';
import type { QueueFilter, RowAction } from './queue-selection';
import { notify } from './notices';
import { openNote, QUEUE_VIEW_TYPE } from './workspace';

/** Re-render cadence while a job runs (elapsed seconds). */
const TICK_MS = 1000;
/** Idle lists only need relative times refreshed this often. */
const IDLE_REFRESH_MS = 30_000;
/** How long a row takes to slide to its new place when the order changes, and a new row to fade in. */
const ROW_SLIDE_MS = 240;
const ROW_FADE_MS = 180;

/** The colour behind the queue, from the nearest ancestor that paints one; rows are transparent. */
function paneBackground(el: HTMLElement): string {
	for (let node: HTMLElement | null = el; node; node = node.parentElement) {
		const color = getComputedStyle(node).backgroundColor;
		if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
	}
	return 'var(--background-secondary)';
}

const ROW_ICON: Record<RowAction, string> = {
	'open-note': 'file-text',
	'view-log': 'scroll-text',
	pause: 'pause',
	resume: 'play',
	'run-next': 'list-start',
	retry: 'rotate-ccw',
	cancel: 'square',
	exclude: 'circle-off',
	include: 'rotate-ccw',
	remove: 'x',
};

interface Row {
	job: Job;
	item: HTMLElement;
	/** The clickable line; carries is-selected and has-focus, as in the file explorer. */
	self: HTMLElement;
	name: HTMLElement;
	time: HTMLElement;
	state: HTMLElement;
	/** The state classes on `item`, to remove when the state changes. */
	stateClass: string;
	/** The stage line and bar, only while running. */
	running: { stage: HTMLElement; track: HTMLElement; fill: HTMLElement } | null;
}

/** Leaves the DOM alone when nothing changed, so the text does not flicker. */
function setTextIfChanged(el: HTMLElement, text: string): void {
	if (el.textContent !== text) el.setText(text);
}

/** Resolves an absolute path for a dropped File on desktop, if Electron exposes it. */
function droppedFilePath(file: File): string | null {
	if (!Platform.isDesktop) return null;
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		const electron = req?.('electron') as
			| { webUtils?: { getPathForFile: (f: File) => string } }
			| undefined;
		return electron?.webUtils?.getPathForFile(file) ?? null;
	} catch {
		return null;
	}
}

/**
 * The A of Cmd/Ctrl+A. With a non-Latin layout (Russian gives 'ф') only the
 * physical key says so; a Latin layout's own 'a' wins, so AZERTY keeps its A.
 */
function isSelectAllKey(evt: KeyboardEvent): boolean {
	return evt.key.toLowerCase() === 'a' || (evt.code === 'KeyA' && !/^[a-z]$/i.test(evt.key));
}

/** Cmd on macOS, Ctrl elsewhere, as the file explorer reads it. */
function isModKey(evt: MouseEvent | KeyboardEvent): boolean {
	return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
}

/**
 * The queue panel in the right sidebar, drawn as a file explorer folder of
 * jobs. It renders the service snapshot on every change, once a second while a
 * job runs and every half minute when idle (for relative times), updating each
 * job's row in place. Selection, filters and
 * row menus follow the file explorer and are worked out in queue-selection.ts;
 * the filter is kept in the view state. Files dropped from outside the vault
 * are not supported yet.
 */
export class QueueView extends ItemView {
	private listEl!: HTMLElement;
	private autoBtn!: HTMLElement;
	private pauseBtn!: HTMLElement;
	private filterBtn!: HTMLElement;
	private searchBtn!: HTMLElement;
	private searchEl!: HTMLElement;
	private search!: SearchComponent;
	private collapsed = false;
	private unsubscribe: (() => void) | null = null;

	private filter: QueueFilter = { ...EMPTY_FILTER };
	private searchOpen = false;
	private readonly selection = new Selection();
	/** Ids of the rows on screen, in display order: what ranges, arrows and select all cover. */
	private visibleIds: string[] = [];
	/** Row order at the last render; a change means some rows moved and slide to their new place. */
	private shownOrder = '';
	/** The focus ring shows only after arrow keys, as with :focus-visible; a click just selects. */
	private keyboardFocus = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly service: IngestService,
		private readonly actions: UiActions,
	) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return QUEUE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Readable queue';
	}

	getIcon(): string {
		return 'file-input';
	}

	onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('readable-queue');

		this.renderToolbar(root);
		this.renderSearch(root);
		// show-unsupported: the explorer's own rule would otherwise hide rows skipped as unsupported
		this.listEl = root.createDiv({
			cls: 'nav-files-container show-unsupported readable-job-list',
			attr: { tabindex: '0' },
		});
		this.registerListEvents();
		this.registerDropTarget(root);

		this.unsubscribe = this.service.subscribe(() => this.render());
		this.registerInterval(
			window.setInterval(() => {
				const running = this.service.getSnapshot().jobs.some((j) => j.state === 'running');
				// Running rows show elapsed seconds; idle lists only need relative times refreshed
				if (running || Date.now() % IDLE_REFRESH_MS < TICK_MS) this.render();
			}, TICK_MS),
		);
		this.render();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
		return Promise.resolve();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), filter: this.filter };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const saved = (state ?? {}) as { filter?: unknown };
		this.filter = normalizeFilter(saved.filter);
		// The view may get its state before onOpen has built anything
		if (this.searchEl) {
			this.search.setValue(this.filter.text);
			this.setSearchOpen(this.filter.text !== '');
			this.render();
		} else {
			this.searchOpen = this.filter.text !== '';
		}
		await super.setState(state, result);
	}

	/** Called by the plugin when settings change outside this view. */
	refreshSettings(): void {
		this.renderAutoIngest();
	}

	// --- toolbar ---

	private renderToolbar(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'nav-header' });
		const buttons = header.createDiv({ cls: 'nav-buttons-container' });

		this.autoBtn = this.iconButton(buttons, 'zap', 'Auto-ingest');
		this.registerDomEvent(this.autoBtn, 'click', () => {
			this.actions.setAutoIngest(!this.actions.isAutoIngest());
			this.renderAutoIngest();
		});
		this.renderAutoIngest();

		this.pauseBtn = this.iconButton(buttons, 'pause', 'Pause queue');
		this.registerDomEvent(this.pauseBtn, 'click', () => {
			if (this.service.getSnapshot().paused) this.service.resume();
			else this.service.pause();
		});

		const retryBtn = this.iconButton(buttons, 'rotate-ccw', 'Retry all failed');
		this.registerDomEvent(retryBtn, 'click', () => this.service.retryAllFailed());

		this.searchBtn = this.iconButton(buttons, 'search', 'Search file names');
		this.registerDomEvent(this.searchBtn, 'click', () => {
			if (this.searchOpen) {
				this.setFilter({ ...this.filter, text: '' });
				this.setSearchOpen(false);
			} else {
				this.setSearchOpen(true);
				this.search.inputEl.focus();
			}
		});

		this.filterBtn = this.iconButton(buttons, 'list-filter', 'Filter');
		this.registerDomEvent(this.filterBtn, 'click', () => this.showFilterMenu());

		const gearBtn = this.iconButton(buttons, 'settings', 'Readable settings');
		this.registerDomEvent(gearBtn, 'click', () => this.actions.openSettings());
	}

	private renderAutoIngest(): void {
		const on = this.actions.isAutoIngest();
		this.autoBtn.toggleClass('is-active', on);
		setIcon(this.autoBtn, on ? 'zap' : 'zap-off');
		this.autoBtn.setAttr('aria-label', on ? 'Auto-ingest on' : 'Auto-ingest off');
	}

	private renderPause(paused: boolean): void {
		setIcon(this.pauseBtn, paused ? 'play' : 'pause');
		// "queue": the row menu has its own Pause and Resume for single files
		this.pauseBtn.setAttr('aria-label', paused ? 'Resume queue' : 'Pause queue');
	}

	/** Checkable items: values in a group are OR'ed, groups AND'ed, and an empty group shows everything. */
	private showFilterMenu(): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Show all')
				.setChecked(!isFiltering(this.filter))
				.onClick(() => this.showAll()),
		);
		menu.addSeparator();
		for (const { value, label } of STATE_FILTERS) {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(this.filter.states.includes(value))
					.onClick(() => this.setFilter({ ...this.filter, states: toggled(this.filter.states, value) })),
			);
		}
		menu.addSeparator();
		for (const { value, label } of KIND_FILTERS) {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(this.filter.kinds.includes(value))
					.onClick(() => this.setFilter({ ...this.filter, kinds: toggled(this.filter.kinds, value) })),
			);
		}
		showMenuForButton(menu, this.filterBtn);
	}

	/** Clears every filter and closes the search. */
	private showAll(): void {
		this.search.setValue('');
		this.setSearchOpen(false);
		this.setFilter({ ...EMPTY_FILTER, states: [], kinds: [] });
	}

	/** The filter button names what it filters by, since the menu is closed most of the time. */
	private renderFilterButton(filtering: boolean): void {
		this.filterBtn.toggleClass('is-active', filtering);
		const labels = [
			...STATE_FILTERS.filter((s) => this.filter.states.includes(s.value)).map((s) => s.label),
			...KIND_FILTERS.filter((k) => this.filter.kinds.includes(k.value)).map((k) => k.label),
		];
		this.filterBtn.setAttr('aria-label', labels.length > 0 ? `Filter: ${labels.join(', ')}` : 'Filter');
	}

	private setFilter(filter: QueueFilter): void {
		this.filter = filter;
		this.render();
		this.app.workspace.requestSaveLayout();
	}

	// --- search ---

	/** An Obsidian search field under the toolbar, shown by the search button. */
	private renderSearch(root: HTMLElement): void {
		this.searchEl = root.createDiv({ cls: 'readable-queue-search' });
		this.search = new SearchComponent(this.searchEl).setPlaceholder('Search file names');
		this.search.setValue(this.filter.text);
		this.search.onChange((text) => this.setFilter({ ...this.filter, text }));
		this.registerDomEvent(this.search.inputEl, 'keydown', (evt) => {
			if (evt.key === 'Escape') {
				evt.preventDefault();
				evt.stopPropagation();
				this.search.setValue('');
				this.setFilter({ ...this.filter, text: '' });
				this.setSearchOpen(false);
				this.listEl.focus();
			} else if (evt.key === 'ArrowDown' || evt.key === 'Enter') {
				// Into the results, as the file explorer's own search does
				evt.preventDefault();
				this.listEl.focus();
				this.keyboardFocus = true;
				if (this.selection.size === 0) this.selection.move(1, this.visibleIds, false);
				this.renderSelection();
			}
		});
		this.setSearchOpen(this.searchOpen || this.filter.text !== '');
	}

	private setSearchOpen(open: boolean): void {
		this.searchOpen = open;
		this.searchEl.toggleClass('is-hidden', !open);
		this.searchBtn?.toggleClass('is-active', open);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLElement {
		const btn = parent.createDiv({
			cls: 'clickable-icon nav-action-button',
			attr: { 'aria-label': label, 'data-tooltip-position': 'top', tabindex: '0', role: 'button' },
		});
		setIcon(btn, icon);
		return btn;
	}

	// --- list ---

	/**
	 * Rows are kept per job and updated in place: rebuilding the list on
	 * every change restarted the bar's animation whenever any job changed,
	 * and once a second while anything ran.
	 */
	private readonly rows = new Map<string, Row>();
	private folder: {
		el: HTMLElement;
		title: HTMLElement;
		icon: HTMLElement;
		count: HTMLElement;
		children: HTMLElement;
		/** Shown in place of the rows when the filter hides them all. */
		noMatch: HTMLElement;
	} | null = null;

	private render(): void {
		const snapshot = this.service.getSnapshot();
		this.renderPause(snapshot.paused);
		const filtering = isFiltering(this.filter);
		this.renderFilterButton(filtering);
		if (snapshot.jobs.length === 0) {
			if (this.folder || this.rows.size > 0 || this.listEl.childElementCount === 0) {
				this.listEl.empty();
				this.folder = null;
				this.rows.clear();
				this.renderEmptyState(this.listEl);
			}
			this.visibleIds = [];
			this.selection.clear();
			return;
		}
		const folder = this.folder ?? this.createFolder();
		const sorted = sortJobs(snapshot.jobs);
		const shown = new Set(applyFilter(sorted, this.filter).map((j) => j.id));
		setTextIfChanged(folder.count, folderCount(snapshot.jobs, shown.size, filtering));
		folder.noMatch.toggleClass('is-hidden', !filtering || shown.size > 0 || this.collapsed);

		// Where each row was before rows move, so it can slide from there; read only when the order changed
		const order = sorted.map((j) => j.id).join('\n');
		const before = order !== this.shownOrder && this.canAnimate() ? this.rowTops() : null;
		this.shownOrder = order;

		// Filtered-out rows stay in place, hidden, so changing the filter moves nothing
		const seen = new Set<string>();
		let expected = folder.children.firstElementChild;
		for (const job of sorted) {
			seen.add(job.id);
			const row = this.rows.get(job.id) ?? this.createRow(job);
			this.updateRow(row, job);
			row.item.toggleClass('is-hidden', !shown.has(job.id));
			// Only a row out of place is moved: moving a node restarts its animations
			if (row.item !== expected) folder.children.insertBefore(row.item, expected);
			else expected = row.item.nextElementSibling;
		}
		for (const [id, row] of this.rows) {
			if (seen.has(id)) continue;
			row.item.remove();
			this.rows.delete(id);
		}
		if (before) this.slideRows(before);

		this.visibleIds = this.collapsed ? [] : sorted.filter((j) => shown.has(j.id)).map((j) => j.id);
		this.selection.retain(this.visibleIds);
		this.renderSelection();
	}

	/** Rows slide only when someone can see them and neither Readable's settings nor the system ask for less motion. */
	private canAnimate(): boolean {
		if (this.collapsed || !this.containerEl.isShown() || this.actions.reduceMotion()) return false;
		return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	/** Top edge of every visible row, as drawn now (mid-slide rows included, so a second move continues from there). */
	private rowTops(): Map<string, number> {
		const tops = new Map<string, number>();
		for (const [id, row] of this.rows) {
			if (!row.item.hasClass('is-hidden')) tops.set(id, row.item.getBoundingClientRect().top);
		}
		return tops;
	}

	/**
	 * Each row that moved slides from where it was to where it is now; a new
	 * row fades in. Rows are already in their final place, so a slide that is
	 * cut short leaves nothing out of order.
	 */
	private slideRows(before: Map<string, number>): void {
		const moves: { item: HTMLElement; dy: number }[] = [];
		for (const [id, row] of this.rows) {
			if (row.item.hasClass('is-hidden')) continue;
			const was = before.get(id);
			for (const animation of row.item.getAnimations()) animation.cancel();
			if (was === undefined) {
				// Not on the first draw, when every row would be new
				if (before.size > 0) row.item.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ROW_FADE_MS, easing: 'ease-out' });
				continue;
			}
			const dy = was - row.item.getBoundingClientRect().top;
			if (Math.abs(dy) >= 1) moves.push({ item: row.item, dy });
		}
		if (moves.length === 0) return;
		// Rows are see-through, so a sliding row gets the pane's colour and the one going furthest passes over the rest
		this.listEl.style.setProperty('--readable-row-bg', paneBackground(this.listEl));
		const furthest = moves.reduce((a, b) => (Math.abs(b.dy) > Math.abs(a.dy) ? b : a));
		for (const { item, dy } of moves) {
			item.addClass('is-sliding');
			item.toggleClass('is-sliding-over', item === furthest.item);
			const animation = item.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ROW_SLIDE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
			animation.onfinish = () => {
				// A newer slide may have started on this row; it clears the classes when it ends
				if (item.getAnimations().length === 0) item.removeClass('is-sliding', 'is-sliding-over');
			};
		}
	}

	/** Selection classes only; cheap enough to run on every click and key. */
	private renderSelection(): void {
		const focus = this.keyboardFocus ? this.selection.focus : null;
		for (const [id, row] of this.rows) {
			row.self.toggleClass('is-selected', this.selection.has(id));
			row.self.toggleClass('has-focus', id === focus);
		}
	}

	private createFolder(): NonNullable<typeof this.folder> {
		this.listEl.empty();
		this.rows.clear();
		const el = this.listEl.createDiv({ cls: 'tree-item nav-folder' });
		const title = el.createDiv({ cls: 'tree-item-self is-clickable mod-collapsible nav-folder-title' });
		const icon = title.createDiv({ cls: 'tree-item-icon collapse-icon nav-folder-collapse-indicator' });
		setIcon(icon, 'right-triangle');
		title.createDiv({ cls: 'tree-item-inner nav-folder-title-content', text: 'Queue' });
		const count = title.createDiv({ cls: 'nav-file-tag' });
		const children = el.createDiv({ cls: 'tree-item-children nav-folder-children' });
		const noMatch = this.listEl.createDiv({ cls: 'pane-empty is-hidden', text: 'No files match the filter. ' });
		// Plain listener: it goes with the element when the folder is rebuilt
		noMatch.createEl('a', { text: 'Show all', href: '#' }).addEventListener('click', (evt) => {
			evt.preventDefault();
			this.showAll();
		});
		const folder = { el, title, icon, count, children, noMatch };
		this.folder = folder;
		this.applyCollapse();
		return folder;
	}

	private applyCollapse(): void {
		if (!this.folder) return;
		const { el, title, icon, children } = this.folder;
		el.toggleClass('is-collapsed', this.collapsed);
		title.toggleClass('is-collapsed', this.collapsed);
		icon.toggleClass('is-collapsed', this.collapsed);
		children.toggleClass('is-hidden', this.collapsed);
	}

	/** Selects a job's row and scrolls to it, first undoing a collapse, filter or search that hides it. */
	reveal(jobId: string): void {
		if (this.collapsed) {
			this.collapsed = false;
			this.applyCollapse();
		}
		this.render();
		if (!this.visibleIds.includes(jobId)) this.showAll();
		if (!this.visibleIds.includes(jobId)) return;
		this.selection.select(jobId);
		this.renderSelection();
		this.rows.get(jobId)?.self.scrollIntoView({ block: 'center' });
	}

	private toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
		this.applyCollapse();
		// Collapsed rows cannot be seen, so they leave the selection
		this.render();
	}

	private showFolderMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle('Clear finished').setIcon('trash-2').onClick(() => this.service.clearFinished()));
		showContextMenu(menu, evt);
	}

	/** The row's elements once. Its clicks are handled on the list, which finds the row by `data-job-id`. */
	private createRow(job: Job): Row {
		const item = createDiv({ cls: 'tree-item nav-file readable-job', attr: { 'data-job-id': job.id } });
		const self = item.createDiv({ cls: 'tree-item-self is-clickable nav-file-title' });
		const name = self.createDiv({ cls: 'tree-item-inner nav-file-title-content' });
		const time = self.createDiv({ cls: 'readable-job-time', attr: { 'data-tooltip-position': 'top' } });
		const state = self.createDiv({ cls: 'nav-file-tag readable-job-state' });
		const row: Row = { job, item, self, name, time, state, stateClass: '', running: null };
		this.rows.set(job.id, row);
		return row;
	}

	private updateRow(row: Row, job: Job): void {
		row.job = job;
		const stateClass = `is-${job.state}${job.skipReason === 'unsupported-type' ? ' is-unsupported' : ''}`;
		if (stateClass !== row.stateClass) {
			if (row.stateClass) row.item.removeClasses(row.stateClass.split(' '));
			row.item.addClasses(stateClass.split(' '));
			row.stateClass = stateClass;
		}
		setTextIfChanged(row.name, jobName(job));
		setTextIfChanged(row.time, relativeTime(jobTime(job)));
		row.time.setAttr('aria-label', new Date(jobTime(job)).toLocaleString());
		setTextIfChanged(row.state, stateLabel(job, this.service.isPausing(job.id)));

		if (job.state !== 'running') {
			row.running?.stage.remove();
			row.running?.track.remove();
			row.running = null;
			return;
		}
		if (!row.running) {
			const stage = row.item.createDiv({ cls: 'readable-job-stage' });
			const track = row.item.createDiv({ cls: 'readable-progress-track' });
			const fill = track.createDiv({ cls: 'readable-progress-fill' });
			row.running = { stage, track, fill };
		}
		const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
		setTextIfChanged(row.running.stage, [job.stage ?? 'starting', job.detail, `${elapsed} s`].filter(Boolean).join(' · '));
		const { fill } = row.running;
		if (job.progress === undefined) {
			fill.addClass('is-indeterminate');
			fill.style.removeProperty('--readable-progress');
		} else {
			fill.removeClass('is-indeterminate');
			fill.style.setProperty('--readable-progress', `${job.progress}%`);
		}
	}

	/** The menu for a selection: opening first, then each action that applies to any selected job, with a count for several, and Remove last. */
	private showRowMenu(ids: string[], evt: MouseEvent): void {
		const jobs = this.jobsById(ids);
		const menu = new Menu();
		rowMenuItems(jobs, (id) => this.service.isPausing(id)).forEach((group, i) => {
			if (i > 0) menu.addSeparator();
			for (const item of group) {
				menu.addItem((mi) => {
					mi.setTitle(item.label)
						.setIcon(ROW_ICON[item.action])
						.onClick(() => this.runRowAction(item.action, item.ids));
					if (item.action === 'remove') mi.setWarning(true);
				});
			}
		});
		showContextMenu(menu, evt);
	}

	private runRowAction(action: RowAction, ids: string[]): void {
		const svc = this.service;
		const job = this.jobsById(ids)[0];
		switch (action) {
			case 'open-note':
				if (job) this.openJob(job);
				return;
			case 'view-log':
				if (job) this.openLog(job);
				return;
			case 'pause':
				return svc.pauseJobs(ids);
			case 'resume':
				return svc.resumeJobs(ids);
			case 'run-next':
				return svc.runNext(ids);
			case 'retry':
				return svc.retryJobs(ids);
			case 'cancel':
				return svc.cancelJobs(ids);
			case 'exclude':
				return svc.excludeJobs(ids);
			case 'include':
				return svc.includeJobs(ids);
			case 'remove':
				return this.removeJobs(ids);
		}
	}

	/** Removes jobs and selects the row that took their place, so the keyboard carries on from there. */
	private removeJobs(ids: string[]): void {
		const next = rowAfterRemoval(this.visibleIds, ids);
		this.service.removeJobs(ids);
		if (next === null || !this.visibleIds.includes(next)) return;
		this.selection.select(next);
		this.renderSelection();
		if (this.keyboardFocus) this.rows.get(next)?.self.scrollIntoView({ block: 'nearest' });
	}

	/**
	 * Delete from the keyboard asks first when it would take several files or
	 * stop a running one; a stray key should not empty the queue.
	 */
	private confirmRemove(ids: string[]): void {
		const jobs = this.jobsById(ids);
		const running = jobs.filter((j) => j.state === 'running').length;
		if (jobs.length <= 1 && running === 0) {
			this.removeJobs(ids);
			return;
		}
		const modal = new ConfirmationModal(this.app);
		modal.setTitle(jobs.length > 1 ? `Remove ${jobs.length} files from the queue?` : 'Remove this file from the queue?');
		modal.setContent(
			createFragment((frag) => {
				if (running > 0) frag.createEl('p', { text: `${running === 1 ? '1 running file' : `${running} running files`} will be stopped.` });
				frag.createEl('p', { text: 'Their logs are removed too. Notes already written are kept.' });
			}),
		);
		modal.addButton((btn) =>
			btn
				.setButtonText('Remove')
				.setDestructive()
				.setCta()
				.onClick(() => {
					this.removeJobs(ids);
					this.listEl.focus({ preventScroll: true });
				}),
		);
		modal.addCancelButton();
		modal.open();
	}

	/** The current jobs for these ids, in the order given; ids no longer in the queue are dropped. */
	private jobsById(ids: readonly string[]): Job[] {
		const byId = new Map(this.service.getSnapshot().jobs.map((j) => [j.id, j]));
		return ids.map((id) => byId.get(id)).filter((j): j is Job => j !== undefined);
	}

	/** Double-click and Enter: the note for a finished job, the log for anything else. */
	private openJob(job: Job): void {
		if (job.state === 'done') openNote(this.app, job.notePath);
		else this.openLog(job);
	}

	private openLog(job: Job): void {
		openJobLog(this.app, this.service, job);
	}

	// --- keyboard ---

	/** File explorer keys while the list has focus. The list holds no inputs, so no typing is taken over. */
	private registerListEvents(): void {
		this.registerDomEvent(this.listEl, 'keydown', (evt) => {
			if (evt.isComposing || evt.altKey) return;
			const mod = isModKey(evt);
			if (mod && !evt.shiftKey && isSelectAllKey(evt)) {
				this.selection.selectAll(this.visibleIds);
				this.renderSelection();
				evt.preventDefault();
				evt.stopPropagation();
				return;
			}
			switch (evt.key) {
				case 'ArrowDown':
				case 'ArrowUp': {
					if (mod) return;
					const id = this.selection.move(evt.key === 'ArrowDown' ? 1 : -1, this.visibleIds, evt.shiftKey);
					this.keyboardFocus = true;
					this.renderSelection();
					if (id) this.rows.get(id)?.self.scrollIntoView({ block: 'nearest' });
					break;
				}
				case 'Escape':
					// Nothing selected: leave Esc to Obsidian
					if (this.selection.size === 0) return;
					this.selection.clear();
					this.renderSelection();
					break;
				case 'Enter': {
					if (mod || evt.shiftKey) return;
					const id = this.selection.primary(this.visibleIds);
					const job = id ? this.jobsById([id])[0] : undefined;
					if (!job) return;
					this.openJob(job);
					break;
				}
				case 'Delete':
				case 'Backspace': {
					if (mod || evt.shiftKey) return;
					const ids = this.selection.ids(this.visibleIds);
					if (ids.length === 0) return;
					this.confirmRemove(ids);
					break;
				}
				default:
					return;
			}
			evt.preventDefault();
			evt.stopPropagation();
		});
		// One listener each for all rows and the folder, found from the target: rows come and go, and
		// listeners registered on the view would only be released when it closes
		this.registerDomEvent(this.listEl, 'click', (evt) => {
			if (this.folderTitleAt(evt)) {
				this.toggleCollapsed();
				// Keys act on the list from here on, as after a click on a row
				this.listEl.focus({ preventScroll: true });
				return;
			}
			const row = this.rowAt(evt);
			if (!row) {
				// A click on the list's empty space clears the selection, as in the file explorer
				if (evt.target === this.listEl) {
					this.selection.clear();
					this.renderSelection();
				}
				return;
			}
			this.selection.click(row.job.id, this.visibleIds, { range: evt.shiftKey, toggle: isModKey(evt) });
			this.keyboardFocus = false;
			this.renderSelection();
			this.listEl.focus({ preventScroll: true });
		});
		this.registerDomEvent(this.listEl, 'dblclick', (evt) => {
			const row = this.rowAt(evt);
			if (!row || evt.shiftKey || isModKey(evt)) return;
			this.openJob(row.job);
		});
		this.registerDomEvent(this.listEl, 'contextmenu', (evt) => {
			if (this.folderTitleAt(evt)) {
				evt.preventDefault();
				this.showFolderMenu(evt);
				return;
			}
			const row = this.rowAt(evt);
			if (!row) return;
			evt.preventDefault();
			const ids = this.selection.contextTarget(row.job.id, this.visibleIds);
			this.renderSelection();
			this.showRowMenu(ids, evt);
		});
	}

	/** The row under a click on its line (not its stage line or bar), if any. */
	private rowAt(evt: MouseEvent): Row | undefined {
		const target = evt.target instanceof Element ? evt.target : null;
		const self = target?.closest('.readable-job > .nav-file-title');
		const id = self?.parentElement?.getAttr('data-job-id');
		return id ? this.rows.get(id) : undefined;
	}

	private folderTitleAt(evt: MouseEvent): boolean {
		const target = evt.target instanceof Element ? evt.target : null;
		return !!this.folder && !!target && this.folder.title.contains(target);
	}

	// --- empty state and drop target ---

	/** Plain muted text, as Obsidian's own panes show when empty. Dropping works on the whole panel. */
	private renderEmptyState(parent: HTMLElement): void {
		parent.createDiv({ cls: 'pane-empty', text: 'No files in the queue.' });
	}

	/** The whole panel accepts dropped files; an overlay appears while dragging. */
	private registerDropTarget(root: HTMLElement): void {
		root.addClass('readable-drop-target');
		const overlay = root.createDiv({ cls: 'readable-drop-overlay' });
		const iconEl = overlay.createDiv({ cls: 'readable-drop-overlay-icon' });
		setIcon(iconEl, 'upload');
		overlay.createDiv({ text: 'Drop files to ingest' });

		// dragenter/leave fire for every child; count to know when we truly left
		let depth = 0;
		const isFileDrag = (evt: DragEvent) => evt.dataTransfer?.types.includes('Files') ?? false;
		this.registerDomEvent(root, 'dragenter', (evt) => {
			if (!isFileDrag(evt)) return;
			depth += 1;
			root.addClass('is-dragover');
		});
		this.registerDomEvent(root, 'dragover', (evt) => {
			if (!isFileDrag(evt)) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
		});
		this.registerDomEvent(root, 'dragleave', () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) root.removeClass('is-dragover');
		});
		this.registerDomEvent(root, 'drop', (evt) => {
			if (!isFileDrag(evt)) return;
			evt.preventDefault();
			depth = 0;
			root.removeClass('is-dragover');
			this.handleDroppedFiles(Array.from(evt.dataTransfer?.files ?? []));
		});
	}

	/** Files from outside the vault. Copying them in is phase 1 work; for now we log what arrived. */
	private handleDroppedFiles(files: File[]): void {
		for (const file of files) {
			devNotice('Drop', droppedFilePath(file) ?? `${file.name} (${file.size} bytes)`);
		}
		if (files.length > 0) notify('Dropping files from outside the vault is not supported yet.');
	}
}

/** `values` with `value` added, or taken out if it was there. */
function toggled<T>(values: readonly T[], value: T): T[] {
	return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
