import { normalizePath } from 'obsidian';
import { parentOf, stemOf } from './vault-paths';

export const NOTE_LOCATIONS = ['folder', 'beside', 'subfolder'] as const;
export type NoteLocation = (typeof NOTE_LOCATIONS)[number];

export interface LocationSettings {
	noteLocation: NoteLocation;
	outputFolder: string;
	subfolderName: string;
}

function join(...parts: string[]): string {
	return normalizePath(parts.filter((p) => p !== '').join('/'));
}

/**
 * Where the note for a source file goes. Collisions are resolved by the
 * writer (short hash suffix); this only picks the folder and base name.
 */
export function resolveNotePath(sourcePath: string, s: LocationSettings): string {
	const parent = parentOf(sourcePath);
	const stem = stemOf(sourcePath);
	switch (s.noteLocation) {
		case 'beside':
			return join(parent, `${stem}.md`);
		case 'subfolder':
			return join(parent, s.subfolderName, `${stem}.md`);
		case 'folder':
			return join(s.outputFolder, `${stem}.md`);
	}
}
