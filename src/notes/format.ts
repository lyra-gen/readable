/**
 * The fixed text of a Readable note: section headings and the callout
 * header, plus the helpers that shape extracted text. Every writer and reader
 * of notes uses these, so the format lives in one place.
 */

export const SUMMARY_HEADING = '## Summary';
export const EXTRACT_HEADING = '## Extracted text';
export const EXTRACT_CALLOUT_HEADER = '> [!quote]- Extracted text';

/**
 * How extracted text is written. `plain` ("Markdown" in settings): under a
 * heading, clean for search and LLMs, foldable but open by default.
 * `callout` ("Folded box"): a `> [!quote]-` box that starts collapsed, with
 * `> ` on every line.
 */
export const EXTRACT_FORMATS = ['plain', 'callout'] as const;
export type ExtractFormat = (typeof EXTRACT_FORMATS)[number];

/** Prefixes every line with `> ` (a bare `>` for empty lines) so it sits inside a callout. */
export function asCallout(markdown: string): string {
	return markdown
		.split('\n')
		.map((line) => (line.length === 0 ? '>' : `> ${line}`))
		.join('\n');
}

/**
 * Pushes every heading down one level (to a maximum of six), so the
 * document's own headings sit under "## Extracted text" and show in the
 * outline. Headings inside fenced code blocks are left alone.
 */
export function demoteHeadings(markdown: string): string {
	let inFence = false;
	return markdown
		.split('\n')
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
			if (inFence) return line;
			const m = /^(#{1,6})(\s+\S)/.exec(line);
			if (!m?.[1] || !m[2]) return line;
			return `${'#'.repeat(Math.min(6, m[1].length + 1))}${m[2]}${line.slice(m[0].length)}`;
		})
		.join('\n');
}

/**
 * Tags that make Obsidian load something when the note is opened: a remote
 * image or frame leaks that the document was read, and from where. Their `<`
 * is written as `&lt;` so they show as text. Docling already escapes HTML in
 * document text; this covers plain-text sources and what a model wrote.
 */
const LOADING_TAG = /<(?=\/?(?:img|picture|source|iframe|frame|embed|object|script|link|video|audio|track|meta|base|form|input|button|style|svg|use)\b)/gi;

export function neutraliseHtml(markdown: string): string {
	return markdown.replace(LOADING_TAG, '&lt;');
}
