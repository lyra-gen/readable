import { Notice } from 'obsidian';
import { ENGINE_AUTH, jobName } from '../core/types';
import type { Job } from '../core/types';

/**
 * Notice rules:
 * - Short sentence, sentence case, ends with a period.
 * - Only for things the status bar and queue don't already show.
 * - Results arriving close together are merged into one notice.
 * - Failures always notify; successes respect the "Show notice when done" setting.
 */

export function notify(message: string): void {
	new Notice(message);
}

export interface Action {
	label: string;
	run: () => void;
}

export function noticeWithAction(message: string, action: Action | Action[], timeout = 8000): void {
	const frag = createFragment();
	frag.createSpan({ text: message });
	const actions = Array.isArray(action) ? action : [action];
	const buttons = actions.map((a) =>
		frag.createEl('a', {
			cls: 'readable-notice-action',
			text: a.label,
			attr: { role: 'button', tabindex: '0' },
		}),
	);
	const notice = new Notice(frag, timeout);
	buttons.forEach((btn, i) =>
		btn.addEventListener('click', (evt) => {
			evt.preventDefault();
			notice.hide();
			actions[i]?.run();
		}),
	);
}

export interface ResultHandlers {
	openQueue: () => void;
	openLog: (job: Job) => void;
	showDone: () => boolean;
	openSettings: () => void;
	openNote: (notePath?: string) => void;
	/** Docling is not installed, so the fix is to install it rather than to look at settings. */
	doclingMissing: () => boolean;
	installDocling: () => void;
}

const COALESCE_MS = 1500;

/** Ensures a trailing period, for messages built from error text. */
function sentence(text: string): string {
	const trimmed = text.trim();
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Collects job results and turns bursts into a single notice. */
export class ResultNotifier {
	private done: Job[] = [];
	private failed: Job[] = [];
	private timer: number | null = null;

	constructor(private readonly handlers: ResultHandlers) {}

	reportDone(job: Job): void {
		this.done.push(job);
		this.schedule();
	}

	reportFailed(job: Job): void {
		this.failed.push(job);
		this.schedule();
	}

	/** Shown at once and kept until dismissed: the queue is paused waiting on the user. */
	reportEngineUnavailable(job: Job): void {
		const action = this.handlers.doclingMissing()
			? { label: 'Install', run: () => this.handlers.installDocling() }
			: { label: 'Open settings', run: () => this.handlers.openSettings() };
		noticeWithAction(
			job.errorCode === ENGINE_AUTH ? 'Docling rejected the API key. Queue paused.' : `${sentence(job.error ?? 'Docling is unavailable')} Queue paused.`,
			action,
			0,
		);
	}

	dispose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.flush(), COALESCE_MS);
	}

	private flush(): void {
		this.timer = null;
		const done = this.done;
		const failed = this.failed;
		this.done = [];
		this.failed = [];

		const [firstFailed] = failed;
		if (failed.length === 1 && firstFailed) {
			noticeWithAction(`Couldn't process ${jobName(firstFailed)}.`, {
				label: 'View log',
				run: () => this.handlers.openLog(firstFailed),
			}, 0);
		} else if (failed.length > 1) {
			noticeWithAction(`${failed.length} files couldn't be processed.`, {
				label: 'Show queue',
				run: () => this.handlers.openQueue(),
			}, 0);
		}

		if (!this.handlers.showDone()) return;
		const [firstDone] = done;
		if (done.length === 1 && firstDone) {
			noticeWithAction(`${jobName(firstDone)} processed.`, {
				label: 'Open note',
				run: () => this.handlers.openNote(firstDone.notePath),
			});
		} else if (done.length > 1) {
			noticeWithAction(`${done.length} files processed.`, {
				label: 'Show queue',
				run: () => this.handlers.openQueue(),
			});
		}
	}
}
