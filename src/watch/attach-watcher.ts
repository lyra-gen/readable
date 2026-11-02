import { TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import { attachmentsOf } from '../ingest/targets';

export interface AttachWatcherOptions {
	/** Auto-ingest is on and text goes into the notes files are attached to. */
	isEnabled: () => boolean;
	/** The policy will not process this extension. */
	isExcluded: (ext: string) => boolean;
	/** Readable's own note for the file; it embeds its source, which is not a new attachment. */
	isOwnNote: (note: TFile, file: TFile) => boolean;
	onAttached: (file: TFile, note: TFile) => void;
}

/**
 * Queues a file when it is newly attached (embedded) in a note. The note is
 * the trigger, so this ignores the watched folder: attachments usually live
 * in an attachments folder, not where the user writes.
 *
 * Only additions count: each note's set of attached files is remembered and
 * compared on every change, so editing a note does not queue its attachments
 * again. Dedupe would skip them anyway, but only after hashing each file.
 *
 * Files are remembered as TFile objects, which Obsidian keeps across a
 * rename: a moved attachment is the same one, and Obsidian rewriting the
 * embed afterwards adds nothing. A note's set is only ever replaced by that
 * note's own change; the 'resolved' pass after a rename reads a cache that
 * can be a rewrite behind, so it only fills in notes not seen yet.
 */
export function registerAttachWatcher(plugin: Plugin, opts: AttachWatcherOptions): void {
	const app = plugin.app;
	const attached = new Map<TFile, Set<TFile>>();

	const seed = () => {
		for (const note of app.vault.getMarkdownFiles()) {
			if (!attached.has(note)) attached.set(note, new Set(attachmentsOf(app, note)));
		}
	};

	app.workspace.onLayoutReady(() => {
		seed();
		plugin.registerEvent(app.metadataCache.on('resolved', seed));
		plugin.registerEvent(
			app.metadataCache.on('changed', (note, _data, cache) => {
				const now = new Set(attachmentsOf(app, note, cache));
				const before = attached.get(note) ?? new Set<TFile>();
				attached.set(note, now);
				if (!opts.isEnabled()) return;
				for (const file of now) {
					if (before.has(file) || opts.isOwnNote(note, file) || opts.isExcluded(file.extension)) continue;
					opts.onAttached(file, note);
				}
			}),
		);
		plugin.registerEvent(
			app.vault.on('delete', (file) => {
				if (file instanceof TFile) attached.delete(file);
			}),
		);
	});
}
