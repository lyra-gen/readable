import { splitFrontmatter } from './frontmatter';

/**
 * A Readable note is partly ours and partly the user's. We own the
 * frontmatter keys we write and the body between two Obsidian comments:
 *
 *   %%readable:start%%
 *   ![[source]] … callout …
 *   %%readable:end%%
 *
 * Everything else (keys the user added, text above or below the markers) is
 * theirs and survives a rewrite. Comments are invisible in reading view.
 * A note without both markers is not rewritten: it may be someone else's note
 * that happens to carry `source` and `hash`, and replacing its body would lose
 * their text. The writer puts ours beside it instead.
 */

export const START = '%%readable:start%%';
export const END = '%%readable:end%%';

/**
 * Where the owned body sits in `content`: `start` is just after START and
 * `end` is where END begins. Null unless both markers are present, END after START.
 */
export function ownedRegion(content: string): { start: number; end: number } | null {
	const at = content.indexOf(START);
	if (at === -1) return null;
	const start = at + START.length;
	const end = content.indexOf(END, start);
	return end === -1 ? null : { start, end };
}

/** Frontmatter keys Readable writes; anything else in the block is the user's. */
const OWNED_KEYS = new Set(['title', 'aliases', 'source', 'hash', 'type', 'date', 'tags', 'model', 'extractor', 'pages', 'referenced_by']);

export interface Rendered {
	/** Our frontmatter, as YAML lines without the `---` fences. */
	frontmatterLines: string[];
	/** Our body, without the markers. */
	body: string;
}

/** Wraps the rendered parts into a complete new note. */
export function composeNote(rendered: Rendered): string {
	return `---\n${rendered.frontmatterLines.join('\n')}\n---\n\n${START}\n${rendered.body}\n${END}\n`;
}

/** Whether the note carries both markers, so a rewrite knows which part is ours. */
export function isOwnedNote(content: string): boolean {
	return ownedRegion(splitFrontmatter(content).rest) !== null;
}

/**
 * Rewrites `current` with the new rendered parts, keeping the user's
 * frontmatter keys and anything outside the markers. Null when the note has
 * no owned region to replace.
 */
export function mergeNote(current: string, rendered: Rendered): string | null {
	const { frontmatter, rest } = splitFrontmatter(current);
	const userKeys = frontmatter ? userFrontmatterLines(frontmatter) : [];
	const lines = [...rendered.frontmatterLines, ...userKeys];
	const head = `---\n${lines.join('\n')}\n---\n`;

	const owned = `${START}\n${rendered.body}\n${END}`;
	const region = ownedRegion(rest);
	if (!region) return null;
	const before = rest.slice(0, region.start - START.length);
	const after = rest.slice(region.end + END.length);
	return `${head}${before}${owned}${after}`;
}

/** Lines of frontmatter whose key is not ours, each with its continuation lines. */
function userFrontmatterLines(frontmatter: string): string[] {
	const out: string[] = [];
	let keep = false;
	for (const line of frontmatter.split('\n')) {
		const key = /^([A-Za-z0-9_][\w.-]*)\s*:/.exec(line)?.[1];
		if (key !== undefined) keep = !OWNED_KEYS.has(key);
		else if (!/^(\s|-\s|$)/.test(line)) keep = false; // not a continuation: unknown line, drop
		if (keep) out.push(line);
	}
	return out;
}
