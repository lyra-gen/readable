import { FuzzySuggestModal, TFolder } from 'obsidian';
import type { App } from 'obsidian';

export class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly onPick: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder('Pick a folder to ingest');
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(true);
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? '/' : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onPick(folder);
	}
}
