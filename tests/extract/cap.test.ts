import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { capText, formatSize, readCapped } from '../../src/extract/cap';

const bytes = (s: string) => Buffer.byteLength(s);

void describe('note size limit', () => {
	void test('text that fits is kept whole', () => {
		assert.deepEqual(capText('one\ntwo\n', 100), { text: 'one\ntwo\n' });
		assert.deepEqual(capText('ёжик', bytes('ёжик')), { text: 'ёжик' });
	});

	void test('cut at the last line break that fits', () => {
		const { text, cut } = capText('| a | 1 |\n| b | 2 |\n| c | 3 |\n', 25);
		assert.equal(text, '| a | 1 |\n| b | 2 |');
		assert.deepEqual(cut, { keptBytes: 19, totalBytes: 30 });
	});

	void test('Russian text is measured in bytes and never split mid-letter', () => {
		const line = 'Квартальный отчёт';
		const source = `${line}\n${line}\n${line}\n`;
		const { text, cut } = capText(source, bytes(line) * 2 + 5);
		assert.equal(text, `${line}\n${line}`);
		assert.equal(cut?.keptBytes, bytes(text));
		assert.equal(cut?.totalBytes, bytes(source));
	});

	void test('a single line longer than the limit keeps nothing rather than half a line', () => {
		assert.deepEqual(capText('x'.repeat(50), 10), { text: '', cut: { keptBytes: 0, totalBytes: 50 } });
	});

	void test('a file is read only up to the limit', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'readable-cap-'));
		try {
			const file = path.join(dir, 'out.md');
			const rows = Array.from({ length: 1000 }, (_, i) => `| строка ${i} | ${i} |`).join('\n');
			writeFileSync(file, rows);
			const small = await readCapped(file, 1_000_000);
			assert.equal(small.text, rows);
			assert.equal(small.cut, undefined);
			const { text, cut } = await readCapped(file, 4096);
			assert.ok(cut && cut.keptBytes <= 4096 && cut.totalBytes === bytes(rows));
			assert.ok(rows.startsWith(`${text}\n`), 'kept whole rows from the start');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	void test('sizes read naturally', () => {
		assert.equal(formatSize(5 * 1024 * 1024), '5 MB');
		assert.equal(formatSize(465_000_000), '443 MB');
		assert.equal(formatSize(1.5 * 1024 * 1024), '1.5 MB');
		assert.equal(formatSize(300 * 1024), '300 KB');
	});
});
