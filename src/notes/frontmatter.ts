/**
 * Minimal hand-written YAML for the flat keys Readable owns, a splitter that
 * separates the frontmatter from the body (owned.ts uses it to keep the user's
 * keys on a rewrite), and a reader for just `source` and `hash` straight from
 * note text. The writer reads that way because the metadata cache lags a note
 * written moments ago; follow-rename uses yamlScalar to find a `source` line
 * exactly as Readable wrote it.
 */

export type FrontmatterValue = string | number | boolean | string[] | undefined;

/** Newlines and other control characters: a bare newline would end the line and, with `---`, the frontmatter. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is matched
const CONTROL = /[\x00-\x1f\x7f]/;
const EVERY_CONTROL = new RegExp(CONTROL.source, 'g');

export function yamlScalar(value: string): string {
	// Quote when YAML would misread it: leading indicator chars, structural chars, or a bare number/bool/null.
	// A plain ISO date stays unquoted so Obsidian treats it as a date property.
	if (
		value === '' ||
		/^[-?&*!|>'"%@`#]/.test(value) ||
		/[:#{}[\],]/.test(value) ||
		/^\s|\s$/.test(value) ||
		/^(true|false|null|~)$/i.test(value) ||
		/^[+-]?\d+(\.\d+)?$/.test(value) ||
		CONTROL.test(value)
	) {
		return `"${value
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(EVERY_CONTROL, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}"`;
	}
	return value;
}

/** Minimal YAML for flat keys with scalars and string arrays, as lines without the `---` fences. Keeps key order. */
export function frontmatterLines(data: Record<string, FrontmatterValue>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			lines.push(value.length === 0 ? `${key}: []` : `${key}: [${value.map(yamlScalar).join(', ')}]`);
		} else if (typeof value === 'string') {
			lines.push(`${key}: ${yamlScalar(value)}`);
		} else {
			lines.push(`${key}: ${String(value)}`);
		}
	}
	return lines;
}

/** Splits a note into its frontmatter body (between the fences) and the rest; frontmatter is null when there is none. */
export function splitFrontmatter(text: string): { frontmatter: string | null; rest: string } {
	if (!text.startsWith('---\n')) return { frontmatter: null, rest: text };
	const close = text.indexOf('\n---', 4);
	if (close === -1) return { frontmatter: null, rest: text };
	const afterClose = close + 4;
	const rest = text[afterClose] === '\n' ? text.slice(afterClose + 1) : text.slice(afterClose);
	return { frontmatter: text.slice(4, close), rest };
}

const QUOTED = /^"(.*)"$/;

/** Minimal frontmatter reader for the two keys we own. */
export function parseFrontmatterKeys(text: string): { source?: string; hash?: string } {
	const { frontmatter } = splitFrontmatter(text);
	if (frontmatter === null) return {};
	const out: { source?: string; hash?: string } = {};
	for (const line of frontmatter.split('\n')) {
		const m = /^(source|hash):\s*(.*)$/.exec(line);
		if (!m) continue;
		const raw = m[2]?.trim() ?? '';
		const value = QUOTED.test(raw) ? raw.replace(QUOTED, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : raw;
		if (m[1] === 'source') out.source = value;
		else out.hash = value;
	}
	return out;
}
