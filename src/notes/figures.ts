import { fileTypeFromBuffer } from 'file-type';
import { promises as fs } from 'fs';
import * as nodePath from 'path';
import { TFile, TFolder, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import { ensureFolder, parentOf, stemOf } from './vault-paths';
import type { FigureLocation } from '../settings/model';

/**
 * Pictures Docling found in a document arrive as image links in the
 * Markdown, pointing at temporary files the sidecar wrote. Each becomes an
 * attachment in the vault, next to the note or in Obsidian's attachment
 * folder (optionally in a `<file>-figures` folder), named
 * `<file>-figure-<n>.png`, and the link becomes an embed. Figures from an
 * earlier run of the same file are replaced.
 *
 * Only files inside the extractor's own figures folder are taken, and only
 * when their bytes are an image: the Markdown also carries whatever the
 * document said, and a document that says `![x](/home/me/.ssh/id_rsa)` must
 * not get that file copied into the vault. Every other image link, local or
 * remote, becomes a plain link so Obsidian does not fetch or embed it.
 */

export interface FigureSettings {
	location: FigureLocation;
	/** Each document's figures in their own folder. */
	group: boolean;
}

const IMAGE_LINK = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Image formats Obsidian embeds; anything else is not a figure. */
const IMAGE_EXT = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'avif', 'svg']);

export interface FigureResult {
	markdown: string;
	count: number;
}

export async function saveFigures(
	app: App,
	markdown: string,
	sourcePath: string,
	/** The note the figures belong to; decides the folder. */
	notePath: string,
	settings: FigureSettings,
	/** The folder the extractor wrote its figures to; null when it wrote none, so no link is a figure. */
	figuresDir: string | null,
): Promise<FigureResult> {
	const stem = stemOf(sourcePath);
	const links = [...markdown.matchAll(IMAGE_LINK)];
	if (links.length === 0) return { markdown, count: 0 };
	if (!figuresDir) return { markdown: neutraliseImageLinks(markdown), count: 0 };

	const base = await figureBase(app, stem, notePath, settings);
	const dir = figureDir(base, stem, settings.group);
	await removeOldFigures(app, stem, dir);
	// Earlier versions grouped figures in a folder named just like the document
	const legacy = figureDir(base, stem, settings.group, LEGACY_SUFFIX);
	if (legacy !== dir) await removeOldFigures(app, stem, legacy, true);
	await ensureFolder(app, dir);
	let count = 0;
	let out = '';
	let last = 0;
	for (const match of links) {
		const [whole, , target] = match;
		const at = match.index ?? 0;
		const image = await readImage(target ?? '', figuresDir);
		out += markdown.slice(last, at);
		last = at + whole.length;
		if (!image) {
			out += neutraliseImageLinks(whole);
			continue;
		}
		count += 1;
		const path = normalizePath(`${dir}/${stem}-figure-${count}.${image.ext}`);
		await app.vault.createBinary(path, image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength) as ArrayBuffer);
		out += `![[${path}]]`;
	}
	out += markdown.slice(last);
	return { markdown: out, count };
}

/** A link's bytes when it points at an image file inside `figuresDir`; null for anything else. */
async function readImage(target: string, figuresDir: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
	let file: string;
	try {
		file = decodeURIComponent(target);
	} catch {
		file = target;
	}
	if (!isInside(file, figuresDir)) return null;
	try {
		const bytes = new Uint8Array(await fs.readFile(file));
		const kind = await fileTypeFromBuffer(bytes);
		// SVG is text and has no magic bytes; it is never something Docling writes, so it is not accepted blind
		const ext = kind?.ext.toLowerCase();
		if (!ext || !IMAGE_EXT.has(ext)) return null;
		return { bytes, ext };
	} catch {
		return null;
	}
}

/** True when `file` is an absolute path under `dir` (after resolving `..`), not `dir` itself. */
export function isInside(file: string, dir: string): boolean {
	if (!nodePath.isAbsolute(file)) return false;
	const relative = nodePath.relative(nodePath.resolve(dir), nodePath.resolve(file));
	return relative !== '' && !relative.startsWith('..') && !nodePath.isAbsolute(relative);
}

/**
 * `![alt](target)` → `[alt](target)`: the document's own image links, local
 * paths or remote URLs, are kept as text but never embedded, so opening the
 * note neither reads a local file nor fetches from a server.
 */
export function neutraliseImageLinks(markdown: string): string {
	return markdown.replace(IMAGE_LINK, (_whole, alt: string, target: string) => `[${alt}](${target})`);
}

/** The folder figures go under: the note's folder, or Obsidian's attachment folder for the note. */
async function figureBase(app: App, stem: string, notePath: string, settings: FigureSettings): Promise<string> {
	if (settings.location === 'note') return parentOf(notePath);
	// Ask Obsidian where an attachment for this note would go; only the folder part is used
	const probe = await app.fileManager.getAvailablePathForAttachment(`${stem}-figure-1.png`, notePath);
	return parentOf(probe);
}

const FIGURES_SUFFIX = '-figures';
const LEGACY_SUFFIX = '';

/**
 * The folder under `base` (the vault root when empty): `<stem>-figures` when
 * grouping, so it is not mistaken for the note or the document, else `base` itself.
 */
export function figureDir(base: string, stem: string, group: boolean, suffix = FIGURES_SUFFIX): string {
	const name = `${stem}${suffix}`;
	return normalizePath(group ? (base ? `${base}/${name}` : name) : base || '/');
}

/**
 * Deletes `<stem>-figure-<n>.*` from the figure folder, so a reprocess does
 * not pile up copies; with `dropEmpty`, also the folder once nothing is left in it.
 */
async function removeOldFigures(app: App, stem: string, dir: string, dropEmpty = false): Promise<void> {
	const folder = app.vault.getAbstractFileByPath(dir);
	if (!(folder instanceof TFolder)) return;
	for (const child of [...folder.children]) {
		if (child instanceof TFile && isFigureOf(stem, child.name)) await app.fileManager.trashFile(child);
	}
	if (dropEmpty && folder.children.length === 0) await app.fileManager.trashFile(folder);
}

/** Whether `name` is `<stem>-figure-<n>.<ext>`, a figure Readable saved for this document. */
export function isFigureOf(stem: string, name: string): boolean {
	const prefix = `${stem}-figure-`;
	if (!name.startsWith(prefix)) return false;
	const rest = name.slice(prefix.length);
	const dot = rest.lastIndexOf('.');
	return /^\d+$/.test(dot === -1 ? rest : rest.slice(0, dot));
}
