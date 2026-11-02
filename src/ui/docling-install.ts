import { ConfirmationModal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { STEP_LABELS } from '../extract/docling/managed/installer';
import type { AddonId, InstallStep } from '../extract/docling/managed/installer';
import type { InstallState, ManagedDocling } from '../extract/docling/managed/manager';
import { noticeWithAction, notify } from './notices';

/**
 * The user-facing side of installing Docling and its add-ons (speech, Apple
 * Vision OCR, RapidOCR, OpenDocument): the one-line status the settings rows
 * show, a confirmation before anything is downloaded or deleted, and a
 * progress notice that follows the install step by step. ManagedDocling does
 * the work. runWithProgress is shared with Readable's AI install; a
 * cancelled install ends quietly, a failed one offers Try again.
 */

/** Approximate disk use after install: Python, Docling with torch, models. */
const INSTALL_SIZE = 'about 2 GB';

type Installing = Extract<InstallState, { kind: 'installing' }>;

/** The current install step, with uv's latest summary line when there is one. */
function stepLabel(state: Installing): string {
	return `${STEP_LABELS[state.step]}…${state.detail ? ` ${state.detail}` : ''}`;
}

/** One line for the settings row and the progress notice. */
export function describeInstall(state: InstallState, running: boolean): string {
	switch (state.kind) {
		case 'checking':
			return 'Checking…';
		case 'missing':
			return `Not installed. Readable downloads Python and Docling (${INSTALL_SIZE}) and runs them for you.`;
		case 'installing':
			return stepLabel(state);
		case 'failed':
			return `Install failed: ${state.message}`;
		case 'outdated':
			return `Docling ${state.manifest.docling} installed. An update is available.`;
		case 'installed':
			return `Docling ${state.manifest.docling} installed. ${running ? 'Running.' : 'Starts when a file needs it.'}`;
	}
}

export interface AddonInfo {
	name: string;
	/** What gets installed, for the confirm dialog and the row. */
	what: string;
	/** Approximate extra disk use. */
	size: string;
	steps: InstallStep[];
}

export const ADDON_INFO: Record<AddonId, AddonInfo> = {
	speech: { name: 'the speech add-on', what: 'Whisper and ffmpeg', size: 'about 2 GB', steps: ['speech', 'speech-model'] },
	ocrmac: { name: 'Apple Vision OCR', what: "Apple's text recognition, which ships with macOS", size: 'about 30 MB', steps: ['ocr', 'ocr-model'] },
	rapidocr: { name: 'RapidOCR', what: 'the RapidOCR engine and a model for each OCR language', size: 'about 100 MB', steps: ['ocr', 'ocr-model'] },
	// Part of every install; older installs get it from Update
	opendocument: { name: 'OpenDocument support', what: 'the reader for .odt, .ods and .odp files', size: 'under 1 MB', steps: ['docling'] },
};

/** One line for an add-on's row. */
export function describeAddon(managed: ManagedDocling, addon: AddonId): string {
	const info = ADDON_INFO[addon];
	const state = managed.installState;
	if (state.kind === 'installing' && info.steps.includes(state.step)) return stepLabel(state);
	if (!managed.ready) return 'Install Docling first.';
	if (managed.addonInstalled(addon)) return `Installed: ${info.what}. Runs on this machine.`;
	return `Not installed. Adds ${info.what} to Docling (${info.size}).`;
}

/** Asks first, then deletes everything Readable installed. */
export function confirmAndRemove(app: App, managed: ManagedDocling): void {
	const speech = managed.speechInstalled;
	const modal = new ConfirmationModal(app);
	modal.setTitle('Remove Docling?');
	modal.setContent(
		createFragment((frag) => {
			frag.createEl('p', {
				text: `This deletes Docling${speech ? ', the speech add-on' : ''} and its models from ${managed.paths.root}. Your notes are not affected.`,
			});
			frag.createEl('p', { text: 'Files queued while Docling is missing wait until it is installed again.' });
		}),
	);
	modal.addButton((btn) =>
		btn
			.setButtonText('Remove')
			.setDestructive()
			.setCta()
			.onClick(() => {
				void managed.remove().then(
					() => notify('Docling removed.'),
					(error: unknown) => notify(`Couldn't remove Docling. ${error instanceof Error ? error.message : ''}`),
				);
			}),
	);
	modal.addCancelButton();
	modal.open();
}

/**
 * Asks first, then installs an add-on with a progress notice. `params` go to
 * the sidecar's model download (the OCR languages to prefetch, for RapidOCR).
 */
export function confirmAndInstallAddon(app: App, managed: ManagedDocling, addon: AddonId, onReady: () => void, params: Record<string, unknown> = {}): void {
	const info = ADDON_INFO[addon];
	const modal = new ConfirmationModal(app);
	modal.setTitle(`Install ${info.name}?`);
	modal.setContent(
		createFragment((frag) => {
			frag.createEl('p', {
				text: `Readable will add ${info.what} to its Docling install, ${info.size}, in ${managed.paths.root}. It then runs on this machine.`,
			});
		}),
	);
	modal.addButton((btn) =>
		btn
			.setButtonText('Install')
			.setCta()
			.onClick(() => void runAddonInstall(managed, addon, onReady, params)),
	);
	modal.addCancelButton();
	modal.open();
}

/** The speech add-on's confirm and install. */
export function confirmAndInstallSpeech(app: App, managed: ManagedDocling, onReady: () => void): void {
	confirmAndInstallAddon(app, managed, 'speech', onReady);
}

function runAddonInstall(managed: ManagedDocling, addon: AddonId, onReady: () => void, params: Record<string, unknown>): Promise<void> {
	const info = ADDON_INFO[addon];
	const title = info.name.charAt(0).toUpperCase() + info.name.slice(1);
	return runWithProgress(installing(managed), onReady, {
		start: `Installing ${info.name}…`,
		prefix: `${title}: `,
		run: () => managed.installAddon(addon, params),
		done: `${title} ready.`,
		failedPrefix: `Couldn't install ${info.name}.`,
		retry: () => void runAddonInstall(managed, addon, onReady, params),
	});
}

/** Asks first, then installs with a progress notice. `onReady` runs once Docling is usable. */
export function confirmAndInstall(app: App, managed: ManagedDocling, onReady: () => void): void {
	const update = managed.installState.kind === 'outdated';
	const modal = new ConfirmationModal(app);
	modal.setTitle(update ? 'Update Docling?' : 'Install Docling?');
	modal.setContent(
		createFragment((frag) => {
			frag.createEl('p', {
				text: `Readable will download Python and Docling, ${INSTALL_SIZE}, into ${managed.paths.root}. It takes a few minutes on a fast connection.`,
			});
			frag.createEl('p', {
				text: 'Nothing is installed outside that folder, and removing Docling deletes it.',
			});
		}),
	);
	modal.addButton((btn) =>
		btn
			.setButtonText(update ? 'Update' : 'Install')
			.setCta()
			.onClick(() => void runInstall(managed, onReady)),
	);
	modal.addCancelButton();
	modal.open();
}

function runInstall(managed: ManagedDocling, onReady: () => void): Promise<void> {
	return runWithProgress(installing(managed), onReady, {
		start: 'Installing Docling…',
		prefix: 'Installing Docling: ',
		run: () => managed.install(),
		done: 'Docling is ready.',
		failedPrefix: "Couldn't install Docling.",
		retry: () => void runInstall(managed, onReady),
	});
}

/** What a progress notice follows: the current step label while installing, or null; 'failed' with a message; anything else. */
export interface InstallSource {
	onChange(listener: () => void): () => void;
	/** The current step label while installing, else null. */
	progress(): string | null;
	/** The failure message, or null when the last run did not fail. */
	failure(): string | null;
}

function installing(managed: ManagedDocling): InstallSource {
	return {
		onChange: (l) => managed.onChange(l),
		progress: () => (managed.installState.kind === 'installing' ? stepLabel(managed.installState) : null),
		failure: () => (managed.installState.kind === 'failed' ? managed.installState.message : null),
	};
}

export interface ProgressRun {
	/** The notice text before the first step. */
	start: string;
	/** Put before each step label. */
	prefix: string;
	/** Resolves true when done. */
	run: () => Promise<boolean>;
	done: string;
	/** Put before the failure message. */
	failedPrefix: string;
	retry: () => void;
}

/** Runs an install with a progress notice; offers "Try again" on failure, and stays quiet on cancel. */
export async function runWithProgress(source: InstallSource, onReady: () => void, opts: ProgressRun): Promise<void> {
	const notice = new Notice(opts.start, 0);
	const unsubscribe = source.onChange(() => {
		const label = source.progress();
		if (label) notice.setMessage(`${opts.prefix}${label}`);
	});
	const ok = await opts.run();
	unsubscribe();
	notice.hide();
	if (ok) {
		notify(opts.done);
		onReady();
		return;
	}
	const failure = source.failure();
	if (failure === null) return; // cancelled
	noticeWithAction(`${opts.failedPrefix} ${failure}`, { label: 'Try again', run: opts.retry }, 0);
}
