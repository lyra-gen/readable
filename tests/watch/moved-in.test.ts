import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Plugin } from 'obsidian';
import { TFile, TFolder } from 'obsidian';
import { registerVaultWatcher } from '../../src/watch/vault-watcher';

void describe('a file moved into the watched folder', () => {
	void test('is queued', () => {
		const { rename, queued } = watcher();
		rename(file('docs/Recording 1.m4a'), 'Recording 1.m4a');
		assert.deepEqual(queued, ['moved docs/Recording 1.m4a']);
	});

	void test('is not queued when it already has a note', () => {
		const { rename, queued } = watcher({ ingested: ['attachments/talk.m4a'] });
		rename(file('docs/talk.m4a'), 'attachments/talk.m4a');
		assert.deepEqual(queued, []);
	});

	void test('is not queued when moved within the folder, or out of it', () => {
		const { rename, queued } = watcher();
		rename(file('docs/sub/a.pdf'), 'docs/a.pdf');
		rename(file('elsewhere/a.pdf'), 'docs/a.pdf');
		assert.deepEqual(queued, []);
	});

	void test('is not queued when auto-ingest is off or its kind is skipped', () => {
		const off = watcher({ enabled: false });
		off.rename(file('docs/a.m4a'), 'a.m4a');
		const skipped = watcher({ excluded: ['m4a'] });
		skipped.rename(file('docs/a.m4a'), 'a.m4a');
		assert.deepEqual([...off.queued, ...skipped.queued], []);
	});

	void test('a folder whose name only starts like the watched folder is outside it', () => {
		const { rename, queued } = watcher();
		rename(file('docs-old/a.pdf'), 'a.pdf');
		assert.deepEqual(queued, []);
	});
});

function file(path: string): TFile {
	const name = path.split('/').pop() ?? path;
	return Object.assign(new TFile(), { path, name, extension: name.split('.').pop() ?? '' });
}

function folder(path: string, children: TFile[]): TFolder {
	return Object.assign(new TFolder(), { path, children });
}

function watcher(opts: { ingested?: string[]; enabled?: boolean; excluded?: string[] } = {}) {
	type Handler = (...args: unknown[]) => void;
	const handlers = new Map<string, Handler[]>();
	const queued: string[] = [];
	const plugin = {
		register: () => {},
		registerEvent: () => {},
		app: {
			workspace: { onLayoutReady: (run: () => void) => run() },
			vault: {
				getRoot: () => folder('', []),
				getAbstractFileByPath: () => null,
				on: (name: string, handler: Handler) => {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
			},
		},
	} as unknown as Plugin;
	registerVaultWatcher(plugin, {
		isEnabled: () => opts.enabled ?? true,
		watchedFolder: () => 'docs',
		reprocessOnModify: () => false,
		isIngested: (path) => opts.ingested?.includes(path) ?? false,
		isExcluded: (ext) => opts.excluded?.includes(ext) ?? false,
		onFile: (f, why) => queued.push(`${why} ${f.path}`),
		onBackfill: () => {},
	});
	const rename = (f: TFile | TFolder, oldPath: string) => handlers.get('rename')?.forEach((h) => h(f, oldPath));
	return { rename, queued };
}
