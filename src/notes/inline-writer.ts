import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { EXTRACT_CALLOUT_HEADER, EXTRACT_HEADING, asCallout, demoteHeadings } from './format';
import type { ExtractFormat } from './format';
import type { IngestedIndex } from './ingested-index';
import { END as PLAIN_END } from './owned';

/**
 * "Under the embed" output: a collapsed callout inserted after every embed of
 * the source inside the user's own notes, the way OCR Extractor does it.
 *
 * Two formats, per the "Extracted text under embeds" setting: a collapsed
 * callout whose second line is an Obsidian comment with the content hash, or
 * plain Markdown between `%%readable:start sha256:…%%` and
 * `%%readable:end%%`. Either way the hash lets the block be recognised,
 * skipped when current, and replaced when the file changed. This is the only
 * code that edits notes Readable did not create; it goes through
 * vault.process so open editors stay consistent. A host is any note that embeds
 * the source except Readable's own note for it. It is not in the ingested
 * index: the hash in the block is the only lasting record, and the explorer
 * marks such files for the current session only.
 */

const HEADER = EXTRACT_CALLOUT_HEADER;
// Older versions wrote this header when nothing was extracted; such blocks are still found and replaced
const EMPTY_HEADER = '> [!info]- No text extracted';
const MARKER = /^> %%readable sha256:([0-9a-f]+)%%$/;
const PLAIN_START = /^%%readable:start sha256:([0-9a-f]+)%%$/;
// PLAIN_END is owned.END: the plain block must close with the same literal as a Readable note's owned region

export interface InlineInput {
	sourcePath: string;
	hash: string;
	markdown: string;
}

function buildBlock(input: InlineInput, format: ExtractFormat): string {
	if (format === 'plain') {
		return `%%readable:start sha256:${input.hash}%%\n${EXTRACT_HEADING}\n\n${demoteHeadings(input.markdown)}\n${PLAIN_END}`;
	}
	return [HEADER, `> %%readable sha256:${input.hash}%%`, ...asCallout(input.markdown).split('\n')].join('\n');
}

/** Finds a managed block of either format starting at `from` (after optional blank lines). Returns its span and hash. */
function managedBlockAt(content: string, from: number): { start: number; end: number; hash: string } | null {
	let i = from;
	while (i < content.length && content[i] === '\n') i++;
	const rest = content.slice(i);
	const lines = rest.split('\n');
	const plain = lines[0] ? PLAIN_START.exec(lines[0]) : null;
	if (plain?.[1]) {
		const endAt = rest.indexOf(`\n${PLAIN_END}`);
		if (endAt === -1) return null;
		return { start: i, end: i + endAt + 1 + PLAIN_END.length, hash: plain[1] };
	}
	if (!rest.startsWith(HEADER) && !rest.startsWith(EMPTY_HEADER)) return null;
	const marker = lines[1] ? MARKER.exec(lines[1]) : null;
	if (!marker?.[1]) return null;
	let count = 0;
	while (count < lines.length && (lines[count] ?? '').startsWith('>')) count++;
	const length = lines.slice(0, count).join('\n').length;
	return { start: i, end: i + length, hash: marker[1] };
}

export class InlineWriter {
	constructor(
		private readonly app: App,
		private readonly format: () => ExtractFormat,
		private readonly index: IngestedIndex,
	) {}

	/** Notes that embed the source, with the exact embed strings used in each. */
	hosts(sourcePath: string): { file: TFile; embeds: string[] }[] {
		const out: { file: TFile; embeds: string[] }[] = [];
		for (const [path, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!(sourcePath in links)) continue;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== 'md') continue;
			if (this.index.isNoteFor(file, sourcePath)) continue;
			const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
			const originals = new Set<string>();
			for (const embed of embeds) {
				const dest = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
				if (dest?.path === sourcePath) originals.add(embed.original);
			}
			if (originals.size > 0) out.push({ file, embeds: [...originals] });
		}
		return out;
	}

	/** True when every host note already carries a managed block for this exact content. */
	async isCurrent(sourcePath: string, hash: string): Promise<boolean> {
		const hosts = this.hosts(sourcePath);
		if (hosts.length === 0) return false;
		for (const { file, embeds } of hosts) {
			const content = await this.app.vault.cachedRead(file);
			for (const embed of embeds) {
				for (const at of occurrences(content, embed)) {
					const existing = managedBlockAt(content, lineEnd(content, at + embed.length));
					if (existing?.hash !== hash) return false;
				}
			}
		}
		return true;
	}

	/** Inserts or refreshes the block under each embed. Returns the host note paths touched. */
	async write(input: InlineInput): Promise<string[]> {
		const block = buildBlock(input, this.format());
		const touched: string[] = [];
		for (const { file, embeds } of this.hosts(input.sourcePath)) {
			let changed = false;
			await this.app.vault.process(file, (content) => {
				let next = content;
				for (const embed of embeds) {
					// Right to left so earlier offsets stay valid
					for (const at of occurrences(next, embed).reverse()) {
						const insertAt = lineEnd(next, at + embed.length);
						const existing = managedBlockAt(next, insertAt);
						if (existing) {
							if (existing.hash === input.hash) continue;
							next = `${next.slice(0, existing.start)}${block}${next.slice(existing.end)}`;
						} else {
							next = `${next.slice(0, insertAt)}\n\n${block}${next.slice(insertAt)}`;
						}
						changed = true;
					}
				}
				return next;
			});
			if (changed) touched.push(file.path);
		}
		return touched;
	}
}

function occurrences(content: string, needle: string): number[] {
	const out: number[] = [];
	let i = content.indexOf(needle);
	while (i !== -1) {
		out.push(i);
		i = content.indexOf(needle, i + needle.length);
	}
	return out;
}

function lineEnd(content: string, from: number): number {
	const nl = content.indexOf('\n', from);
	return nl === -1 ? content.length : nl;
}
