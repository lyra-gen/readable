/**
 * OCR languages: the user's list, or the computer's languages plus English.
 * Docling cannot tell a scan's language, so the engine must be told; the
 * system languages are the best guess for what someone scans.
 */

/** Primary language tags of the system (`ru-GB` → `ru`), with English, no repeats. */
export function systemOcrLanguages(): string[] {
	const tags = typeof navigator === 'undefined' ? [] : [...navigator.languages];
	return unique([...tags.map(primary), 'en']);
}

/** Parses a comma- or space-separated list as typed in settings; '' means the system languages. */
export function resolveOcrLanguages(typed: string): string[] {
	const tags = typed
		.split(/[\s,;]+/)
		.map((t) => t.trim().toLowerCase())
		.filter((t) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(t));
	return tags.length > 0 ? unique(tags) : systemOcrLanguages();
}

function primary(tag: string): string {
	return tag.split('-')[0]?.toLowerCase() ?? tag.toLowerCase();
}

function unique(tags: string[]): string[] {
	return [...new Set(tags.filter(Boolean))];
}
