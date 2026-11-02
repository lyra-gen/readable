import { TFile, TFolder } from 'obsidian';
import { filesInFolder, isIngestable } from '../ingest/targets';
import type { Plugin, TAbstractFile } from 'obsidian';

export interface WatcherOptions {
	isEnabled: () => boolean;
	watchedFolder: () => string;
	/** Also queue files in the watched folder when their content changes. */
	reprocessOnModify: () => boolean;
	/** A note exists for this file (see src/notes/ingested-index.ts). */
	isIngested: (path: string) => boolean;
	/** The policy will not process this extension (ignored, or its kind is set to Skip). */
	isExcluded: (ext: string) => boolean;
	onFile: (file: TFile, why: 'created' | 'modified' | 'moved') => void;
	/** Files found in the watched folder at startup with no note: added while Obsidian was closed. */
	onBackfill: (files: TFile[]) => void;
}

/**
 * Editors save often (Word every minute, a recording as it grows), and each
 * reprocess costs an extraction. A changed file is queued only once it has
 * been quiet this long.
 */
export const MODIFY_QUIET_MS = 60_000;

/**
 * Queues files that appear, or change, in the watched folder while auto-ingest
 * is on; files embedded in notes are the attach watcher's job. It starts at
 * layout ready, since Obsidian fires create for every file while loading, and
 * then, if auto-ingest is on, backfills once: files in the folder (the whole
 * vault when none is set) with no note came in while Obsidian was closed. After
 * that a new file is queued at once, a changed one (when
 * reprocessing changes is on) only after MODIFY_QUIET_MS of quiet, and a file
 * moved in from outside the folder only when neither path has a note, so a
 * move never reprocesses. The pipeline's dedupe by hash catches the rest.
 */
export function registerVaultWatcher(plugin: Plugin, opts: WatcherOptions): void {
	const pendingModify = new Map<string, number>();
	plugin.register(() => {
		for (const timer of pendingModify.values()) window.clearTimeout(timer);
		pendingModify.clear();
	});

	const inFolder = (path: string): boolean => {
		const folder = opts.watchedFolder().replace(/\/+$/, '');
		return !folder || path.startsWith(`${folder}/`);
	};
	const inScope = (file: TAbstractFile): file is TFile => {
		if (!isIngestable(file)) return false;
		if (!opts.isEnabled()) return false;
		if (opts.isExcluded(file.extension)) return false;
		return inFolder(file.path);
	};

	// Vault fires "create" for every file during startup; wait for layout.
	plugin.app.workspace.onLayoutReady(() => {
		// Files that arrived while Obsidian was closed came in with those startup
		// events, so look for them once. The index was built earlier in this
		// same layout-ready pass; anything it does not know yet is caught by
		// dedupe when the job hashes the file.
		if (opts.isEnabled()) {
			const folder = opts.watchedFolder().replace(/\/+$/, '');
			const root = folder ? plugin.app.vault.getAbstractFileByPath(folder) : plugin.app.vault.getRoot();
			if (root instanceof TFolder) {
				const missing = filesInFolder(root).filter((f) => inScope(f) && !opts.isIngested(f.path));
				if (missing.length > 0) opts.onBackfill(missing);
			}
		}

		plugin.registerEvent(
			plugin.app.vault.on('create', (file) => {
				if (inScope(file)) opts.onFile(file, 'created');
			}),
		);
		plugin.registerEvent(
			plugin.app.vault.on('modify', (file) => {
				if (!opts.reprocessOnModify() || !inScope(file)) return;
				const existing = pendingModify.get(file.path);
				if (existing !== undefined) window.clearTimeout(existing);
				pendingModify.set(
					file.path,
					window.setTimeout(() => {
						pendingModify.delete(file.path);
						// The file may have been renamed or deleted while quiet
						const current = plugin.app.vault.getAbstractFileByPath(file.path);
						if (current instanceof TFile && inScope(current)) opts.onFile(current, 'modified');
					}, MODIFY_QUIET_MS),
				);
			}),
		);
		plugin.registerEvent(
			plugin.app.vault.on('rename', (file, oldPath) => {
				// A rename or delete cancels a pending reprocess of the old path
				cancel(oldPath);
				// Moved in from elsewhere, e.g. a recording Obsidian saved in its attachment folder.
				// A moved folder reports each file inside it too, so folders need nothing of their own.
				// A file with a note was processed already; the note follows the move.
				if (movedIn(file, oldPath)) opts.onFile(file, 'moved');
			}),
		);
		plugin.registerEvent(plugin.app.vault.on('delete', (file) => cancel(file.path)));
	});

	function movedIn(file: TAbstractFile, oldPath: string): file is TFile {
		return inScope(file) && !inFolder(oldPath) && !opts.isIngested(oldPath) && !opts.isIngested(file.path);
	}

	function cancel(path: string): void {
		const timer = pendingModify.get(path);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		pendingModify.delete(path);
	}
}
