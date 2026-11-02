/**
 * Splits a stream of text chunks into lines. A conversion reply can be one
 * line of hundreds of megabytes arriving in 64 KB chunks, read on Obsidian's
 * main thread: each chunk is searched once and kept in a list, and a line is
 * joined once, when it ends. Appending to one string and searching it from
 * the start on every chunk took quadratic time and froze Obsidian.
 */
export class LineReader {
	private parts: string[] = [];

	/** The lines this chunk completes, without their line breaks. */
	push(chunk: string): string[] {
		const lines: string[] = [];
		let start = 0;
		let newline: number;
		while ((newline = chunk.indexOf('\n', start)) >= 0) {
			this.parts.push(chunk.slice(start, newline));
			lines.push(this.parts.length === 1 ? (this.parts[0] ?? '') : this.parts.join(''));
			this.parts = [];
			start = newline + 1;
		}
		if (start < chunk.length) this.parts.push(chunk.slice(start));
		return lines;
	}

	/** Drops a partial line, e.g. when the process restarts. */
	reset(): void {
		this.parts = [];
	}
}
