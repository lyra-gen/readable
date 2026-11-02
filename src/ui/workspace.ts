import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { notify } from './notices';

/**
 * Opening things in the workspace. Imports only notices from the UI, so the
 * queue view can use it without an import cycle.
 */

export const QUEUE_VIEW_TYPE = 'readable-queue';

/** Opens Obsidian settings on Readable's tab. */
export function openSettings(app: App, pluginId: string): void {
	const setting = (app as unknown as {
		setting?: { open: () => void; openTabById: (id: string) => unknown };
	}).setting;
	if (!setting) return notify('Open Settings, then Readable.');
	setting.open();
	setting.openTabById(pluginId);
}

export async function openQueue(app: App): Promise<void> {
	const existing = app.workspace.getLeavesOfType(QUEUE_VIEW_TYPE)[0];
	if (existing) return app.workspace.revealLeaf(existing);
	const leaf = app.workspace.getRightLeaf(false);
	if (!leaf) return;
	await leaf.setViewState({ type: QUEUE_VIEW_TYPE, active: true });
	await app.workspace.revealLeaf(leaf);
}

/** Opens the queue panel with a job's row selected. */
export async function showInQueue(app: App, jobId: string): Promise<void> {
	await openQueue(app);
	// Typed loosely: importing the view here would make an import cycle
	const view = app.workspace.getLeavesOfType(QUEUE_VIEW_TYPE)[0]?.view as { reveal?: (id: string) => void } | undefined;
	view?.reveal?.(jobId);
}

/** Opens a note in the current tab, or says it is gone. */
export function openNote(app: App, notePath?: string): void {
	const file = notePath ? app.vault.getAbstractFileByPath(notePath) : null;
	if (file instanceof TFile) void app.workspace.getLeaf(false).openFile(file);
	else notify(`Note not found: ${notePath ?? 'unknown'}.`);
}
