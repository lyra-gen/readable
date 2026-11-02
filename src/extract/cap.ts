import { promises as fs } from 'fs';

/**
 * Keeps extracted text within the note size limit (Largest note in settings):
 * a note of hundreds of MB crashes Obsidian. Docling's output is read from its
 * file no further than the limit, so the whole text never sits in memory; the
 * pipeline caps whatever an engine did not cut itself. A cut always ends at a
 * line break, so no table row or UTF-8 character is split.
 */

/** How much of an extracted text a note kept, in UTF-8 bytes. */
export interface TextCut {
	keptBytes: number;
	totalBytes: number;
}

const NEWLINE = 0x0a;

/** The first `maxBytes` of `bytes`, ending at a line break so no line, table row or UTF-8 character is split. */
function cutAtLine(bytes: Uint8Array, maxBytes: number): Uint8Array {
	const end = bytes.subarray(0, maxBytes).lastIndexOf(NEWLINE);
	return bytes.subarray(0, end > 0 ? end : 0);
}

/** `text` when it fits in `maxBytes`; otherwise its first lines up to that size, and how much was kept. */
export function capText(text: string, maxBytes: number): { text: string; cut?: TextCut } {
	// Each UTF-16 unit is at most 3 UTF-8 bytes, so short text needs no encoding
	if (text.length * 3 <= maxBytes) return { text };
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= maxBytes) return { text };
	const kept = cutAtLine(bytes, maxBytes);
	return { text: new TextDecoder().decode(kept), cut: { keptBytes: kept.byteLength, totalBytes: bytes.byteLength } };
}

/** Reads a UTF-8 file, but no more than `maxBytes` of it: a huge output never sits in memory whole. */
export async function readCapped(path: string, maxBytes: number): Promise<{ text: string; cut?: TextCut }> {
	const { size } = await fs.stat(path);
	if (size <= maxBytes) return { text: await fs.readFile(path, 'utf8') };
	const handle = await fs.open(path, 'r');
	try {
		const buffer = new Uint8Array(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		const kept = cutAtLine(buffer.subarray(0, bytesRead), maxBytes);
		return { text: new TextDecoder().decode(kept), cut: { keptBytes: kept.byteLength, totalBytes: size } };
	} finally {
		await handle.close();
	}
}

/** "5 MB", "444 MB", "800 KB". */
export function formatSize(bytes: number): string {
	const mb = bytes / 1024 / 1024;
	if (mb >= 10) return `${Math.round(mb)} MB`;
	if (mb >= 1) return `${Number(mb.toFixed(1))} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
