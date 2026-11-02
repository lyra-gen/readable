import { ConfirmationModal } from 'obsidian';
import type { App } from 'obsidian';
import { LLAMA_STEP_LABELS } from '../llm/builtin/installer';
import { recommendedForThisComputer } from '../llm/builtin/manager';
import type { LlamaState, ManagedLlama } from '../llm/builtin/manager';
import type { LocalModel } from '../llm/builtin/catalog';
import { sizeLabel } from '../llm/builtin/catalog';
import { downloadGB } from '../llm/builtin/release';
import { runWithProgress } from './docling-install';
import type { InstallSource } from './docling-install';
import { notify } from './notices';

/**
 * The user-facing side of Readable's own AI server, as docling-install is
 * for Docling: the status line for its settings row, a confirmation before
 * installing, removing the server with every model, or deleting one
 * downloaded model, and the install's progress notice through
 * runWithProgress. ManagedLlama does the work.
 */

function stepLabel(state: Extract<LlamaState, { kind: 'installing' }>): string {
	return `${LLAMA_STEP_LABELS[state.step]}…${state.detail ? ` ${state.detail}` : ''}`;
}

/** One line for the Readable's AI row. */
export function describeLlama(llama: ManagedLlama): string {
	const state = llama.installState;
	const rec = recommendedForThisComputer();
	switch (state.kind) {
		case 'checking':
			return 'Checking…';
		case 'missing':
			return `Downloads the AI and ${rec.name}, the best model for this computer: ${downloadGB(rec)} GB.`;
		case 'installing':
			return stepLabel(state);
		case 'failed':
			return `Install failed: ${state.message}`;
		case 'outdated':
			return 'Installed. An update to the AI server is available.';
		case 'installed':
			return llama.server.running ? `Ready. ${llama.server.loadedModel?.id ?? 'A model'} is loaded now.` : 'Ready. A model loads when a note needs it.';
	}
}

function source(llama: ManagedLlama): InstallSource {
	return {
		onChange: (l) => llama.onChange(l),
		progress: () => (llama.installState.kind === 'installing' ? stepLabel(llama.installState) : null),
		failure: () => (llama.installState.kind === 'failed' ? llama.installState.message : null),
	};
}

/** Asks first, then installs with a progress notice. */
export function confirmAndInstallLlama(app: App, llama: ManagedLlama, onReady: () => void): void {
	const update = llama.installState.kind === 'outdated';
	const rec = recommendedForThisComputer();
	const modal = new ConfirmationModal(app);
	modal.setTitle(update ? "Update Readable's AI?" : "Install Readable's AI?");
	modal.setContent(
		createFragment((frag) => {
			frag.createEl('p', {
				text: update
					? `Readable will download the new AI server into ${llama.paths.root}. Your models stay.`
					: `Readable will download its AI server and ${rec.name}, ${downloadGB(rec)} GB, into ${llama.paths.root}. Other models can be added under Models.`,
			});
			frag.createEl('p', { text: 'It runs only on this computer, starts when a note needs it and stops when idle.' });
		}),
	);
	modal.addButton((btn) =>
		btn
			.setButtonText(update ? 'Update' : 'Install')
			.setCta()
			.onClick(() => void runLlamaInstall(llama, onReady)),
	);
	modal.addCancelButton();
	modal.open();
}

function runLlamaInstall(llama: ManagedLlama, onReady: () => void): Promise<void> {
	return runWithProgress(source(llama), onReady, {
		start: "Installing Readable's AI…",
		prefix: "Readable's AI: ",
		run: () => llama.install(),
		done: "Readable's AI is ready.",
		failedPrefix: "Couldn't install Readable's AI.",
		retry: () => void runLlamaInstall(llama, onReady),
	});
}

/** Asks first, then deletes the server and every downloaded model. */
export function confirmAndRemoveLlama(app: App, llama: ManagedLlama): void {
	const modal = new ConfirmationModal(app);
	modal.setTitle("Remove Readable's AI?");
	modal.setContent(
		createFragment((frag) =>
			frag.createEl('p', { text: `This deletes the AI server and every model downloaded into ${llama.paths.root}. Models in your own folder and your notes are not affected.` }),
		),
	);
	modal.addButton((btn) =>
		btn
			.setButtonText('Remove')
			.setDestructive()
			.setCta()
			.onClick(() => {
				void llama.remove().then(
					() => notify("Readable's AI removed."),
					(error: unknown) => notify(`Couldn't remove Readable's AI. ${error instanceof Error ? error.message : ''}`),
				);
			}),
	);
	modal.addCancelButton();
	modal.open();
}

/** Asks first, then deletes one downloaded model to free disk space. */
export function confirmAndDeleteModel(app: App, llama: ManagedLlama, model: LocalModel, name: string, onDeleted: () => void): void {
	const modal = new ConfirmationModal(app);
	modal.setTitle(`Delete ${name}?`);
	modal.setContent(createFragment((frag) => frag.createEl('p', { text: `This frees ${sizeLabel(model.bytes)}. You can download it again at any time.` })));
	modal.addButton((btn) =>
		btn
			.setButtonText('Delete')
			.setDestructive()
			.setCta()
			.onClick(() => {
				void llama.deleteModel(model).then(
					() => {
						notify(`${name} deleted.`);
						onDeleted();
					},
					(error: unknown) => notify(`Couldn't delete ${name}. ${error instanceof Error ? error.message : ''}`),
				);
			}),
	);
	modal.addCancelButton();
	modal.open();
}
