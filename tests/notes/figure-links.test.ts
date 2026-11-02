import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { App } from 'obsidian';
import { isInside, neutraliseImageLinks, saveFigures } from '../../src/notes/figures';

// A 1×1 PNG: the figure Docling would have written
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

void describe('which image links are figures', () => {
	void test('only files inside the figures folder', () => {
		assert.equal(isInside('/tmp/figs/image_000001_ab.png', '/tmp/figs'), true);
		assert.equal(isInside('/tmp/figs/chunk0/image_000001_ab.png', '/tmp/figs'), true);
		assert.equal(isInside('/tmp/figs/../../etc/passwd', '/tmp/figs'), false);
		assert.equal(isInside('/tmp/figs', '/tmp/figs'), false);
		assert.equal(isInside('/tmp/figs-other/x.png', '/tmp/figs'), false);
		assert.equal(isInside('/home/me/.ssh/id_rsa', '/tmp/figs'), false);
		assert.equal(isInside('relative/x.png', '/tmp/figs'), false);
	});

	void test('every other image link is kept as a plain link, never an embed', () => {
		assert.equal(neutraliseImageLinks('see ![a](/etc/hosts) and ![](https://x.test/p.png?id=1)'), 'see [a](/etc/hosts) and [](https://x.test/p.png?id=1)');
		assert.equal(neutraliseImageLinks('![[vault-embed.png]] stays'), '![[vault-embed.png]] stays');
	});
});

void describe('saving figures', () => {
	void test('copies the extractor’s images and leaves the document’s own links as text', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-figs-'));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-secret-'));
		try {
			await fs.writeFile(path.join(dir, 'image_000001_ab.png'), PNG);
			await fs.writeFile(path.join(dir, 'notes.txt'), 'not an image');
			await fs.writeFile(path.join(outside, 'secret.png'), PNG);
			const markdown = [
				`![Figure](${path.join(dir, 'image_000001_ab.png')})`,
				`![text file in our folder](${path.join(dir, 'notes.txt')})`,
				`![image elsewhere](${path.join(outside, 'secret.png')})`,
				`![traversal](${path.join(dir, '..', path.basename(outside), 'secret.png')})`,
				'![remote](https://tracker.test/p.png)',
				'![encoded](/Users/me/.ssh/id%5Fed25519)',
			].join('\n');
			const { app, written } = fakeApp();
			const result = await saveFigures(app, markdown, 'docs/report.pdf', 'docs/report.md', { location: 'note', group: false }, dir);
			assert.equal(result.count, 1);
			assert.deepEqual([...written.keys()], ['docs/report-figure-1.png']);
			assert.equal(
				result.markdown,
				[
					'![[docs/report-figure-1.png]]',
					`[text file in our folder](${path.join(dir, 'notes.txt')})`,
					`[image elsewhere](${path.join(outside, 'secret.png')})`,
					`[traversal](${path.join(dir, '..', path.basename(outside), 'secret.png')})`,
					'[remote](https://tracker.test/p.png)',
					'[encoded](/Users/me/.ssh/id%5Fed25519)',
				].join('\n'),
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	void test('with no figures folder nothing is read, whatever the links say', async () => {
		const { app, written } = fakeApp();
		const result = await saveFigures(app, '![a](/etc/hosts)', 'docs/a.txt', 'docs/a.md', { location: 'note', group: true }, null);
		assert.equal(result.count, 0);
		assert.equal(result.markdown, '[a](/etc/hosts)');
		assert.equal(written.size, 0);
	});
});

function fakeApp() {
	const written = new Map<string, number>();
	const app = {
		vault: {
			getAbstractFileByPath: () => null,
			createFolder: () => Promise.resolve(),
			createBinary: (p: string, bytes: ArrayBuffer) => {
				written.set(p, bytes.byteLength);
				return Promise.resolve();
			},
		},
		fileManager: { trashFile: () => Promise.resolve() },
	} as unknown as App;
	return { app, written };
}
