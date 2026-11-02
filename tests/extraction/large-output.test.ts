import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ManagedDocling } from '../../src/extract/docling/managed/manager';
import { extract, managedDocling } from '../support/extraction';

/**
 * A large table, as a real data export: megabytes of Markdown. The text must
 * come back through a file, not as one huge line on the sidecar's stdout,
 * leave no temp file behind, and be read only up to the note size limit.
 */
const ROWS = 30_000;
const COLS = 24;

void describe('large output', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;
	let dir = '';

	before(async () => {
		({ docling, skip } = await managedDocling());
		dir = mkdtempSync(path.join(os.tmpdir(), 'readable-large-'));
	});
	after(() => {
		docling?.dispose();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	void test(`a ${ROWS.toLocaleString('en')}-row CSV`, { timeout: 10 * 60_000 }, async (t) => {
		if (skip) return t.skip(skip);
		const header = Array.from({ length: COLS }, (_, c) => `column_${c}`).join(',');
		const rows = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => (c === 0 ? `row-${r}` : `value ${r * COLS + c}`)).join(','));
		const file = path.join(dir, 'large.csv');
		writeFileSync(file, `${header}\n${rows.join('\n')}\n`);

		const before = readdirSync(docling.paths.tmp).filter((f) => f.startsWith('convert-'));
		const started = Date.now();
		const out = await extract(docling, file);
		const seconds = (Date.now() - started) / 1000;

		assert.equal(out.result.status, 'extracted', out.log.join('\n'));
		assert.ok(out.markdown.length > 5_000_000, `only ${out.markdown.length} characters`);
		assert.ok(out.markdown.includes(`row-${ROWS - 1}`), 'the last row is missing');
		// Compact tables: cells are not padded to line up
		assert.match(out.markdown, /^\| row-0 \| value 1 \|/m);
		const leftovers = readdirSync(docling.paths.tmp).filter((f) => f.startsWith('convert-') && !before.includes(f));
		assert.deepEqual(leftovers, [], 'temp output files left behind');
		t.diagnostic(`${(out.markdown.length / 1e6).toFixed(1)} MB of Markdown in ${seconds.toFixed(1)} s`);
	});

	void test('cut to the note size limit at a row', { timeout: 10 * 60_000 }, async (t) => {
		if (skip) return t.skip(skip);
		const limit = 1024 * 1024;
		const out = await extract(docling, path.join(dir, 'large.csv'), { maxBytes: limit });
		assert.equal(out.result.status, 'extracted', out.log.join('\n'));
		const cut = out.result.status === 'extracted' ? out.result.cut : undefined;
		assert.ok(cut, 'no cut reported');
		assert.ok(cut.keptBytes <= limit && cut.keptBytes > limit - 1024, `kept ${cut.keptBytes}`);
		assert.ok(cut.totalBytes > 5_000_000, `total ${cut.totalBytes}`);
		assert.equal(Buffer.byteLength(out.markdown), cut.keptBytes);
		assert.match(out.markdown.split('\n').at(-1) ?? '', /^\| row-\d+ \|.*\|$/, 'ends on a whole row');
	});

	void test('a second file waits for Docling and says so', { timeout: 10 * 60_000 }, async (t) => {
		if (skip) return t.skip(skip);
		const file = path.join(dir, 'large.csv');
		// The sidecar reads one file at a time: the PDF, sent a second after the CSV, waits for it
		const bigRun = extract(docling, file);
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
		const [big, small] = await Promise.all([bigRun, extract(docling, 'pdf-text-en.pdf')]);
		assert.equal(big.result.status, 'extracted');
		assert.equal(small.result.status, 'extracted');
		assert.ok(small.log.some((l) => /^info: Waited \d+ s for Docling$/.test(l)), small.log.join('\n'));
		assert.ok(!big.log.some((l) => l.includes('Waited')), big.log.join('\n'));
	});
});
