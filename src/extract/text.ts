import type { ExtractInput, ExtractResult, Extractor } from './types';

/**
 * Plain text and JSON, which Docling does not read: the file's own text,
 * decoded as UTF-8 with line endings made Unix. JSON and CSV go in a fenced
 * code block so Obsidian shows them as written. Docling takes the other
 * text formats (Markdown, HTML, CSV) first; see registry.ts.
 */
export class TextExtractor implements Extractor {
	readonly id = 'text';

	supports(mime: string): boolean {
		return mime.startsWith('text/') || mime === 'application/json';
	}

	extract(input: ExtractInput): Promise<ExtractResult> {
		const text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes).replace(/\r\n?/g, '\n').trim();
		if (text.length === 0) return Promise.resolve({ status: 'no-text', engine: this.id });
		if (input.mime === 'text/csv' || input.mime === 'application/json') {
			const lang = input.mime === 'text/csv' ? 'csv' : 'json';
			return Promise.resolve({ status: 'extracted', markdown: `\`\`\`${lang}\n${text}\n\`\`\``, engine: this.id });
		}
		return Promise.resolve({ status: 'extracted', markdown: text, engine: this.id });
	}
}
