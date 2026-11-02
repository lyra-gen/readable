import type { ChatMessage, LlmClient } from './client';
import { DEFAULT_PROMPTS } from './prompts';
import { neutraliseImageLinks } from '../notes/figures';
import { neutraliseHtml } from '../notes/format';

/**
 * A short summary of extracted text. Long text is split into chunks that fit
 * a small local model's context; each chunk is summarised, then the chunk
 * summaries are summarised once more (map-reduce).
 */

export interface SummariseOptions {
	model: string;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
	/** How long; default `short`. */
	length?: SummaryLength;
	/** What the summary should be like; default DEFAULT_PROMPTS.summary. Goes after the text. */
	instructions?: string;
}

export const SUMMARY_LENGTHS = ['short', 'medium', 'long'] as const;
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number];

/** Characters per chunk: roughly 3k tokens, safe for 8k-context models with room for the reply. */
const CHUNK_CHARS = 12_000;

/** Each length in the prompt's words, and the reply cap that fits it. */
const LENGTHS: Record<SummaryLength, { words: string; maxTokens: number }> = {
	short: { words: '3 to 6 sentences', maxTokens: 400 },
	medium: { words: 'two paragraphs', maxTokens: 900 },
	long: { words: 'three to five paragraphs', maxTokens: 900 },
};

const SYSTEM = 'You summarise documents. Answer with the summary only.';

export async function summarise(client: LlmClient, text: string, options: SummariseOptions): Promise<string> {
	const { words: length, maxTokens } = LENGTHS[options.length ?? 'short'];
	const instructions = options.instructions?.trim() || DEFAULT_PROMPTS.summary;
	const chunks = splitText(text, CHUNK_CHARS);
	if (chunks.length === 1) {
		options.onProgress?.(0, 1);
		const summary = await client.chat(prompt(chunks[0] ?? '', 'document', length, instructions), { model: options.model, maxTokens, signal: options.signal });
		options.onProgress?.(1, 1);
		return clean(summary);
	}
	const partials: string[] = [];
	for (const [i, chunk] of chunks.entries()) {
		options.onProgress?.(i, chunks.length + 1);
		partials.push(await client.chat(prompt(chunk, `part ${i + 1} of ${chunks.length} of a document`, LENGTHS.short.words, instructions), { model: options.model, maxTokens: LENGTHS.short.maxTokens, signal: options.signal }));
	}
	options.onProgress?.(chunks.length, chunks.length + 1);
	const combined = await client.chat(
		[
			{ role: 'system', content: SYSTEM },
			{
				role: 'user',
				content: `These are summaries of consecutive parts of one document. Write one summary of the whole document in ${length}.\n\n${partials.map((p, i) => `Part ${i + 1}:\n${p}`).join('\n\n')}\n\n${instructions}`,
			},
		],
		{ model: options.model, maxTokens, signal: options.signal },
	);
	options.onProgress?.(chunks.length + 1, chunks.length + 1);
	return clean(combined);
}

/** Small models often open with "Here is a summary of…:" whatever the prompt says; drop that line. */
export function clean(summary: string): string {
	return neutraliseHtml(
		neutraliseImageLinks(
			summary
				.replace(/^\s*(?:here(?:'s| is)|below is|the following is)\b[^\n]{0,80}?:\s*/i, '')
				.replace(/^\s*\*\*summary\*\*:?\s*/i, '')
				.trim(),
		),
	);
}

/** The instructions come after the text: small models drop a language rule given before a long document. */
function prompt(text: string, what: string, length: string, instructions: string): ChatMessage[] {
	return [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: `Summarise this ${what} in ${length}.\n\n${text}\n\n${instructions}` },
	];
}

/** Splits on paragraph breaks, then lines, then hard cuts, so chunks stay under `limit` characters. */
function splitText(text: string, limit: number): string[] {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return [trimmed];
	const chunks: string[] = [];
	let current = '';
	const push = () => {
		if (current.trim().length > 0) chunks.push(current.trim());
		current = '';
	};
	for (const paragraph of trimmed.split(/\n{2,}/)) {
		const piece = paragraph.length > limit ? hardCut(paragraph, limit) : [paragraph];
		for (const part of piece) {
			if (current.length + part.length + 2 > limit) push();
			current += (current ? '\n\n' : '') + part;
		}
	}
	push();
	return chunks;
}

function hardCut(text: string, limit: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const cut = rest.lastIndexOf('\n', limit) > limit / 2 ? rest.lastIndexOf('\n', limit) : limit;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	out.push(rest);
	return out;
}
