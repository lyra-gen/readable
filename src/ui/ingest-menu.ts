import { Menu } from 'obsidian';
import type { UiActions } from './actions';

type IngestMenuActions = Pick<UiActions, 'ingestActiveFile' | 'ingestNoteAttachments' | 'ingestFolder' | 'openQueue'>;

/** Menu for the ribbon icon. */
export function buildIngestMenu(actions: IngestMenuActions): Menu {
	const menu = new Menu();
	menu.addItem((item) =>
		item.setTitle('Ingest active file').setIcon('file-text').onClick(actions.ingestActiveFile),
	);
	menu.addItem((item) =>
		item.setTitle('Ingest folder…').setIcon('folder').onClick(actions.ingestFolder),
	);
	menu.addItem((item) =>
		item
			.setTitle('Ingest attachments in active note')
			.setIcon('paperclip')
			.onClick(actions.ingestNoteAttachments),
	);
	menu.addSeparator();
	menu.addItem((item) => item.setTitle('Open queue').setIcon('list').onClick(actions.openQueue));
	return menu;
}
