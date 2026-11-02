import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CachedMetadata, Plugin } from 'obsidian';
import { TFile } from 'obsidian';
import { registerAttachWatcher } from '../../src/watch/attach-watcher';

void describe('an embedded file that is moved', () => {
	void test('is not queued when Obsidian rewrites the embed', () => {
		const h = harness({ 'notes/a.md': ['docs/x.pdf'] });
		h.rename('docs/x.pdf', 'x.pdf');
		h.changed('notes/a.md', ['x.pdf']);
		assert.deepEqual(h.queued, []);
	});

	void test('is not queued when a stale resolve comes between the move and the rewrite', () => {
		// After a rename Obsidian fires 'resolved' while the note is still cached with the old embed
		const h = harness({ 'docs/x.md': ['docs/x.pdf'] });
		h.rename('docs/x.pdf', 'x.pdf');
		h.resolved();
		h.changed('docs/x.md', ['x.pdf']);
		assert.deepEqual(h.queued, []);
	});

	void test('a note seen for the first time in a resolve is remembered, not queued', () => {
		const h = harness({});
		h.addNote('b.md', ['x.pdf']);
		h.resolved();
		h.changed('b.md', ['x.pdf']);
		assert.deepEqual(h.queued, []);
	});
});

void describe('a newly embedded file', () => {
	void test('is queued', () => {
		const h = harness({ 'notes/a.md': [] });
		h.changed('notes/a.md', ['x.pdf']);
		assert.deepEqual(h.queued, ['x.pdf in notes/a.md']);
	});

	void test('is queued when another note starts embedding a moved file', () => {
		const h = harness({ 'notes/a.md': ['docs/x.pdf'], 'notes/b.md': [] });
		h.rename('docs/x.pdf', 'x.pdf');
		h.changed('notes/b.md', ['x.pdf']);
		assert.deepEqual(h.queued, ['x.pdf in notes/b.md']);
	});

	void test("is not queued from Readable's own note", () => {
		const h = harness({ 'docs/x.md': [] }, (note, file) => note.path === 'docs/x.md' && file.path === 'x.pdf');
		h.changed('docs/x.md', ['x.pdf']);
		assert.deepEqual(h.queued, []);
	});
});

/** Notes and the files each embeds; files keep their TFile object across a rename, as in Obsidian. */
function harness(notes: Record<string, string[]>, isOwnNote: (note: TFile, file: TFile) => boolean = () => false) {
	type Handler = (...args: unknown[]) => void;
	const handlers = new Map<string, Handler[]>();
	const on = (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]);
	const fire = (name: string, ...args: unknown[]) => handlers.get(name)?.forEach((h) => h(...args));
	const files = new Map<string, TFile>();
	const file = (path: string): TFile => {
		const known = files.get(path);
		if (known) return known;
		const name = path.split('/').pop() ?? path;
		const made = Object.assign(new TFile(), { path, name, extension: name.split('.').pop() ?? '' });
		files.set(path, made);
		return made;
	};
	// What the metadata cache holds for each note: the embed text as last parsed
	const cached = new Map(Object.entries(notes));
	const cacheFor = (note: string): CachedMetadata => ({ embeds: (cached.get(note) ?? []).map((link) => ({ link })) }) as unknown as CachedMetadata;
	const queued: string[] = [];
	const plugin = {
		registerEvent: () => {},
		app: {
			workspace: { onLayoutReady: (run: () => void) => run() },
			vault: { getMarkdownFiles: () => [...cached.keys()].map(file), on },
			metadataCache: { on, getFileCache: (f: TFile) => cacheFor(f.path), getFirstLinkpathDest: (link: string) => files.get(link) ?? null },
		},
	} as unknown as Plugin;
	for (const paths of cached.values()) paths.forEach(file);
	registerAttachWatcher(plugin, {
		isEnabled: () => true,
		isExcluded: () => false,
		isOwnNote,
		onAttached: (f, note) => queued.push(`${f.path} in ${note.path}`),
	});
	return {
		queued,
		rename(from: string, to: string) {
			const moved = file(from);
			files.delete(from);
			Object.assign(moved, { path: to, name: to.split('/').pop() });
			files.set(to, moved);
			fire('rename', moved, from);
		},
		addNote(note: string, embeds: string[]) {
			embeds.forEach(file);
			cached.set(note, embeds);
		},
		resolved() {
			fire('resolved');
		},
		changed(note: string, now: string[]) {
			now.forEach(file);
			cached.set(note, now);
			fire('changed', file(note), '', cacheFor(note));
		},
	};
}
