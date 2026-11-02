import { TFile, TFolder } from 'obsidian';
import type { App, CachedMetadata, TAbstractFile } from 'obsidian';

/** Resolves what the user pointed at into vault-relative file paths. Pure lookups, no side effects. */

/** Office lock files (`~$report.docx`), editor temp files, and hidden files. */
const TRANSIENT = /^(~\$|\.|.*\.(tmp|part|crdownload|download)$)/i;
/** Figures Readable saved from a document (`report-figure-3.png`); ingesting them would loop. */
const OUR_FIGURE = /-figure-\d+\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

export function isIngestable(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension !== 'md' && !TRANSIENT.test(file.name) && !OUR_FIGURE.test(file.name);
}

export function filesInFolder(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) walk(child);
			else if (isIngestable(child)) out.push(child);
		}
	};
	walk(folder);
	return out;
}

/** Non-markdown files embedded in a note. */
export function attachmentsOf(app: App, note: TFile, cache: CachedMetadata | null = app.metadataCache.getFileCache(note)): TFile[] {
	const embeds = cache?.embeds ?? [];
	const seen = new Set<string>();
	const files: TFile[] = [];
	for (const embed of embeds) {
		const target = app.metadataCache.getFirstLinkpathDest(embed.link, note.path);
		if (target && isIngestable(target) && !seen.has(target.path)) {
			seen.add(target.path);
			files.push(target);
		}
	}
	return files;
}

/** Expands a mixed selection of files and folders. */
export function expandSelection(items: TAbstractFile[]): TFile[] {
	const seen = new Set<string>();
	const files: TFile[] = [];
	const add = (f: TFile) => {
		if (!seen.has(f.path)) {
			seen.add(f.path);
			files.push(f);
		}
	};
	for (const item of items) {
		if (item instanceof TFolder) filesInFolder(item).forEach(add);
		else if (isIngestable(item)) add(item);
	}
	return files;
}
