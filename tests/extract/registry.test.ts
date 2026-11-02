import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ExtractorRegistry } from '../../src/extract/registry';
import type { Extractor } from '../../src/extract/types';

const docling: Extractor = {
	id: 'docling',
	supports: (mime) => ['application/pdf', 'text/html', 'text/markdown', 'text/csv'].includes(mime),
	extract: () => Promise.resolve({ status: 'unsupported' }),
};
const registry = new ExtractorRegistry(() => docling);

void describe('which engine reads a file', () => {
	void test('Docling reads what it takes, including text formats it knows', () => {
		for (const mime of ['application/pdf', 'text/html', 'text/markdown', 'text/csv']) assert.equal(registry.select(mime)?.id, 'docling', mime);
	});

	void test('the text reader takes plain text and JSON', () => {
		assert.equal(registry.select('text/plain')?.id, 'text');
		assert.equal(registry.select('application/json')?.id, 'text');
	});

	void test('nothing else is read', () => {
		assert.equal(registry.select('application/zip'), null);
	});
});

void describe('the text reader', () => {
	const text = new ExtractorRegistry(() => docling).select('text/plain');
	const read = (s: string, mime = 'text/plain') => text!.extract({ bytes: new TextEncoder().encode(s), mime, path: 'a.txt' }, new AbortController().signal);

	void test('keeps the text, with Unix line endings', async () => {
		assert.deepEqual(await read('a\r\nb\rc\n'), { status: 'extracted', markdown: 'a\nb\nc', engine: 'text' });
	});

	void test('puts JSON in a code block', async () => {
		assert.deepEqual(await read('{"a":1}', 'application/json'), { status: 'extracted', markdown: '```json\n{"a":1}\n```', engine: 'text' });
	});

	void test('an empty file has no text', async () => {
		assert.deepEqual(await read('  \n'), { status: 'no-text', engine: 'text' });
	});
});
