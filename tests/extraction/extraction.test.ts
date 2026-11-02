/**
 * Every kind of file Readable reads, in English and Russian, through the
 * real path a job takes: type detection, the extractor registry, managed
 * Docling (or the text reader for plain text). Needs the managed install
 * on this machine; speech cases also need the speech add-on. Fixtures come
 * from scripts/make-fixtures.sh and tests/fixtures/content.json.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import content from '../fixtures/content.json';
import type { ManagedDocling } from '../../src/extract/docling/managed/manager';
import { cyrillicShare, extract, found, managedDocling } from '../support/extraction';
import type { Extracted } from '../support/extraction';

type Lang = keyof typeof content;

interface Case {
	file: string;
	lang: Lang;
	/** Expected detected MIME type. */
	mime: string;
	engine: 'docling' | 'text';
	/** Keywords from content.json that must appear; OCR'd files may miss one. */
	minKeywords: number;
	/** For files not built from content.json: these must all appear. */
	keywords?: string[];
	table?: boolean;
	/** The second page's text (multi-page PDFs). */
	page2?: boolean;
	speech?: boolean;
}

const KEYWORDS = 5;
const SPEECH_KEYWORDS = 3;

const CASES: Case[] = (['en', 'ru'] as const).flatMap((lang): Case[] => [
	{ file: `text-${lang}.txt`, lang, mime: 'text/plain', engine: 'text', minKeywords: KEYWORDS },
	{ file: `web-${lang}.html`, lang, mime: 'text/html', engine: 'docling', minKeywords: KEYWORDS, table: true },
	{ file: `pdf-text-${lang}.pdf`, lang, mime: 'application/pdf', engine: 'docling', minKeywords: KEYWORDS, table: true, page2: true },
	{ file: `pdf-scan-${lang}.pdf`, lang, mime: 'application/pdf', engine: 'docling', minKeywords: KEYWORDS - 1, table: true },
	{ file: `screenshot-${lang}.png`, lang, mime: 'image/png', engine: 'docling', minKeywords: KEYWORDS - 1 },
	{ file: `photo-${lang}.jpg`, lang, mime: 'image/jpeg', engine: 'docling', minKeywords: KEYWORDS - 1 },
	{ file: `doc-${lang}.docx`, lang, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', engine: 'docling', minKeywords: KEYWORDS, table: true },
	{ file: `slides-${lang}.pptx`, lang, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', engine: 'docling', minKeywords: KEYWORDS, table: true },
	{ file: `sheet-${lang}.xlsx`, lang, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', engine: 'docling', minKeywords: KEYWORDS, table: true },
	{ file: `doc-${lang}.odt`, lang, mime: 'application/vnd.oasis.opendocument.text', engine: 'docling', minKeywords: KEYWORDS, table: true },
	{ file: `slides-${lang}.odp`, lang, mime: 'application/vnd.oasis.opendocument.presentation', engine: 'docling', minKeywords: KEYWORDS, page2: true },
	{ file: `sheet-${lang}.ods`, lang, mime: 'application/vnd.oasis.opendocument.spreadsheet', engine: 'docling', minKeywords: KEYWORDS, table: true },
	{ file: `audio-${lang}.mp3`, lang, mime: 'audio/mpeg', engine: 'docling', minKeywords: SPEECH_KEYWORDS - 1, speech: true },
	{ file: `video-${lang}.mp4`, lang, mime: 'video/mp4', engine: 'docling', minKeywords: SPEECH_KEYWORDS - 1, speech: true },
]);
CASES.push(
	{ file: 'photo-en.heic', lang: 'en', mime: 'image/heic', engine: 'docling', minKeywords: KEYWORDS - 1 },
	{ file: 'audio-en.m4a', lang: 'en', mime: 'audio/x-m4a', engine: 'docling', minKeywords: SPEECH_KEYWORDS - 1, speech: true },
	// Docling's own iWork test files; file-type alone reads a .pages as Numbers and a .key as zip
	{ file: 'iwork-en.pages', lang: 'en', mime: 'application/vnd.apple.pages', engine: 'docling', minKeywords: 3, keywords: ['sample pages document', 'column three', 'cell nine'] },
	{ file: 'iwork-en.numbers', lang: 'en', mime: 'application/vnd.apple.numbers', engine: 'docling', minKeywords: 3, keywords: ['account categories', 'entertainment', '-2575.9'] },
	{ file: 'iwork-en.key', lang: 'en', mime: 'application/vnd.apple.keynote', engine: 'docling', minKeywords: 2, keywords: ['libreoffice 6.2', 'test running'] },
);

/** Generous: the first file loads Docling's models, the first recording loads Whisper. */
const TIMEOUT_MS = 10 * 60_000;

void describe('extraction to Markdown', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;
	let skipSpeech: string | false = false;

	before(async () => {
		({ docling, skip, skipSpeech } = await managedDocling());
	});
	after(() => docling?.dispose());

	for (const c of CASES) {
		void test(c.file, { timeout: TIMEOUT_MS }, async (t) => {
			const reason = c.speech ? skipSpeech : skip;
			if (reason) return t.skip(reason);
			const out = await extract(docling, c.file);
			const detail = () => `\n--- ${c.file} (${out.mime}, ${out.engine}) ---\n${out.markdown}\n--- log ---\n${out.log.join('\n')}`;

			assert.equal(out.mime, c.mime, `detected type${detail()}`);
			assert.equal(out.result.status, 'extracted', `status${detail()}`);
			assert.equal(out.engine, c.engine, `engine${detail()}`);
			checkText(out, c, detail);
		});
	}
});

function checkText(out: Extracted, c: Case, detail: () => string): void {
	const lang = content[c.lang];
	const keywords = c.keywords ?? (c.speech ? lang.speechKeywords : lang.keywords);
	const hits = found(out.text, keywords);
	assert.ok(hits.length >= c.minKeywords, `found ${hits.length}/${keywords.length} keywords (${hits.join(', ')}), need ${c.minKeywords}${detail()}`);

	// Russian stays Russian (no transliteration or translation), English has no stray Cyrillic
	const share = cyrillicShare(out.markdown);
	if (c.lang === 'ru') assert.ok(share > 0.6, `Cyrillic share ${share.toFixed(2)}${detail()}`);
	else assert.ok(share < 0.02, `Cyrillic share ${share.toFixed(2)}${detail()}`);

	if (c.table) {
		assert.match(out.markdown, /^\|.*\|$/m, `a Markdown table${detail()}`);
		const cells = found(out.text, lang.tableKeywords);
		assert.equal(cells.length, lang.tableKeywords.length, `table cells ${cells.join(', ')}${detail()}`);
	}
	if (c.page2) assert.ok(found(out.text, lang.page2.slice(1)).length === 1, `second page text${detail()}`);
	if (c.speech) assert.match(out.markdown, /^\[\d\d:\d\d\]/m, `transcript timestamps${detail()}`);
	// The steps a job reports for the queue row and its log
	if (c.speech) assert.ok(out.log.some((l) => /^info: Transcribing a \d+-(second|minute|hour) recording$/.test(l)), `recording length in the log${detail()}`);
	if (c.mime === 'application/pdf') assert.ok(out.log.some((l) => /^info: Reading \d+ pages$/.test(l)), `page count in the log${detail()}`);
}
