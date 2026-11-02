/**
 * Docling's input formats (InputFormat in docling/datamodel/base_models.py),
 * as a static map so `supports()` needs no running sidecar. MIME types are
 * the ones `detectType` produces (file-type plus the extension fallback for
 * text formats).
 */

import { baseMime } from '../kinds';

interface DoclingFormat {
	mimes: string[];
	media?: boolean;
}

const CFB = 'application/x-cfb'; // legacy .doc/.xls/.ppt; the server tells them apart by extension

/** Keyed by InputFormat. Only the MIME types are matched; add an extension in src/pipeline/detect.ts to route it here. */
const DOCLING_FORMATS: Record<string, DoclingFormat> = {
	pdf: { mimes: ['application/pdf'] },
	docx: {
		mimes: [
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'application/msword',
			'application/rtf',
			'application/vnd.oasis.opendocument.text',
			CFB,
		],
	},
	pptx: {
		mimes: [
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			'application/vnd.ms-powerpoint',
			'application/vnd.oasis.opendocument.presentation',
		],
	},
	xlsx: {
		mimes: [
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'application/vnd.oasis.opendocument.spreadsheet',
		],
	},
	iwork: { mimes: ['application/vnd.apple.pages', 'application/vnd.apple.numbers', 'application/vnd.apple.keynote'] },
	html: { mimes: ['text/html', 'application/xhtml+xml'] },
	mhtml: { mimes: ['multipart/related'] },
	md: { mimes: ['text/markdown'] },
	csv: { mimes: ['text/csv'] },
	asciidoc: { mimes: ['text/asciidoc'] },
	latex: { mimes: ['text/x-tex', 'application/x-tex'] },
	// HEIC/HEIF/AVIF are converted to PNG by the sidecar (pillow-heif) before Docling sees them
	image: { mimes: ['image/png', 'image/jpeg', 'image/tiff', 'image/bmp', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif'] },
	vtt: { mimes: ['text/vtt'] },
	audio: {
		mimes: ['audio/wav', 'audio/mpeg', 'audio/x-m4a', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'],
		media: true,
	},
	video: {
		mimes: ['video/mp4', 'video/vnd.avi', 'video/quicktime', 'video/matroska', 'video/webm'],
		media: true,
	},
};

const BY_MIME = new Map<string, DoclingFormat>();
for (const format of Object.values(DOCLING_FORMATS)) {
	for (const mime of format.mimes) BY_MIME.set(mime, format);
}

/**
 * Whether Docling takes this MIME type. Audio and video only with the speech
 * add-on; then any audio or video container is accepted, since ffmpeg
 * decodes it first. `application/ogg`
 * is how .ogv/.ogx containers are detected.
 */
export function doclingSupports(mime: string, media: boolean): boolean {
	const base = baseMime(mime);
	if (base.startsWith('audio/') || base.startsWith('video/') || base === 'application/ogg') return media;
	const format = BY_MIME.get(base);
	if (!format) return false;
	return media || !format.media;
}
