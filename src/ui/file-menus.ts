import { TFile } from 'obsidian';
import type { Plugin, TAbstractFile } from 'obsidian';
import type { Job } from '../core/types';
import { attachmentsOf, expandSelection } from '../ingest/targets';
import { openNote, showInQueue } from './workspace';

export interface FileMenuDeps {
	/** Queues the files, or shows emptyMessage when there are none. */
	ingest: (files: TFile[], emptyMessage: string) => void;
	/** Readable notes for a file, from the notes' own frontmatter. */
	notesFor: (path: string) => readonly string[];
	/** The file's newest queue job, if it has one. */
	jobFor: (path: string) => Job | undefined;
	/** Don't process these files, or process them again. */
	exclude: (paths: string[]) => void;
	include: (jobIds: string[]) => void;
}

/** Right-click entries in the file explorer. */
export function registerFileMenus(plugin: Plugin, deps: FileMenuDeps): void {
	const noFiles = (what: string) => `${what} has no files to process.`;
	const ingestItems = (items: TAbstractFile[], label: string) => deps.ingest(expandSelection(items), noFiles(label));

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFile && file.extension === 'md') {
				menu.addItem((item) =>
					item
						.setTitle('Ingest attachments with Readable')
						.setIcon('paperclip')
						.onClick(() => deps.ingest(attachmentsOf(plugin.app, file), noFiles(file.basename))),
				);
				return;
			}
			menu.addItem((item) =>
				item
					.setTitle('Ingest with Readable')
					.setIcon('file-input')
					.onClick(() => ingestItems([file], file.name)),
			);
			const [note] = deps.notesFor(file.path);
			if (note) {
				menu.addItem((item) =>
					item
						.setTitle('Open Readable note')
						.setIcon('file-text')
						.onClick(() => openNote(plugin.app, note)),
				);
			}
			const job = deps.jobFor(file.path);
			if (job?.state === 'excluded') {
				menu.addItem((item) =>
					item
						.setTitle('Process with Readable again')
						.setIcon('rotate-ccw')
						.onClick(() => deps.include([job.id])),
				);
			} else {
				menu.addItem((item) =>
					item
						.setTitle("Don't process with Readable")
						.setIcon('circle-off')
						.onClick(() => deps.exclude([file.path])),
				);
			}
			if (job) {
				menu.addItem((item) =>
					item
						.setTitle('Show in Readable queue')
						.setIcon('list')
						.onClick(() => void showInQueue(plugin.app, job.id)),
				);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on('files-menu', (menu, files) => {
			menu.addItem((item) =>
				item
					.setTitle(`Ingest ${files.length} items with Readable`)
					.setIcon('file-input')
					.onClick(() => ingestItems(files, 'selection')),
			);
			menu.addItem((item) =>
				item
					.setTitle(`Don't process ${files.length} items with Readable`)
					.setIcon('circle-off')
					.onClick(() => deps.exclude(expandSelection(files).map((f) => f.path))),
			);
		}),
	);
}
