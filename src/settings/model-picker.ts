import type { Setting, TextComponent } from 'obsidian';
import type ReadablePlugin from '../main';
import { errorMessage } from '../core/errors';
import { LlmUnavailable } from '../llm/client';
import { fetchModels, reconcileModels } from '../llm/models';
import { appProvider, providerName, serverUrl, usesServer } from '../llm/providers';
import type { LocalModel } from '../llm/builtin/catalog';

/** Shown when the address is another computer: the documents go there. */
export const REMOTE_WARNING = 'This is another computer: every document, its pictures and the API key are sent to it, unencrypted unless the address starts with https.';

/** Whether a server address is this computer. Unparsable addresses count as remote. */
export function isLoopback(address: string): boolean {
	const trimmed = address.trim();
	if (trimmed === '') return true;
	try {
		const host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname.replace(/^\[|\]$/g, '');
		return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0';
	} catch {
		return false;
	}
}

/** The settings that name a model on the server. */
export type ModelKey = 'llmModel' | 'tagsModel' | 'visionModel';

const CUSTOM = '__custom__';
/** What the empty choice means for each picker. */
const EMPTY_LABEL: Record<ModelKey, string> = {
	llmModel: 'Choose a model',
	tagsModel: 'Same as summaries',
	visionModel: 'None',
};
/** Opening settings again within this long reuses the last fetch. */
const REFETCH_MS = 60_000;

type FetchState = { kind: 'idle' } | { kind: 'fetching' } | { kind: 'done' } | { kind: 'failed'; message: string };

/**
 * The AI rows that need live data: the models on the chosen server (fetched,
 * then saved in settings) and the model files Readable's own AI can use.
 */
export class ModelPicker {
	constructor(
		private readonly owner: ReadablePlugin,
		/** Rows that show or hide with these choices need the tab to re-evaluate. */
		private readonly onLayoutChange: () => void,
	) {}

	private readonly listeners = new Set<() => void>();
	private localModels: LocalModel[] | null = null;
	private scanning: Promise<void> | null = null;
	private state: FetchState = { kind: 'idle' };
	private lastFetch = 0;
	/** Each fetch takes a ticket; a reply for an older one is dropped. */
	private ticket = 0;
	/** Pickers the user switched to typing with "Custom…". */
	private readonly typing = new Set<ModelKey>();
	private addressTimer: number | null = null;

	/** Calls `listener` after each fetch, scan or choice; returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	// Readable's own AI

	/** Scans the model folders once per settings session; `force` scans again. */
	scanLocal(force = false): Promise<void> {
		if (this.localModels && !force) return Promise.resolve();
		if (!this.scanning) {
			this.scanning = this.owner.llama
				.models()
				.then((models) => {
					const changed = JSON.stringify(models.map((m) => m.path)) !== JSON.stringify((this.localModels ?? []).map((m) => m.path));
					this.localModels = models;
					this.emit();
					// Each model found is its own settings row
					if (changed) this.onLayoutChange();
				})
				.finally(() => (this.scanning = null));
		}
		return this.scanning;
	}

	get foundLocalModels(): LocalModel[] | null {
		return this.localModels;
	}

	// A model server

	/**
	 * Lists the server's models and saves the list. `fresh` (another server
	 * was chosen) replaces model choices the new list lacks.
	 */
	async fetch(fresh = false): Promise<void> {
		const s = this.owner.settings;
		if (!usesServer(s.aiProvider)) return;
		const ticket = ++this.ticket;
		this.lastFetch = Date.now();
		const url = serverUrl(s);
		if (!url) {
			this.state = { kind: 'failed', message: 'Enter the address first.' };
			this.emit();
			return;
		}
		this.state = { kind: 'fetching' };
		this.emit();
		try {
			const models = await fetchModels(s.aiProvider, url, this.owner.serverKey());
			if (ticket !== this.ticket) return;
			const choice = reconcileModels(s, models, fresh);
			s.llmModels = models;
			s.llmModel = choice.llmModel;
			s.tagsModel = choice.tagsModel;
			s.visionModel = choice.visionModel;
			await this.owner.saveSettings();
			this.state = { kind: 'done' };
		} catch (error) {
			if (ticket !== this.ticket) return;
			this.state = { kind: 'failed', message: this.failure(error) };
		}
		this.emit();
		this.onLayoutChange();
	}

	/** Another provider was chosen: its models are not the old server's, so fetch them afresh. */
	async providerChanged(): Promise<void> {
		this.ticket++;
		this.typing.clear();
		this.state = { kind: 'idle' };
		this.owner.settings.llmModels = [];
		await this.owner.saveSettings();
		this.emit();
		if (usesServer(this.owner.settings.aiProvider)) await this.fetch(true);
	}

