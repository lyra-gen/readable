import type { Plugin } from 'obsidian';
import type { IngestService } from '../core/ingest-service';
import type { UiActions } from './actions';
import { clearDevLog } from './dev-log';
import { openDevLog } from './log-modal';

/**
 * The command palette entries. Each calls into UiActions, the ingest service,
 * the AI commands from ai-commands.ts or the developer log and helpers main.ts
 * passes in, so no logic lives here. Developer
 * commands are always registered but offered only while developer mode is
 * on, so turning it on needs no reload.
 */

export interface CommandDeps {
	actions: UiActions;
	service: IngestService;
	isDevMode: () => boolean;
	/** Dev helpers that need plugin internals. */
	dev: { seedSampleJobs: () => void; clearBadges: () => void };
	ai: {
		/** Summaries, tags, titles for notes that lack them. */
		addMissing: () => void;
		/** The open note, regardless. */
		regenerateActive: () => void;
		stop: () => void;
	};
}

export function registerCommands(plugin: Plugin, deps: CommandDeps): void {
	const { actions, service } = deps;

	plugin.addCommand({ id: 'ingest-active-file', name: 'Ingest active file', callback: actions.ingestActiveFile });
	plugin.addCommand({
		id: 'ingest-note-attachments',
		name: 'Ingest attachments in active note',
		callback: actions.ingestNoteAttachments,
	});
	plugin.addCommand({ id: 'ingest-folder', name: 'Ingest folder', callback: actions.ingestFolder });
	plugin.addCommand({ id: 'open-queue', name: 'Open queue', callback: actions.openQueue });
	plugin.addCommand({ id: 'open-settings', name: 'Open settings', callback: actions.openSettings });
	plugin.addCommand({ id: 'pause', name: 'Pause', callback: () => service.pause() });
	plugin.addCommand({ id: 'resume', name: 'Resume', callback: () => service.resume() });
	plugin.addCommand({ id: 'retry-failed', name: 'Retry all failed', callback: () => service.retryAllFailed() });
	plugin.addCommand({ id: 'clear-finished', name: 'Clear finished jobs', callback: () => service.clearFinished() });
	plugin.addCommand({ id: 'ai-add-missing', name: 'Add AI content to notes that lack it', callback: deps.ai.addMissing });
	plugin.addCommand({ id: 'ai-regenerate-note', name: 'Regenerate AI content for this note', callback: deps.ai.regenerateActive });
	plugin.addCommand({ id: 'ai-stop', name: 'Stop adding AI content', callback: deps.ai.stop });

	// Developer mode only
	const devCommand = (id: string, name: string, run: () => void) =>
		plugin.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				if (!deps.isDevMode()) return false;
				if (!checking) run();
				return true;
			},
		});
	devCommand('open-dev-log', 'Open developer log', () => openDevLog(plugin.app));
	devCommand('clear-dev-log', 'Clear developer log', clearDevLog);
	devCommand('dev-seed-jobs', 'Dev: queue sample jobs', deps.dev.seedSampleJobs);
	devCommand('dev-clear-badges', 'Dev: clear session explorer marks', deps.dev.clearBadges);
}
