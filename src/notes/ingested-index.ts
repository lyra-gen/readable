import { TFile } from 'obsidian';
import type { App, CachedMetadata, Plugin } from 'obsidian';

/**
 * Which source files have a Readable note, read from the notes themselves.
 * The notes are the record: a file is ingested when a note's frontmatter has
 * `source: <its path>` and a `hash` starting `sha256:`, and nothing else (the
 * queue, a database, a cache file) records it, so delete a note and its file is
 * no longer ingested. Only notes with both keys count. The index lives in memory,
 * is rebuilt from Obsidian's metadata cache and kept current by its events, and
 * never writes. Several notes can cover one source after a name clash. The cache
 * lags a fresh write, so the writer's dedupe reads candidate files itself when the
 * index knows no note; isNoteFor falls back to the note's cached frontmatter when
 * the index has not seen it yet. Inline output leaves no frontmatter, so it is not
 * indexed here. Used for explorer marks, the watcher's backfill, "Open Readable
 * note", dedupe, rename follow-up, the AI commands and telling Readable's notes
 * from host notes.
 */
export class IngestedIndex {
	/** source path → notes that cover it. */
	private readonly bySource = new Map<string, Set<string>>();
	/** note path → what it covers; for updates, deletes and the hash check. */
	private readonly byNote = new Map<string, Covered>();
	private readonly listeners = new Set<() => void>();
	/**
	 * Old source path → where the file went. After a move, a note's `source`
	 * names the old path until the rename follow-up rewrites it, and the
	 * metadata cache can be re-read in that window; this keeps the note on the
	 * new path meanwhile. One entry per move in this session.
	 */
	private readonly moved = new Map<string, string>();
	private readonly app: App;

	constructor(plugin: Plugin) {
		this.app = plugin.app;
		const cache = this.app.metadataCache;
		// 'resolved' fires once the cache has read every note after startup, and again after bulk changes.
		// It has already fired when the plugin is enabled later, so also build once the layout is ready.
		plugin.registerEvent(cache.on('resolved', () => this.rebuild()));
		this.app.workspace.onLayoutReady(() => this.rebuild());
		plugin.registerEvent(cache.on('changed', (file, _data, meta) => this.update(file.path, meta)));
		plugin.registerEvent(cache.on('deleted', (file) => this.update(file.path, null)));
		// A different file now lives at an old path; notes naming it mean that file
		plugin.registerEvent(this.app.vault.on('create', (file) => this.moved.delete(file.path)));
		plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.extension !== 'md') {
					this.retarget(oldPath, file.path);
					return;
				}
				// The cache may not have the moved note yet (a folder move); what it covered has not changed
				const covered = this.byNote.get(oldPath);
				this.update(oldPath, null);
				const meta = cache.getFileCache(file);
				if (meta) this.update(file.path, meta);
				else if (covered) {
					this.add(file.path, covered);
					this.emit();
				}
			}),
		);
	}

	/**
	 * Whether this note is Readable's note for the source: by the index,
	 * which follows moves at once, or by its frontmatter when the index has
	 * not seen the note yet (written moments ago).
	 */
	isNoteFor(note: TFile, sourcePath: string): boolean {
		const covered = this.byNote.get(note.path);
		if (covered) return covered.source === sourcePath;
		const source: unknown = this.app.metadataCache.getFileCache(note)?.frontmatter?.source;
		return typeof source === 'string' && this.current(source) === sourcePath;
	}

	has(sourcePath: string): boolean {
		return this.bySource.has(sourcePath);
	}

	/** Every Readable note, by vault path. */
	allNotes(): string[] {
		return [...this.byNote.keys()];
	}

	/** Notes covering this source, if any. */
	notesFor(sourcePath: string): readonly string[] {
		return [...(this.bySource.get(sourcePath) ?? [])];
	}

	/** A note for this source already holds this exact content hash. */
	isCurrent(sourcePath: string, hash: string): boolean {
		for (const note of this.bySource.get(sourcePath) ?? []) {
			if (this.byNote.get(note)?.hash === hash) return true;
		}
		return false;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private rebuild(): void {
		this.bySource.clear();
		this.byNote.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const covered = this.coveredBy(this.app.metadataCache.getFileCache(file));
			if (covered) this.add(file.path, covered);
		}
		this.emit();
	}

	private update(notePath: string, meta: CachedMetadata | null): void {
		const before = this.byNote.get(notePath);
		const after = this.coveredBy(meta);
		if (before?.source === after?.source && before?.hash === after?.hash) return;
		if (before) this.remove(notePath, before.source);
		if (after) this.add(notePath, after);
		this.emit();
	}

	/** A source moved: its notes cover the new path from now on, whatever their frontmatter still says. */
	private retarget(oldSource: string, newSource: string): void {
		// A → B then B → C: notes naming A mean C
		for (const [from, to] of this.moved) if (to === oldSource) this.moved.set(from, newSource);
		this.moved.set(oldSource, newSource);
		this.moved.delete(newSource);
		const notes = this.bySource.get(oldSource);
		if (!notes) return;
		this.bySource.delete(oldSource);
		const target = this.bySource.get(newSource) ?? new Set<string>();
		for (const note of notes) {
			const covered = this.byNote.get(note);
			if (covered) this.byNote.set(note, { ...covered, source: newSource });
			target.add(note);
		}
		this.bySource.set(newSource, target);
		this.emit();
	}

	/** Where a source named in frontmatter is now: itself, or where it moved while nothing took its place. */
	private current(source: string): string {
		const to = this.moved.get(source);
		return to !== undefined && !this.app.vault.getAbstractFileByPath(source) ? to : source;
	}

	/** What this frontmatter covers when it is a Readable note's, else null. */
	private coveredBy(meta: CachedMetadata | null | undefined): Covered | null {
		const covered = coveredBy(meta);
		return covered ? { ...covered, source: this.current(covered.source) } : null;
	}

	private add(notePath: string, covered: Covered): void {
		this.byNote.set(notePath, covered);
		const notes = this.bySource.get(covered.source) ?? new Set<string>();
		notes.add(notePath);
		this.bySource.set(covered.source, notes);
	}

	private remove(notePath: string, source: string): void {
		this.byNote.delete(notePath);
		const notes = this.bySource.get(source);
		if (!notes) return;
		notes.delete(notePath);
		if (notes.size === 0) this.bySource.delete(source);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

interface Covered {
	source: string;
	/** Bare hex, without the `sha256:` prefix. */
	hash: string;
}

/** What this frontmatter covers when it is a Readable note's, else null. */
function coveredBy(meta: CachedMetadata | null | undefined): Covered | null {
	const fm = meta?.frontmatter;
	if (!fm) return null;
	const source: unknown = fm.source;
	const hash: unknown = fm.hash;
	if (typeof source !== 'string' || source === '') return null;
	if (typeof hash !== 'string' || !hash.startsWith('sha256:')) return null;
	return { source, hash: hash.slice('sha256:'.length) };
}
