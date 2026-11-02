import { TFile } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { yamlScalar } from './frontmatter';
import type { IngestedIndex } from './ingested-index';

/**
 * When a source file is renamed or moved, its notes keep pointing at the old
 * path: `source` in the frontmatter and the embed. Fix both in place, which
 * keeps dedupe and the explorer marks right without extracting again.
 * Obsidian updates the embed itself when "Automatically update internal
 * links" is on, using text offsets it cached before the rename. Writing at
 * the same time corrupts the embed, so this waits for Obsidian to finish,
 * then fixes `source` and the embed only if it still names the old path.
 */

const AFTER_OBSIDIAN_MS = 2000;
export function followSourceRenames(plugin: Plugin, index: IngestedIndex): void {
	const app = plugin.app;
	plugin.registerEvent(
		app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile) || file.extension === 'md') return;
			// The index already covers the new path (it re-keys on the same event, in either order)
			const notes = [...new Set([...index.notesFor(oldPath), ...index.notesFor(file.path)])];
			if (notes.length === 0) return;
			window.setTimeout(() => {
				// The file's path now, in case it moved again while waiting
				Promise.all(notes.map((note) => retarget(app, note, oldPath, file.path))).catch((error) =>
					console.warn('Readable: could not update notes after rename', error),
				);
			}, AFTER_OBSIDIAN_MS);
		}),
	);
}

async function retarget(app: App, notePath: string, oldPath: string, newPath: string): Promise<void> {
	const note = app.vault.getAbstractFileByPath(notePath);
	if (!(note instanceof TFile)) return;
	const stale = new RegExp(`^source:\\s*${escapeRegExp(yamlScalar(oldPath))}\\s*$`, 'm');
	await app.vault.process(note, (content) =>
		content
			.replace(stale, `source: ${yamlScalar(newPath)}`)
			.split(`![[${oldPath}]]`)
			.join(`![[${newPath}]]`),
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
