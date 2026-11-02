import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CachedMetadata, Plugin } from 'obsidian';
import { TFile } from 'obsidian';
import { IngestedIndex } from '../../src/notes/ingested-index';

void describe('the ingested index when files move', () => {
	void test('a moved source is covered by its note at the new path at once', () => {
		const h = harness({ 'docs/x.md': { source: 'docs/x.pdf', hash: 'sha256:abc' } });
		h.rename('docs/x.pdf', 'x.pdf');
		assert.equal(h.index.has('docs/x.pdf'), false);
		assert.deepEqual(h.index.notesFor('x.pdf'), ['docs/x.md']);
		assert.equal(h.index.isCurrent('x.pdf', 'abc'), true);
	});

	void test('a note moved before the cache has read it keeps covering its source', () => {
		const h = harness({ 'docs/t/x.md': { source: 'docs/t/x.pdf', hash: 'sha256:abc' } });
		h.renameNote('docs/t/x.md', 't/x.md', null);
		assert.deepEqual(h.index.notesFor('docs/t/x.pdf'), ['t/x.md']);
	});

	void test('a note moved and re-read follows the cache', () => {
		const h = harness({ 'a.md': { source: 'a.pdf', hash: 'sha256:abc' } });
		h.renameNote('a.md', 'b/a.md', { source: 'a.pdf', hash: 'sha256:abc' });
		assert.deepEqual(h.index.notesFor('a.pdf'), ['b/a.md']);
	});
});

type Fm = { source: string; hash: string } | null;

function harness(notes: Record<string, Fm>) {
	type Handler = (...args: unknown[]) => void;
	const handlers = new Map<string, Handler[]>();
	const on = (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]);
	const fm = new Map(Object.entries(notes));
	const existing = new Set<string>();
	const file = (path: string): TFile => Object.assign(new TFile(), { path, name: path.split('/').pop(), extension: path.split('.').pop() });
	const meta = (f: Fm): CachedMetadata | null => (f ? ({ frontmatter: f }) : null);
	const plugin = {
		registerEvent: () => {},
		app: {
			workspace: { onLayoutReady: (run: () => void) => run() },
			vault: { getMarkdownFiles: () => [...fm.keys()].map(file), getAbstractFileByPath: (p: string) => (existing.has(p) ? file(p) : null), on },
			metadataCache: { on, getFileCache: (f: TFile) => meta(fm.get(f.path) ?? null) },
		},
	} as unknown as Plugin;
	const index = new IngestedIndex(plugin);
	const fire = (name: string, ...args: unknown[]) => handlers.get(name)?.forEach((h) => h(...args));
	return {
		index,
		note: file,
		resolved() {
			fire('resolved');
		},
		changed(note: string, cached: Fm) {
			fm.set(note, cached);
			fire('changed', file(note), '', meta(cached));
		},
		created(path: string) {
			existing.add(path);
			fire('create', file(path));
		},
		rename(from: string, to: string) {
			handlers.get('rename')?.forEach((h) => h(file(to), from));
		},
		renameNote(from: string, to: string, cached: Fm) {
			fm.delete(from);
			if (cached) fm.set(to, cached);
			handlers.get('rename')?.forEach((h) => h(file(to), from));
		},
	};
}

void describe('the ingested index before the note is rewritten', () => {
	void test('a resolve with the stale source keeps the note on the new path', () => {
		const h = harness({ 'docs/x.md': { source: 'docs/x.pdf', hash: 'sha256:abc' } });
		h.rename('docs/x.pdf', 'x.pdf');
		h.resolved();
		assert.deepEqual(h.index.notesFor('x.pdf'), ['docs/x.md']);
		assert.equal(h.index.has('docs/x.pdf'), false);
	});

	void test('a change with the stale source keeps the note on the new path', () => {
		const h = harness({ 'docs/x.md': { source: 'docs/x.pdf', hash: 'sha256:abc' } });
		h.rename('docs/x.pdf', 'x.pdf');
		h.changed('docs/x.md', { source: 'docs/x.pdf', hash: 'sha256:abc' });
		assert.deepEqual(h.index.notesFor('x.pdf'), ['docs/x.md']);
	});

	void test('the note is the own note of the moved file at once', () => {
		const h = harness({ 'docs/x.md': { source: 'docs/x.pdf', hash: 'sha256:abc' } });
		h.rename('docs/x.pdf', 'x.pdf');
		assert.equal(h.index.isNoteFor(h.note('docs/x.md'), 'x.pdf'), true);
		assert.equal(h.index.isNoteFor(h.note('docs/x.md'), 'docs/x.pdf'), false);
	});

	void test('moves A → B → C resolve to C', () => {
		const h = harness({ 'n.md': { source: 'a.pdf', hash: 'sha256:abc' } });
		h.rename('a.pdf', 'b.pdf');
		h.rename('b.pdf', 'c.pdf');
		h.resolved();
		assert.deepEqual(h.index.notesFor('c.pdf'), ['n.md']);
	});

	void test('a file created at the old path takes the old name back', () => {
		const h = harness({ 'n.md': { source: 'a.pdf', hash: 'sha256:abc' } });
		h.rename('a.pdf', 'b.pdf');
		h.created('a.pdf');
		h.resolved();
		assert.deepEqual(h.index.notesFor('a.pdf'), ['n.md']);
	});
});
