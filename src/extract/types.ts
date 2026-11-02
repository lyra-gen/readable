import type { JobStage, LogLevel } from '../core/types';
import type { TextCut } from './cap';

/**
 * The contract between the pipeline and the extraction engines. run-job picks
 * an engine through ExtractorRegistry, hands it the file's bytes and MIME
 * type, and turns the result into the job's outcome: `unsupported` skips the
 * file, `no-text` (or Markdown that holds only picture placeholders and page
 * breaks) fails it with a hint, and `failed` carries a code the queue can act
 * on, such as pausing the queue when the engine is unavailable.
 */

/** Between pages in extracted Markdown, from every engine. */
export const PAGE_BREAK = '\n\n---\n\n';

/** Docling's stand-ins for pictures, links to saved figures, and page breaks: none of them is text. */
const NOT_TEXT = [/<!--[\s\S]*?-->/g, /!\[[^\]]*\]\([^)]*\)/g, /!\[\[[^\]]*\]\]/g, /^\s*-{3,}\s*$/gm];

/** Whether extracted Markdown holds any text once picture placeholders and page breaks are removed. */
export function hasText(markdown: string): boolean {
	return NOT_TEXT.reduce((rest, pattern) => rest.replace(pattern, ''), markdown).trim().length > 0;
}

export interface ExtractInput {
	bytes: Uint8Array;
	mime: string;
	/** Vault-relative path; used for logging and extension hints. */
	path: string;
	/** `fraction` 0–1 through the stage when known; `detail` names the step, e.g. "page 15 of 62". */
	onProgress?: (stage: JobStage, fraction?: number, detail?: string) => void;
	/** Writes to the job's log, e.g. warnings from a partial conversion. */
	log?: (level: LogLevel, message: string) => void;
	/** Longest text to keep, in UTF-8 bytes. An extractor may stop reading there and report the cut. */
	maxBytes?: number;
	/** The file's content hash: an engine that saves partial work keys it by this, so a retry resumes. */
	resumeKey?: string;
}

export type ExtractResult =
	| {
			status: 'extracted';
			markdown: string;
			pages?: number;
			engine: string;
			/** Removes temporary files the markdown still references (figures); the pipeline calls it once they are saved. */
			cleanup?: () => Promise<void>;
			/** The folder the engine wrote figures to; only image links into it are figures, the rest is the document's text. */
			figuresDir?: string;
			/** Set when the text was cut to `maxBytes`. */
			cut?: TextCut;
	  }
	| { status: 'no-text'; engine: string }
	| { status: 'unsupported' }
	| { status: 'failed'; code: string; message: string };

/** One extraction engine: Docling, or the text reader for plain text and JSON. */
export interface Extractor {
	readonly id: string;
	supports(mime: string): boolean;
	extract(input: ExtractInput, signal: AbortSignal): Promise<ExtractResult>;
}
