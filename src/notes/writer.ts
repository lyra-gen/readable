import { TFile, TFolder, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import { shortHash } from '../pipeline/hash';
import { frontmatterLines, parseFrontmatterKeys } from './frontmatter';
import { EXTRACT_CALLOUT_HEADER, EXTRACT_HEADING, SUMMARY_HEADING, asCallout, demoteHeadings } from './format';
import type { ExtractFormat } from './format';
import { composeNote, isOwnedNote, mergeNote } from './owned';
import type { Rendered } from './owned';
import type { IngestedIndex } from './ingested-index';
import { resolveNotePath } from './location';
import { ensureFolder, parentOf } from './vault-paths';
import type { LocationSettings } from './location';

/**
 * The separate Readable note for a source: frontmatter, the embed, the summary
 * and the extract in the chosen format. Rewrites go through owned.ts, so only
 * Readable's keys and the region between the markers change (a note missing
 * its markers gets its whole body replaced). The note written is the one that
 * already covers the source, wherever it is (so it stays put after the source
 * moved); otherwise the path Note location gives, with a short hash suffix when
 * someone else's note is there. Dedupe is hasNoteFor. The pipeline calls it per
 * job.
 */

export interface NoteInput {
	sourcePath: string;
	hash: string;
	type: string;
	extractor?: string;
	model?: string;
	summary?: string;
	/** From the model; goes into `title` and `aliases` so search and links find the note by it. */
	title?: string;
	tags: string[];
	/** Extracted content as Markdown. */
	markdown: string;
	pages?: number;
	referencedBy?: string[];
}

/** Builds and writes the separate Readable note for one source. */
export class NoteWriter {
	constructor(
		private readonly app: App,
		private readonly settings: () => LocationSettings,
		private readonly format: () => ExtractFormat,
		private readonly index: IngestedIndex,
	) {}

	/** Our frontmatter and body, kept apart so a rewrite can leave the user's parts alone. */
	private renderParts(input: NoteInput): Rendered {
		const lines = frontmatterLines({
			title: input.title,
			aliases: input.title ? [input.title] : undefined,
			source: input.sourcePath,
			hash: `sha256:${input.hash}`,
			type: input.type,
			date: new Date().toISOString().slice(0, 10),
			tags: ['readable', ...input.tags],
			model: input.model,
			extractor: input.extractor,
			pages: input.pages,
			referenced_by: input.referencedBy?.map((p) => `[[${p}]]`),
		});
		const sections: string[] = [`![[${input.sourcePath}]]`];
		if (input.summary) sections.push(`${SUMMARY_HEADING}\n\n${input.summary}`);
		if (this.format() === 'callout') {
			// A blank line would end the blockquote, so header and body are joined with a single newline
			sections.push(`${EXTRACT_CALLOUT_HEADER}\n${asCallout(input.markdown)}`);
		} else {
			sections.push(`${EXTRACT_HEADING}\n\n${demoteHeadings(input.markdown)}`);
		}
		return { frontmatterLines: lines, body: sections.join('\n\n') };
	}

	/**
	 * Returns the note path. Rewrites our part of an existing note for the
	 * same source and keeps the user's; avoids clobbering anything else.
	 */
	async write(input: NoteInput): Promise<string> {
		const path = await this.pathForInput(input);
		await ensureFolder(this.app, parentOf(path));
		const parts = this.renderParts(input);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, (current) => mergeNote(current, parts) ?? current);
		} else {
			await this.app.vault.create(path, composeNote(parts));
		}
		return path;
	}

	/**
	 * True when a Readable note for this source already holds this exact
	 * content hash. The index answers from the metadata cache; it is only
	 * consulted the slow way, by reading candidate files, when the index knows
	 * no note at all, since the cache lags behind a note written moments ago.
	 */
	async hasNoteFor(sourcePath: string, hash: string): Promise<boolean> {
		if (this.index.isCurrent(sourcePath, hash)) return true;
		if (this.index.notesFor(sourcePath).length > 0) return false;
		const path = resolveNotePath(sourcePath, this.settings());
		for (const candidate of [path, ...this.suffixedSiblings(path)]) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (!(file instanceof TFile)) continue;
			const fm = await this.readFrontmatter(file);
			if (fm.source === sourcePath && fm.hash === `sha256:${hash}`) return true;
		}
		return false;
	}

	/** Where a new note for this source would go. */
	pathFor(sourcePath: string): string {
		return resolveNotePath(sourcePath, this.settings());
	}

	private async pathForInput(input: NoteInput): Promise<string> {
		const preferred = resolveNotePath(input.sourcePath, this.settings());
		// A note that already covers this source is rewritten where it is, e.g. after the source moved
		const known = this.index.notesFor(input.sourcePath);
		const kept = known.includes(preferred) ? preferred : known.find((p) => this.app.vault.getAbstractFileByPath(p) instanceof TFile);
		if (kept && (await this.isOurs(kept))) return kept;
		const existing = this.app.vault.getAbstractFileByPath(preferred);
		if (!(existing instanceof TFile)) return preferred;
		if ((await this.readFrontmatter(existing)).source === input.sourcePath && (await this.isOurs(preferred))) return preferred;
		// Someone else's note lives there, or one that only looks like ours; keep ours distinct
		return normalizePath(preferred.replace(/\.md$/, ` (${shortHash(input.hash)}).md`));
	}

	/** A note Readable wrote: it has the owned-region markers to rewrite between. */
	private async isOurs(path: string): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && isOwnedNote(await this.app.vault.cachedRead(file));
	}

	/** Notes next to `path` that carry a Readable hash suffix. */
	private suffixedSiblings(path: string): string[] {
		const folder = this.app.vault.getAbstractFileByPath(parentOf(path) || '/');
		if (!(folder instanceof TFolder)) return [];
		const stem = (path.split('/').pop() ?? '').replace(/\.md$/, '');
		return folder.children
			.filter((c): c is TFile => c instanceof TFile && c.name.startsWith(`${stem} (`) && c.extension === 'md')
			.map((c) => c.path);
	}

	/**
	 * Reads `source` and `hash` straight from the file text. The metadata cache
	 * lags behind writes, so it cannot be trusted right after a note is created.
	 */
	private async readFrontmatter(file: TFile): Promise<{ source?: string; hash?: string }> {
		return parseFrontmatterKeys(await this.app.vault.cachedRead(file));
	}
}
