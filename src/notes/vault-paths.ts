import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';

/** The folder part of a vault path; `''` at the vault root. */
export function parentOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

/**
 * Characters Obsidian refuses in a new file name on any platform. A source
 * file can still carry them: macOS stores a Finder "/" as ":" and allows "\\",
 * and Obsidian lists such files but will not create a note named after them.
 */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|]+/g;

/** `name` with characters Obsidian cannot write replaced by a dash. */
export function safeFileName(name: string): string {
	const safe = name.replace(UNSAFE_NAME_CHARS, '-').replace(/\s+/g, ' ').trim();
	return safe === '' ? 'untitled' : safe;
}

/**
 * The last path segment without its extension, made safe to name a new file
 * after. Only used to build names for notes and figures, never to look up the
 * source itself.
 */
export function stemOf(path: string): string {
	return safeFileName((path.split('/').pop() ?? path).replace(/\.[^.]+$/, ''));
}

/** Creates `folder` and any missing parents. */
export async function ensureFolder(app: App, folder: string): Promise<void> {
	if (folder === '' || folder === '/') return;
	const existing = app.vault.getAbstractFileByPath(folder);
	if (existing instanceof TFolder) return;
	if (existing instanceof TFile) throw new Error(`Cannot create folder "${folder}": a file with that name exists`);
	await ensureFolder(app, parentOf(folder));
	try {
		await app.vault.createFolder(folder);
	} catch (error) {
		// A parallel job may have created it between the check and the call
		if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error;
	}
}
