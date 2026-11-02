import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { jobName } from '../core/types';
import type { Job, LogEntry } from '../core/types';
import type { IngestService } from '../core/ingest-service';
import { getDevLog } from './dev-log';
import { notify } from './notices';

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/** Shows a log (a job's, or the developer log) with a copy button. */
export class LogModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly state: string | null,
		private readonly entries: readonly LogEntry[],
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.modalEl.addClass('readable-log-modal');
		const { contentEl } = this;

		if (this.state !== null) {
			contentEl.createDiv({ cls: 'readable-log-meta', text: `State: ${this.state}` });
		}

		const list = contentEl.createDiv({ cls: 'readable-log' });
		if (this.entries.length === 0) {
			list.createDiv({ cls: 'readable-log-empty', text: 'No log entries yet.' });
		}
		for (const entry of this.entries) {
			const row = list.createDiv({ cls: `readable-log-row is-${entry.level}` });
			row.createSpan({ cls: 'readable-log-time', text: formatTime(entry.ts) });
			row.createSpan({ cls: 'readable-log-level', text: entry.level });
			row.createSpan({ cls: 'readable-log-message', text: entry.message });
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText('Copy log').onClick(() => {
					const text = this.entries
						.map((e) => `${formatTime(e.ts)} ${e.level.toUpperCase()} ${e.message}`)
						.join('\n');
					void navigator.clipboard.writeText(text).then(() => notify('Log copied.'));
				}),
			)
			.addButton((btn) => btn.setButtonText('Close').setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function openJobLog(app: App, service: IngestService, job: Job): void {
	new LogModal(app, jobName(job), job.state, service.getLog(job.id)).open();
}

export function openDevLog(app: App): void {
	new LogModal(app, 'Developer log', null, [...getDevLog()]).open();
}
