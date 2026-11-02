import type { App, TFile } from 'obsidian';
import type { Enrichment } from '../llm/enrich';
import { EXTRACT_CALLOUT_HEADER, EXTRACT_HEADING, SUMMARY_HEADING } from './format';
import { ownedRegion } from './owned';

/**
 * AI content for notes that already exist: the same summary, tags and title
 * a new file gets, read from the note's own extracted text, so nothing is
 * extracted again. Only the owned region and owned frontmatter keys change.
 */

/** The extracted text inside a Readable note, whichever format wrote it, or null. */
export function extractedTextOf(content: string): string | null {
	const region = ownedRegion(content);
	if (!region) return null;
	const owned = content.slice(region.start, region.end);
	const plain = owned.indexOf(EXTRACT_HEADING);
	if (plain !== -1) return owned.slice(plain + EXTRACT_HEADING.length).trim() || null;
	const callout = owned.indexOf(EXTRACT_CALLOUT_HEADER);
	if (callout !== -1) {
		return (
			owned
				.slice(callout + EXTRACT_CALLOUT_HEADER.length)
				.split('\n')
				.filter((line) => line.startsWith('>'))
				.map((line) => line.replace(/^> ?/, ''))
				.join('\n')
				.trim() || null
		);
	}
	return null;
}

export function hasSummary(content: string): boolean {
	const region = ownedRegion(content);
	return region !== null && content.slice(region.start, region.end).includes(`\n${SUMMARY_HEADING}\n`);
}

/** Puts the summary after the embed line in the owned region, replacing an old one; frontmatter keys via Obsidian. */
export async function applyEnrichment(app: App, file: TFile, added: Enrichment): Promise<void> {
	if (added.summary !== undefined) {
		await app.vault.process(file, (content) => {
			const region = ownedRegion(content);
			if (!region) return content;
			const owned = content.slice(region.start, region.end);
			const lines = owned.split('\n');
			// Drop an existing summary section: from its heading to the next heading or the end
			const at = lines.findIndex((l) => l === SUMMARY_HEADING);
			if (at !== -1) {
				let stop = at + 1;
				while (stop < lines.length && !/^#{1,6} /.test(lines[stop] ?? '') && !(lines[stop] ?? '').startsWith('> [!')) stop++;
				lines.splice(at, stop - at);
			}
			// Insert after the embed line (the first non-empty line of the region)
			const embedAt = lines.findIndex((l) => l.trim().length > 0);
			const insertAt = embedAt === -1 ? 0 : embedAt + 1;
			lines.splice(insertAt, 0, '', SUMMARY_HEADING, '', added.summary ?? '');
			const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
			return `${content.slice(0, region.start)}${body}${content.slice(region.end)}`;
		});
	}
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (added.model) fm.model = added.model;
		if (added.title) {
			fm.title = added.title;
			const aliases = Array.isArray(fm.aliases) ? fm.aliases.filter((a): a is string => typeof a === 'string') : [];
			if (!aliases.includes(added.title)) fm.aliases = [...aliases, added.title];
		}
		if (added.tags && added.tags.length > 0) {
			const tags = Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === 'string') : [];
			fm.tags = [...new Set([...tags, ...added.tags])];
		}
	});
}
