import { promises as fs } from 'fs';
import * as path from 'path';
import { CATALOG } from './release';

/**
 * Finds the GGUF files the built-in server can load, in Readable's models
 * folder and the user's extra one, so models from LM Studio or Hugging Face
 * work without a download. A file in a catalog model's folder with the
 * catalog's file name is that catalog model; any other takes its file name
 * as id. Only the first part of a split model counts.
 */

/** A GGUF model the built-in server can load. */
export interface LocalModel {
	/** What settings store and notes record as `model`: the catalog id for a catalog model, else the file name without `.gguf`. */
	id: string;
	/** Set for a model downloaded from the catalog. */
	catalog?: string;
	path: string;
	bytes: number;
	/** The vision projector beside it, when there is one: the model can then describe pictures. */
	projector: string | null;
}

/** LM Studio and Hugging Face downloads nest a folder or two deep (publisher/model/file). */
const MAX_DEPTH = 4;
/** Split models: only the first part is loadable, and it pulls in the rest. */
const SPLIT_PART = /-(\d{5})-of-\d{5}\.gguf$/i;

/**
 * Every model in these folders, the first folder winning on a repeated id.
 * A model's projector is an `mmproj*.gguf` in the same folder; projectors
 * themselves are not models. Unreadable folders are skipped.
 */
export async function scanModels(folders: string[]): Promise<LocalModel[]> {
	const found = new Map<string, LocalModel>();
	for (const folder of folders) {
		for (const model of await scanFolder(folder, 0)) {
			if (!found.has(model.id)) found.set(model.id, model);
		}
	}
	return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function scanFolder(dir: string, depth: number): Promise<LocalModel[]> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const ggufs = entries.filter((e) => e.isFile() && /\.gguf$/i.test(e.name));
	const projectors = ggufs.filter((e) => /^mmproj/i.test(e.name)).map((e) => e.name);
	const catalog = CATALOG.find((c) => c.id === path.basename(dir));
	const models: LocalModel[] = [];
	for (const entry of ggufs) {
		if (/^mmproj/i.test(entry.name)) continue;
		const split = SPLIT_PART.exec(entry.name);
		if (split && split[1] !== '00001') continue;
		const file = path.join(dir, entry.name);
		const bytes = await fs.stat(file).then((s) => s.size, () => 0);
		const fromCatalog = catalog && entry.name === catalog.weights.name ? catalog : undefined;
		const projector = pairProjector(entry.name, projectors);
		models.push({
			id: fromCatalog ? fromCatalog.id : entry.name.replace(SPLIT_PART, '').replace(/\.gguf$/i, ''),
			...(fromCatalog ? { catalog: fromCatalog.id } : {}),
			path: file,
			bytes,
			projector: projector ? path.join(dir, projector) : null,
		});
	}
	if (depth < MAX_DEPTH) {
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.startsWith('.')) models.push(...(await scanFolder(path.join(dir, entry.name), depth + 1)));
		}
	}
	return models;
}

/**
 * The vision part for a model file: the only one in its folder, or, when a
 * folder holds several, the one sharing the longest name prefix with it.
 */
function pairProjector(model: string, projectors: string[]): string | null {
	if (projectors.length <= 1) return projectors[0] ?? null;
	const stem = model.toLowerCase().replace(/\.gguf$/, '');
	let best: string | null = null;
	let bestScore = 0;
	for (const p of projectors) {
		const name = p.toLowerCase().replace(/^mmproj[-_]?/, '');
		let score = 0;
		while (score < name.length && score < stem.length && name[score] === stem[score]) score++;
		if (score > bestScore) {
			best = p;
			bestScore = score;
		}
	}
	return bestScore >= 4 ? best : null;
}

/** "2.3 GB" for a settings label. */
export function sizeLabel(bytes: number): string {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
