import { readFileSync } from 'fs';
import * as path from 'path';
import { ManagedDocling } from '../../src/extract/docling/managed/manager';
import type { ManagedDoclingDeps } from '../../src/extract/docling/managed/manager';
import { ExtractorRegistry } from '../../src/extract/registry';
import type { ExtractResult } from '../../src/extract/types';
import { detectType } from '../../src/pipeline/detect';

export const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'files');

export interface Extracted {
	mime: string;
	engine: string;
	result: ExtractResult;
	/** Lower case, whitespace collapsed, ё read as е, so checks survive OCR and ASR spelling. */
	text: string;
	markdown: string;
	log: string[];
}

/**
 * The managed Docling install on this machine, set up as Readable ships it:
 * OCR when needed in English and Russian with the automatic engine, accurate
 * tables, speech language detected, timestamps on, no pictures or vision.
 */
export async function managedDocling(
	overrides: Partial<ManagedDoclingDeps> = {},
	/** Changes to the options below, e.g. pictures on. */
	optionOverrides: Partial<ReturnType<ManagedDoclingDeps['options']>> = {},
): Promise<{ docling: ManagedDocling; skip: string | false; skipSpeech: string | false }> {
	const docling = new ManagedDocling({
		fullPath: (p) => p,
		options: () => ({
			figures: false,
			ocr: { mode: 'auto', languages: ['en', 'ru'], engine: 'auto' },
			tableMode: 'accurate',
			timeoutSec: 600,
			language: '',
			timestamps: true,
			vision: null,
			describePictures: false,
			describeImages: false,
			...optionOverrides,
		}),
		devLog: (line) => {
			if (process.env.READABLE_TEST_LOG) process.stderr.write(`${line}\n`);
		},
		...overrides,
	});
	await docling.init();
	const skip = docling.ready ? false : 'managed Docling is not installed on this machine (Settings › Extraction › Docling)';
	const skipSpeech = skip || (docling.speechInstalled ? false : 'the speech add-on is not installed');
	return { docling, skip, skipSpeech };
}

/** Detects the type from the bytes and extracts through the registry, as a job does. */
export interface ExtractOptions {
	maxBytes?: number;
	resumeKey?: string;
	signal?: AbortSignal;
	/** Pages read so far, as the queue row would show them. */
	onPages?: (done: number, total: number) => void;
}

export async function extract(docling: ManagedDocling, file: string, opts: ExtractOptions = {}): Promise<Extracted> {
	const full = path.isAbsolute(file) ? file : path.join(FIXTURES, file);
	const bytes = new Uint8Array(readFileSync(full));
	const type = await detectType(bytes, file);
	if (!type) throw new Error(`No type detected for ${file}`);
	const extractor = new ExtractorRegistry(() => docling.extractor).select(type.mime);
	if (!extractor) throw new Error(`No extractor for ${type.mime}`);
	const log: string[] = [];
	const result = await extractor.extract(
		{
			bytes,
			mime: type.mime,
			path: full,
			log: (level, message) => log.push(`${level}: ${message}`),
			maxBytes: opts.maxBytes,
			resumeKey: opts.resumeKey,
			onProgress: (_stage, _fraction, detail) => {
				const pages = /^page (\d+) of (\d+)$/.exec(detail ?? '');
				if (pages) opts.onPages?.(Number(pages[1]), Number(pages[2]));
			},
		},
		opts.signal ?? new AbortController().signal,
	);
	const markdown = result.status === 'extracted' ? result.markdown : '';
	if (result.status === 'extracted') await result.cleanup?.();
	return {
		mime: type.mime,
		engine: result.status === 'extracted' || result.status === 'no-text' ? result.engine : extractor.id,
		result,
		markdown,
		text: normalize(markdown),
		log,
	};
}

export function normalize(text: string): string {
	return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/** The keywords found in the text, each normalized like the text. */
export function found(text: string, keywords: string[]): string[] {
	return keywords.filter((k) => text.includes(normalize(k)));
}

/** Share of letters that are Cyrillic: about 1 for Russian, 0 for English. */
export function cyrillicShare(text: string): number {
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return 0;
	return letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / letters.length;
}
