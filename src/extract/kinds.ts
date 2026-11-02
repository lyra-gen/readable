/**
 * The kinds of file a user decides about in Extraction settings. Decided
 * from the detected MIME type; the extension only pre-filters the watcher
 * and picks the queue's lane, before any bytes are read.
 */
import type { OcrMode } from './docling/options';
export type FileKind = 'document' | 'image' | 'audio' | 'video' | 'text';

export const DOCUMENT_POLICIES = ['read', 'skip'] as const;
export const IMAGE_POLICIES = ['text', 'describe', 'skip'] as const;
export const AUDIO_POLICIES = ['transcribe', 'skip'] as const;
export const VIDEO_POLICIES = ['transcribe', 'skip'] as const;
export const TEXT_POLICIES = ['copy', 'skip'] as const;
/** Pictures inside documents: saved as attachments, saved and described by the vision model, or left out. */
export const PICTURE_POLICIES = ['attach', 'describe', 'skip'] as const;

export type DocumentPolicy = (typeof DOCUMENT_POLICIES)[number];
export type ImagePolicy = (typeof IMAGE_POLICIES)[number];
export type AudioPolicy = (typeof AUDIO_POLICIES)[number];
export type VideoPolicy = (typeof VIDEO_POLICIES)[number];
export type TextPolicy = (typeof TEXT_POLICIES)[number];
export type PicturePolicy = (typeof PICTURE_POLICIES)[number];

export interface ExtractionPolicy {
	documents: DocumentPolicy;
	images: ImagePolicy;
	audio: AudioPolicy;
	video: VideoPolicy;
	plainText: TextPolicy;
	/** Extensions never processed, lower case, without the dot. */
	ignoreExtensions: string[];
	/** When document pages go through OCR; decides what a "no text" failure suggests. */
	ocr: OcrMode;
	/** The model that describes pictures; 'own' when Readable's own server picks one; '' when none is set. */
	visionModel: string;
}

export const KIND_LABEL: Record<FileKind, string> = {
	document: 'Documents',
	image: 'Images',
	audio: 'Audio',
	video: 'Video',
	text: 'Plain text',
};

const PLAIN_TEXT_MIMES = new Set(['text/plain', 'application/json']);

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function baseMime(mime: string): string {
	return mime.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function kindOf(mime: string): FileKind {
	const base = baseMime(mime);
	if (base.startsWith('image/')) return 'image';
	if (base.startsWith('audio/')) return 'audio';
	if (base.startsWith('video/') || base === 'application/ogg') return 'video';
	if (PLAIN_TEXT_MIMES.has(base)) return 'text';
	return 'document';
}

/** Whether this kind is on in the policy. */
export function kindEnabled(policy: ExtractionPolicy, kind: FileKind): boolean {
	switch (kind) {
		case 'document':
			return policy.documents !== 'skip';
		case 'image':
			return policy.images !== 'skip';
		case 'audio':
			return policy.audio !== 'skip';
		case 'video':
			return policy.video !== 'skip';
		case 'text':
			return policy.plainText !== 'skip';
	}
}

/**
 * Extension → kind, for the watcher's cheap pre-filter and the queue's lanes. Unknown extensions are left to
 * the job. No .ts: it is far more often TypeScript than an MPEG stream.
 */
const KIND_BY_EXT: Record<string, FileKind> = Object.fromEntries([
	...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif'].map((e) => [e, 'image'] as const),
	...['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'wma', 'opus', 'aiff', 'aif', 'amr', 'caf', 'm4b', 'mka', 'mp2', 'spx', 'weba', 'f4a'].map((e) => [e, 'audio'] as const),
	...['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'ogv', '3gp', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'm2t', '3g2', 'f4v'].map((e) => [e, 'video'] as const),
	...['txt', 'json', 'log'].map((e) => [e, 'text'] as const),
	...['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'odp', 'ods', 'pages', 'numbers', 'key', 'rtf', 'html', 'htm', 'mhtml', 'csv', 'md', 'epub'].map(
		(e) => [e, 'document'] as const,
	),
]);

export function kindOfExtension(ext: string): FileKind | null {
	return KIND_BY_EXT[ext.toLowerCase()] ?? null;
}

/** Docling's two lanes: recordings are transcribed beside everything else, so the queue counts them apart. */
export type Lane = 'media' | 'document';

/** The lane a file's job runs on, by its extension; unknown extensions go with documents. */
export function laneOf(sourcePath: string): Lane {
	const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	const kind = dot < 0 ? null : kindOfExtension(name.slice(dot + 1));
	return kind === 'audio' || kind === 'video' ? 'media' : 'document';
}

/** "svg, .ico, PSD" → ["svg", "ico", "psd"]. */
export function parseExtensions(text: string): string[] {
	return text
		.split(/[\s,;]+/)
		.map((e) => e.trim().replace(/^\./, '').toLowerCase())
		.filter((e) => e.length > 0);
}

/** A file the policy will not process, by extension alone (no bytes read). */
export function excludedByExtension(policy: ExtractionPolicy, ext: string): boolean {
	const lower = ext.toLowerCase();
	if (policy.ignoreExtensions.includes(lower)) return true;
	const kind = kindOfExtension(lower);
	return kind !== null && !kindEnabled(policy, kind);
}
