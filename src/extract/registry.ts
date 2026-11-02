import { TextExtractor } from './text';
import type { Extractor } from './types';

/**
 * Picks the engine for a file by its MIME type. Docling reads everything it
 * takes; the text reader takes only plain text and JSON, which Docling does
 * not. There is no fallback: when Docling is not installed or cannot start,
 * its jobs fail as engine unavailable and the queue pauses until it is ready.
 */
export class ExtractorRegistry {
	private readonly text = new TextExtractor();

	constructor(
		/** Managed Docling. */
		private readonly docling: () => Extractor,
	) {}

	/** Engine for this MIME type, or null when nothing can handle it. */
	select(mime: string): Extractor | null {
		const docling = this.docling();
		if (docling.supports(mime)) return docling;
		return this.text.supports(mime) ? this.text : null;
	}
}
