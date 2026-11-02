import { fileTypeFromBuffer } from 'file-type';

/**
 * Works out a file's MIME type for the pipeline, which picks the extractor and
 * the file's kind from it. The bytes decide: file-type sniffs magic numbers,
 * and the extension is trusted only where sniffing cannot tell (text formats
 * have no magic bytes, and iWork packages sniff as zip or as each other). An
 * unrecognised file that still looks like text is read as plain text; anything
 * else is null, and the job is skipped as unsupported.
 */

export interface DetectedType {
	mime: string;
	ext: string;
}

/** Text-like formats have no magic bytes; map by extension when sniffing finds nothing. */
const TEXT_BY_EXT: Record<string, string> = {
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	json: 'application/json',
	html: 'text/html',
	htm: 'text/html',
	// MHTML web archives are MIME text; file-type does not sniff them
	mhtml: 'multipart/related',
	mht: 'multipart/related',
	vtt: 'text/vtt',
	tex: 'text/x-tex',
	latex: 'text/x-tex',
	adoc: 'text/asciidoc',
	asciidoc: 'text/asciidoc',
};

/** iWork files are zip packages that file-type tells apart poorly (a .pages sniffs as Numbers, a .key as zip). */
const IWORK_BY_EXT: Record<string, string> = {
	pages: 'application/vnd.apple.pages',
	numbers: 'application/vnd.apple.numbers',
	key: 'application/vnd.apple.keynote',
};
const IWORK_SNIFFED = new Set(['application/zip', ...Object.values(IWORK_BY_EXT)]);

function looksLikeText(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 4096);
	let suspicious = 0;
	for (const b of sample) {
		if (b === 0) return false;
		if (b < 7 || (b > 13 && b < 32)) suspicious++;
	}
	return sample.length === 0 || suspicious / sample.length < 0.02;
}

/** MIME from bytes first, extension only as a hint for text formats. */
export async function detectType(bytes: Uint8Array, path: string): Promise<DetectedType | null> {
	const sniffed = await fileTypeFromBuffer(bytes);
	const base = path.split('/').pop() ?? path;
	const dot = base.lastIndexOf('.');
	const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
	const iwork = IWORK_BY_EXT[ext];
	if (iwork && sniffed && IWORK_SNIFFED.has(sniffed.mime)) return { mime: iwork, ext };
	if (sniffed) return { mime: sniffed.mime, ext: sniffed.ext };
	const byExt = TEXT_BY_EXT[ext];
	if (byExt) return { mime: byExt, ext };
	if (looksLikeText(bytes)) return { mime: 'text/plain', ext: ext || 'txt' };
	return null;
}
