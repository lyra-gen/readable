/**
 * Old binary Office files (.doc, .dot, .xls, .xlt, .ppt, .pot, .pps) through
 * the real job path: with this machine's LibreOffice, every one of them; and
 * as if there were none, .doc and .dot through macOS textutil while the rest
 * fail saying LibreOffice is needed. Needs the managed install; the
 * LibreOffice half also needs LibreOffice. Fixtures from scripts/make-fixtures.sh.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import content from '../fixtures/content.json';
import type { ManagedDocling } from '../../src/extract/docling/managed/manager';
import { findLibreOffice } from '../../src/extract/docling/managed/legacy-office';
import { cyrillicShare, extract, found, managedDocling } from '../support/extraction';

const CFB = 'application/x-cfb';
const TIMEOUT_MS = 10 * 60_000;

interface Case {
	file: string;
	lang: keyof typeof content;
	word: boolean;
}

const CASES: Case[] = [
	{ file: 'doc-en.doc', lang: 'en', word: true },
	{ file: 'doc-ru.doc', lang: 'ru', word: true },
	{ file: 'doc-en.dot', lang: 'en', word: true },
	{ file: 'sheet-en.xls', lang: 'en', word: false },
	{ file: 'sheet-ru.xls', lang: 'ru', word: false },
	{ file: 'sheet-en.xlt', lang: 'en', word: false },
	{ file: 'slides-en.ppt', lang: 'en', word: false },
	{ file: 'slides-ru.ppt', lang: 'ru', word: false },
	{ file: 'slides-en.pot', lang: 'en', word: false },
	{ file: 'slides-en.pps', lang: 'en', word: false },
];

function checkText(markdown: string, text: string, c: Case, detail: () => string): void {
	const lang = content[c.lang];
	const hits = found(text, lang.keywords);
	assert.ok(hits.length >= 5, `found ${hits.length}/${lang.keywords.length} keywords (${hits.join(', ')})${detail()}`);
	const share = cyrillicShare(markdown);
	if (c.lang === 'ru') assert.ok(share > 0.6, `Cyrillic share ${share.toFixed(2)}${detail()}`);
	else assert.ok(share < 0.02, `Cyrillic share ${share.toFixed(2)}${detail()}`);
	const cells = found(text, lang.tableKeywords);
	assert.equal(cells.length, lang.tableKeywords.length, `table cells ${cells.join(', ')}${detail()}`);
}

void describe('old Office files with LibreOffice', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;
	before(async () => {
		({ docling, skip } = await managedDocling());
		if (!skip && !(await findLibreOffice())) skip = 'LibreOffice is not installed on this machine';
	});
	after(() => docling?.dispose());

	for (const c of CASES) {
		void test(c.file, { timeout: TIMEOUT_MS }, async (t) => {
			if (skip) return t.skip(skip);
			const out = await extract(docling, c.file);
			const detail = () => `\n--- ${c.file} ---\n${out.markdown}\n--- log ---\n${out.log.join('\n')}`;
			assert.equal(out.mime, CFB, `detected type${detail()}`);
			assert.equal(out.result.status, 'extracted', `status${detail()}`);
			assert.ok(out.log.some((l) => l.includes('LibreOffice converts it')), `LibreOffice route${detail()}`);
			checkText(out.markdown, out.text, c, detail);
		});
	}
});

void describe('old Office files without LibreOffice', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;
	before(async () => {
		({ docling, skip } = await managedDocling({ findLibreOffice: () => Promise.resolve(null) }));
	});
	after(() => docling?.dispose());

	for (const c of CASES) {
		void test(c.file, { timeout: TIMEOUT_MS }, async (t) => {
			if (skip) return t.skip(skip);
			const out = await extract(docling, c.file);
			const detail = () => `\n--- ${c.file} ---\n${out.markdown}\n--- log ---\n${out.log.join('\n')}`;
			if (c.word && process.platform === 'darwin') {
				assert.equal(out.result.status, 'extracted', `status${detail()}`);
				assert.ok(out.log.some((l) => l.includes('textutil')), `textutil route${detail()}`);
				checkText(out.markdown, out.text, c, detail);
				return;
			}
			assert.equal(out.result.status, 'failed', `status${detail()}`);
			if (out.result.status !== 'failed') return;
			assert.equal(out.result.code, 'legacy-office');
			assert.match(out.result.message, /LibreOffice/);
		});
	}
});

void describe('old Word files through textutil, with pictures on', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;
	before(async () => {
		if (process.platform !== 'darwin') {
			skip = 'textutil is macOS only';
			return;
		}
		// Pictures saved, as Readable's default: the log must say they were left out
		({ docling, skip } = await managedDocling({ findLibreOffice: () => Promise.resolve(null) }, { figures: true }));
	});
	after(() => docling?.dispose());

	void test('warns that pictures need LibreOffice', { timeout: TIMEOUT_MS }, async (t) => {
		if (skip) return t.skip(skip);
		const out = await extract(docling, 'doc-en.doc');
		assert.equal(out.result.status, 'extracted');
		assert.ok(out.log.some((l) => l.startsWith('warn: Pictures in old Word files need LibreOffice')), out.log.join('\n'));
	});
});
