import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { isAbort } from '../core/errors';
import { applyEnrichment, extractedTextOf, hasSummary } from '../notes/enrichment';
import { enrich } from './enrich';
import type { EnrichTarget } from './enrich';

/**
 * The AI features run again over notes already in the vault, for the AI
 * commands (src/ui/ai-commands.ts). Each note's extracted text is read back from
 * the note itself, enriched, and written into the same note with
 * applyEnrichment. A note counts as failed only when the
 * server failed and nothing was added; a note with no extracted text is
 * skipped.
 */

export interface EnrichRun {
	/** Stops the run, abandoning the request in progress; that note gets nothing. */
	cancel: () => void;
	done: Promise<{ changed: number; skipped: number; failed: number }>;
}

/**
 * Runs the AI features over notes, one at a time. `notes` are vault paths
 * of Readable notes; `onlyMissing` skips notes that already have a
 * summary. `onProgress` is called before each note is read.
 */
export function enrichNotes(
	app: App,
	target: EnrichTarget,
	notes: string[],
	onlyMissing: boolean,
	onProgress: (i: number, total: number, name: string) => void,
): EnrichRun {
	const { client, settings } = target;
	const controller = new AbortController();
	const done = (async () => {
		let changed = 0;
		let skipped = 0;
		let failed = 0;
		for (const [i, path] of notes.entries()) {
			if (controller.signal.aborted) break;
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				skipped++;
				continue;
			}
			onProgress(i, notes.length, file.basename);
			const content = await app.vault.cachedRead(file);
			if (onlyMissing && settings.summaries && hasSummary(content)) {
				skipped++;
				continue;
			}
			const text = extractedTextOf(content);
			if (!text) {
				skipped++;
				continue;
			}
			// enrich() logs a server failure as a warning with its error and carries on
			let hadError = false;
			try {
				const added = await enrich(client, text, settings, {
					signal: controller.signal,
					log: (level, _message, error) => {
						if (level === 'warn' && error) hadError = true;
					},
				});
				if (added.summary || added.title || (added.tags && added.tags.length > 0)) {
					await applyEnrichment(app, file, added);
					changed++;
				} else if (hadError) failed++;
				else skipped++;
			} catch (error) {
				if (isAbort(error)) break;
				failed++;
			}
		}
		return { changed, skipped, failed };
	})();
	return { cancel: () => controller.abort(), done };
}
