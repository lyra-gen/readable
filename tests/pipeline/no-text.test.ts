import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { Job } from '../../src/core/types';
import { mapConvertResponse } from '../../src/extract/docling/response';
import type { ExtractionPolicy } from '../../src/extract/kinds';
import { ExtractorRegistry } from '../../src/extract/registry';
import type { ExtractResult, Extractor } from '../../src/extract/types';
import { hasText } from '../../src/extract/types';
import type { InlineWriter } from '../../src/notes/inline-writer';
import type { NoteWriter } from '../../src/notes/writer';
import { noTextOutcome, runJob } from '../../src/pipeline/run-job';
import type { PipelineDeps } from '../../src/pipeline/run-job';

void describe('what counts as text', () => {
	void test('words count', () => {
		assert.equal(hasText('Квартальный отчёт'), true);
		assert.equal(hasText('<!-- image -->\n\nCaption under the picture'), true);
	});

	void test('picture placeholders, figure links and page breaks do not', () => {
		assert.equal(hasText(''), false);
		assert.equal(hasText('  \n\n '), false);
		assert.equal(hasText('<!-- image -->\n\n---\n\n<!-- image -->'), false);
		assert.equal(hasText('![Image](figures/p1.png)\n\n![[doc/figure-2.png]]'), false);
	});
});

void describe('Docling with no text', () => {
	void test('an empty or placeholder-only success is no text', () => {
		for (const md of ['', '   ', '<!-- image -->\n\n---\n\n<!-- image -->']) {
			const { result } = mapConvertResponse({ status: 'success', document: { md_content: md } });
			assert.equal(result.status, 'no-text', JSON.stringify(md));
		}
	});

	void test('a partial success with no text keeps Docling’s error', () => {
		const { result } = mapConvertResponse({
			status: 'partial_success',
			document: { md_content: '<!-- image -->' },
			errors: [{ error_message: 'Page 1 failed' }],
		});
		assert.deepEqual(result, { status: 'failed', code: 'docling', message: 'Page 1 failed' });
	});
});

void describe('the failure message', () => {
	void test('names the likely fix for the kind of file', () => {
		assert.match(noTextOutcome('application/pdf', 'a.pdf').message, /OCR/);
		assert.match(noTextOutcome('image/jpeg', 'a.jpg').message, /describe/);
		assert.match(noTextOutcome('audio/mpeg', 'a.mp3').message, /speech/);
		assert.equal(noTextOutcome('text/html', 'a.html').message, 'No text found in this file.');
		assert.equal(noTextOutcome('text/html', 'a.html').code, 'no-text');
	});
});

void describe('a job whose file has no text', () => {
	for (const [name, result] of [
		['the engine finds none', { status: 'no-text', engine: 'fake' }],
		['the engine returns only placeholders', { status: 'extracted', engine: 'fake', markdown: '<!-- image -->' }],
	] as [string, ExtractResult][]) {
		void test(`fails and writes nothing when ${name}`, async () => {
			const { deps, writes, cleanups } = pipeline(result);
			const outcome = await runJob(deps, job(), new AbortController().signal);
			assert.equal(outcome.kind, 'failed');
			assert.equal(outcome.kind === 'failed' && outcome.code, 'no-text');
			assert.equal(writes.length, 0);
			if (result.status === 'extracted') assert.equal(cleanups.count, 1);
		});
	}

	void test('an empty file fails as empty, before any engine runs', async () => {
		const { deps, writes, extracted } = pipeline({ status: 'extracted', engine: 'fake', markdown: 'Some text' }, '');
		const outcome = await runJob(deps, job(), new AbortController().signal);
		assert.equal(outcome.kind === 'failed' && outcome.code, 'empty');
		assert.match(outcome.kind === 'failed' ? outcome.message : '', /empty \(0 bytes\)/);
		assert.equal(extracted.count, 0);
		assert.equal(writes.length, 0);
	});

	void test('a file with text is still written', async () => {
		const { deps, writes } = pipeline({ status: 'extracted', engine: 'fake', markdown: 'Some text' });
		const outcome = await runJob(deps, job(), new AbortController().signal);
		assert.equal(outcome.kind, 'done');
		assert.equal(writes.length, 1);
	});
});

const PATH = 'docs/page.txt';

function job(): Job {
	return { id: 'j1', sourcePath: PATH, state: 'running', createdAt: 0, attempts: 0 } as unknown as Job;
}

function pipeline(result: ExtractResult, content = 'hello') {
	const writes: unknown[] = [];
	const cleanups = { count: 0 };
	const extracted = { count: 0 };
	const file = Object.assign(new TFile(), { path: PATH, extension: 'txt' });
	const extractor: Extractor = {
		id: 'fake',
		supports: () => true,
		extract: () => {
			extracted.count++;
			const cleanup = async () => {
				cleanups.count++;
			};
			return Promise.resolve(result.status === 'extracted' ? { ...result, cleanup } : result);
		},
	};
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => (path === PATH ? file : null),
			readBinary: () => Promise.resolve(new TextEncoder().encode(content).buffer),
		},
		metadataCache: { resolvedLinks: {} },
	} as unknown as App;
	const writer = {
		hasNoteFor: () => Promise.resolve(false),
		pathFor: () => 'Readable/page.md',
		write: (input: unknown) => {
			writes.push(input);
			return Promise.resolve('Readable/page.md');
		},
	} as unknown as NoteWriter;
	const inline = { hosts: () => [], isCurrent: () => Promise.resolve(false) } as unknown as InlineWriter;
	const policy: ExtractionPolicy = {
		documents: 'read',
		images: 'text',
		audio: 'transcribe',
		video: 'transcribe',
		plainText: 'copy',
		ignoreExtensions: [],
		visionModel: '',
	};
	const deps: PipelineDeps = {
		app,
		extractors: new ExtractorRegistry(() => extractor),
		writer,
		inline,
		outputMode: () => 'note',
		pictures: () => 'skip',
		figures: () => ({}) as never,
		policy: () => policy,
		llm: () => null,
		maxNoteBytes: () => 1_000_000,
		isOwnNote: () => false,
		log: () => {},
		progress: () => {},
	};
	return { deps, writes, cleanups, extracted };
}
