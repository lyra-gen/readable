import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { EnrichTarget } from '../llm/enrich';
import { enrichNotes } from '../llm/enrich-notes';
import type { EnrichRun } from '../llm/enrich-notes';
import type { IngestedIndex } from '../notes/ingested-index';
import type { CommandDeps } from './commands';
import { notify } from './notices';

/** The AI commands: add missing content, regenerate the open note, stop. One run at a time. */
export function createAiCommands(app: App, ingested: IngestedIndex, getTarget: () => EnrichTarget | null): CommandDeps['ai'] {
	let enrichRun: EnrichRun | null = null;

	/** Summaries, tags and titles for existing notes, one at a time, with a progress notice. */
	const runEnrichment = (notes: string[], onlyMissing: boolean): void => {
		if (enrichRun) return notify('Already adding AI content. Use "Stop adding AI content" first.');
		const target = getTarget();
		if (!target) return notify('Turn on Summaries, Tags or Title and choose a model under Settings → Readable → AI.');
		if (notes.length === 0) return notify('No Readable notes found.');
		const notice = new Notice('', 0);
		const run = enrichNotes(app, target, notes, onlyMissing, (i, total, name) =>
			notice.setMessage(`AI content ${i + 1}/${total}: ${name}`),
		);
		enrichRun = run;
		void run.done.then((result) => {
			notice.hide();
			enrichRun = null;
			const parts = [`${result.changed} updated`, result.skipped ? `${result.skipped} skipped` : '', result.failed ? `${result.failed} failed` : ''].filter(Boolean);
			notify(`AI content: ${parts.join(', ')}.`);
		});
	};

	return {
		addMissing: () => runEnrichment(ingested.allNotes(), true),
		regenerateActive: () => {
			const file = app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') return notify('Open a Readable note first.');
			if (!ingested.allNotes().includes(file.path)) return notify('This is not a Readable note.');
			runEnrichment([file.path], false);
		},
		stop: () => {
			if (!enrichRun) return notify('Nothing is running.');
			enrichRun.cancel();
		},
	};
}
