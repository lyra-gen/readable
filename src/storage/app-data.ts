import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { FileSystemAdapter } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Readable's per-user folder outside any vault. Holds what belongs to this
 * machine rather than to the notes: managed Docling, and each vault's queue.
 * Nothing here syncs, and nothing here is the record of what was ingested;
 * the notes are.
 */
export function appDataRoot(): string {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'Readable');
		case 'win32':
			return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Readable');
		default:
			return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'readable');
	}
}

/**
 * This vault's folder under app data: `vaults/<id>`. The id is Obsidian's own
 * per-vault id, which survives moving the vault; a hash of the vault path
 * stands in if it is ever missing.
 */
export function vaultDataDir(app: App): string {
	const appId = (app as unknown as { appId?: unknown }).appId;
	let id = typeof appId === 'string' && /^[\w-]+$/.test(appId) ? appId : '';
	if (!id) {
		const adapter = app.vault.adapter;
		const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : app.vault.getName();
		id = createHash('sha256').update(base).digest('hex').slice(0, 16);
	}
	return path.join(appDataRoot(), 'vaults', id);
}