	private failure(error: unknown): string {
		const message = errorMessage(error);
		if (!(error instanceof LlmUnavailable) || /API key/i.test(message)) return message.replace(/\.?$/, '.');
		const where = serverUrl(this.owner.settings)
			.replace(/^https?:\/\//i, '')
			.replace(/\/v1\/?$/i, '');
		return `${capitalize(providerName(this.owner.settings.aiProvider))} isn't answering at ${where}. Start it, then fetch models.`;
	}

	private status(): string {
		const s = this.owner.settings;
		const name = providerName(s.aiProvider);
		const count = s.llmModels.length;
		const models = `${count} ${count === 1 ? 'model' : 'models'}`;
		switch (this.state.kind) {
			case 'fetching':
				return 'Looking for models…';
			case 'failed':
				return this.state.message;
			case 'done':
				return count === 0 ? `${capitalize(name)} is running but lists no models. Download one there first.` : `${models} in ${name}.`;
			case 'idle':
				return count === 0 ? 'Not fetched yet.' : `${models} from the last fetch.`;
		}
	}

	/** The server's status, with Fetch models; fetches on first show. */
	renderFetch(setting: Setting): () => void {
		const draw = () => {
			const fetching = this.state.kind === 'fetching';
			setting.setDesc(this.status());
			setting.controlEl.empty();
			setting.addButton((b) =>
				b
					.setButtonText(fetching ? 'Fetching…' : 'Fetch models')
					.setDisabled(fetching)
					.onClick(() => void this.fetch()),
			);
		};
		draw();
		if (Date.now() - this.lastFetch > REFETCH_MS) void this.fetch();
		return this.onChange(draw);
	}

	/** The server's address; the app's usual one shows as the placeholder. Typing saves and fetches once it pauses. */
	renderAddress(setting: Setting): () => void {
		let input: TextComponent | null = null;
		setting.addText((text) => {
			input = text;
			text.onChange(async (value) => {
				this.owner.settings.llmBaseUrl = value.trim();
				await this.owner.saveSettings();
				if (this.addressTimer !== null) window.clearTimeout(this.addressTimer);
				this.addressTimer = window.setTimeout(() => {
					this.addressTimer = null;
					void this.fetch();
				}, 1000);
			});
		});
		const draw = () => {
			const s = this.owner.settings;
			const app = appProvider(s.aiProvider);
			const where = app ? `Where ${app.name} listens. Change it for another port or computer.` : 'Any server with the OpenAI chat API.';
			setting.setDesc(isLoopback(s.llmBaseUrl) ? where : `${where} ${REMOTE_WARNING}`);
			input?.setPlaceholder(app?.url ?? 'http://localhost:8080');
			// Not while the user is typing in it; settings may be in a window of their own
			if (input && input.inputEl.ownerDocument.activeElement !== input.inputEl) input.setValue(s.llmBaseUrl);
		};
		draw();
		return this.onChange(draw);
	}

	/**
	 * A model on the server: a dropdown of the fetched models (those that read
	 * pictures marked) with "Custom…" to type a name; a text field when
	 * nothing is fetched or the saved name is not in the list.
	 */
	renderModel(setting: Setting, key: ModelKey, describe?: () => string): () => void {
		const draw = () => {
			const s = this.owner.settings;
			const models = s.llmModels;
			const current = s[key];
			if (describe) setting.setDesc(describe());
			setting.controlEl.empty();
			const listed = models.some((m) => m.id === current);
			if (this.typing.has(key) || models.length === 0 || (current !== '' && !listed)) {
				setting.addText((text) =>
					text
						.setPlaceholder(key === 'tagsModel' ? EMPTY_LABEL.tagsModel : 'Model name')
						.setValue(current)
						.onChange(async (value) => {
							s[key] = value.trim();
							await this.owner.saveSettings();
						}),
				);
				if (models.length > 0) {
					setting.addExtraButton((b) =>
						b
							.setIcon('list')
							.setTooltip('Choose from the list')
							.onClick(async () => {
								this.typing.delete(key);
								if (!models.some((m) => m.id === s[key])) s[key] = '';
								await this.owner.saveSettings();
								this.emit();
								this.onLayoutChange();
							}),
					);
				}
				return;
			}
			setting.addDropdown((dd) => {
				dd.addOption('', EMPTY_LABEL[key]);
				for (const m of models) dd.addOption(m.id, m.vision ? `${m.id} · reads pictures` : m.id);
				dd.addOption(CUSTOM, 'Custom…');
				dd.setValue(current);
				dd.onChange(async (value) => {
					if (value === CUSTOM) {
						this.typing.add(key);
						draw();
						return;
					}
					s[key] = value;
					await this.owner.saveSettings();
					this.emit();
					this.onLayoutChange();
				});
			});
		};
		draw();
		return this.onChange(draw);
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
