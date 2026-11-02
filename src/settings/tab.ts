import { PluginSettingTab } from 'obsidian';
import type { App, Setting, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import type ReadablePlugin from '../main';
import type { AudioPolicy, DocumentPolicy, ImagePolicy, TextPolicy, VideoPolicy } from '../extract/kinds';
import type { ExtractFormat } from '../notes/format';
import type { SummaryLength } from '../llm/summarise';
import { confirmAndInstall, confirmAndInstallAddon, confirmAndInstallSpeech, confirmAndRemove, describeAddon, describeInstall } from '../ui/docling-install';
import { addonAvailable } from '../extract/docling/managed/installer';
import type { AddonId } from '../extract/docling/managed/installer';
import { resolveOcrLanguages, systemOcrLanguages } from '../extract/docling/ocr-languages';
import type { OcrEngine } from '../extract/docling/options';
import { tryModel } from './connection-tests';
import { DEFAULT_PROMPTS } from '../llm/prompts';
import { CATALOG, catalogModel, downloadGB } from '../llm/builtin/release';
import type { CatalogModel } from '../llm/builtin/release';
import { pickModel, recommendedForThisComputer } from '../llm/builtin/manager';
import type { LocalModel } from '../llm/builtin/catalog';
import { confirmAndDeleteModel, confirmAndInstallLlama, confirmAndRemoveLlama, describeLlama } from '../ui/llama-install';
import { KEEP_LOADED_CHOICES, serverVisionModel } from './model';
import { APP_PROVIDERS, appProvider, providerName, takesKey, usesServer } from '../llm/providers';
import type { AiProvider } from '../llm/providers';
import { sizeLabel } from '../llm/builtin/catalog';
import { openFolder } from '../ui/open-folder';
import { notify } from '../ui/notices';
import { ModelPicker } from './model-picker';
import { DEFAULT_SETTINGS, isSettingKey, LARGEST_NOTE_CHOICES, MIN_DOCLING_TIMEOUT_SEC, normalizeField, NUMERIC_KEYS, TAG_COUNTS } from './model';
import type { OutputMode, SettingKey, ReadableSettings } from './model';

/**
 * Readable's settings page, declared with Obsidian's settings definitions
 * rather than drawn by hand. getSettingDefinitions returns groups (Notes,
 * Automation, Extraction, Output, Display, LLM, AI, Advanced) holding pages
 * (one per kind of file, Models, Summaries, Titles and tags) and rows: a
 * control bound to a setting key, read and written through getControlValue
 * and setControlValue, an action button such as Check it works, or a render
 * function for live state such as an install or a model download, which
 * returns its unsubscribe. `visible` rules are re-checked only on update(), so
 * every change calls it; Obsidian builds the definitions more than once, so
 * text that follows a choice is found again by class rather than kept by
 * reference. ModelPicker supplies the models on the server and on disk.
 */

const OUTPUT_DESC_CLASS = 'readable-output-desc';
const AI_DESC_CLASS = 'readable-ai-desc';

const PROVIDER_LABELS: Record<AiProvider, string> = {
	own: "Readable's own (recommended)",
	...(Object.fromEntries(APP_PROVIDERS.map((p) => [p.id, p.name])) as Record<(typeof APP_PROVIDERS)[number]['id'], string>),
	custom: 'Other server (OpenAI-compatible)',
	off: 'Off',
};

function aiDescription(provider: AiProvider): string {
	if (provider === 'own') return 'Runs privately on this computer. Nothing else to install.';
	if (provider === 'off') return 'Notes get no summaries, titles, tags or picture descriptions.';
	if (provider === 'custom') return 'Any model server with the OpenAI chat API, on this computer or another.';
	return `Use the models in ${providerName(provider)}. Keep it running while files are processed.`;
}

const OUTPUT_DESCRIPTIONS: Record<OutputMode, string> = {
	note: 'A separate note per file.',
	inline: 'Below each embed of the file. Files nothing embeds get a separate note.',
	both: 'A separate note per file, and below each embed.',
};

const DOCUMENT_LABELS: Record<DocumentPolicy, string> = {
	read: 'Read',
	skip: 'Skip',
};

const IMAGE_LABELS: Record<ImagePolicy, string> = {
	text: 'Read text',
	describe: 'Read text and describe',
	skip: 'Skip',
};

const OCR_ENGINE_LABELS: Record<OcrEngine, string> = {
	auto: 'Automatic',
	ocrmac: 'Apple Vision (Mac)',
	rapidocr: 'RapidOCR',
};

const AUDIO_LABELS: Record<AudioPolicy, string> = {
	transcribe: 'Transcribe',
	skip: 'Skip',
};

const VIDEO_LABELS: Record<VideoPolicy, string> = {
	transcribe: 'Transcribe the audio',
	skip: 'Skip',
};

const TEXT_LABELS: Record<TextPolicy, string> = {
	copy: 'Copy into a note',
	skip: 'Skip',
};

const SUMMARY_LENGTH_LABELS: Record<SummaryLength, string> = {
	short: 'Short (a few sentences)',
	medium: 'Medium (two paragraphs)',
	long: 'Long (several paragraphs)',
};

const EXTRACT_FORMAT_LABELS: Record<ExtractFormat, string> = {
	plain: 'Markdown',
	callout: 'Folded box',
};

const TAG_COUNT_OPTIONS: Record<string, string> = Object.fromEntries(TAG_COUNTS.map((n) => [String(n), String(n)]));

/** Whisper language codes offered; '' lets Whisper detect. */
const SPEECH_LANGUAGES: Record<string, string> = {
	'': 'Detect',
	en: 'English',
	de: 'German',
	fr: 'French',
	es: 'Spanish',
	it: 'Italian',
	pt: 'Portuguese',
	nl: 'Dutch',
	pl: 'Polish',
	ru: 'Russian',
	uk: 'Ukrainian',
	tr: 'Turkish',
	ar: 'Arabic',
	hi: 'Hindi',
	zh: 'Chinese',
	ja: 'Japanese',
	ko: 'Korean',
};

export class ReadableSettingTab extends PluginSettingTab {
	private readonly picker: ModelPicker;

	constructor(
		app: App,
		private readonly owner: ReadablePlugin,
	) {
		super(app, owner);
		this.containerEl.addClass('readable-settings');
		this.picker = new ModelPicker(owner, () => this.refreshAi());
	}

	/** Rows that depend on the AI choice show or hide, and its description follows. */
	private refreshAi(): void {
		this.containerEl.findAll(`.${AI_DESC_CLASS}`).forEach((el) => el.setText(aiDescription(this.ai())));
		this.update();
	}

	private llamaKind = '';
	private watchingLlama = false;

	/** The Built-in server row shows the install state; re-render when it changes kind (not on every progress line). */
	private watchLlama(): void {
		if (this.watchingLlama) return;
		this.watchingLlama = true;
		this.owner.register(
			this.owner.llama.onChange(() => {
				const kind = `${this.owner.llama.installState.kind}:${this.owner.llama.server.running}`;
				if (kind === this.llamaKind) return;
				this.llamaKind = kind;
				if (this.containerEl.isShown()) this.update();
			}),
		);
	}

	getControlValue(key: string): unknown {
		const value = this.owner.settings[key as SettingKey];
		return NUMERIC_KEYS.has(key as SettingKey) && typeof value === 'number' ? String(value) : value;
	}

	/**
	 * Describes the selected Output option. Obsidian builds definitions more
	 * than once (for search too), so the rendered copy is found by class when
	 * the choice changes rather than kept by reference.
	 */
	private outputDescription(): DocumentFragment {
		return createFragment((frag) => {
			frag.createSpan({ cls: OUTPUT_DESC_CLASS, text: OUTPUT_DESCRIPTIONS[this.owner.settings.outputMode] });
		});
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isSettingKey(key)) return;
		const settings = this.owner.settings;
		const provider = settings.aiProvider;
		this.setSetting(key, normalizeField(key, value) ?? DEFAULT_SETTINGS[key]);
		if (key === 'aiProvider' && settings.aiProvider !== provider && appProvider(settings.aiProvider)) {
			// The old address belonged to the old app; this one's usual address applies
			settings.llmBaseUrl = '';
		}
		if (key === 'modelScope' && settings.modelScope === 'perFeature' && !settings.visionModel) {
			// Start from what one model did for pictures, else the first model that reads them
			settings.visionModel = serverVisionModel({ ...settings, modelScope: 'one' }) || (settings.llmModels.find((m) => m.vision)?.id ?? '');
		}
		await this.owner.saveSettings();
		if (key === 'outputMode') {
			this.containerEl.findAll(`.${OUTPUT_DESC_CLASS}`).forEach((el) => el.setText(OUTPUT_DESCRIPTIONS[settings.outputMode]));
		}
		if (key === 'aiProvider' && settings.aiProvider !== provider) {
			this.containerEl.findAll(`.${AI_DESC_CLASS}`).forEach((el) => el.setText(aiDescription(this.ai())));
			void this.picker.providerChanged();
		}
		// Dependent rows (visible: …) only re-evaluate on render
		this.update();
	}

	private setSetting<K extends SettingKey>(key: K, value: ReadableSettings[K]): void {
		this.owner.settings[key] = value;
	}

	/** Install state with Install / Cancel / Update / Remove; follows the install live. */
	private renderManagedStatus(setting: Setting): () => void {
		const docling = this.owner.managedDocling;
		const draw = () => {
			const state = docling.installState;
			setting.setDesc(describeInstall(state, docling.sidecar.running));
			setting.controlEl.empty();
			const install = () => confirmAndInstall(this.app, docling, () => this.owner.onDoclingReady());
			if (state.kind === 'installing') {
				setting.addButton((b) => b.setButtonText('Cancel').onClick(() => docling.cancelInstall()));
				return;
			}
			if (state.kind === 'missing' || state.kind === 'failed') {
				setting.addButton((b) => b.setButtonText(state.kind === 'failed' ? 'Try again' : 'Install').setCta().onClick(install));
				return;
			}
			if (state.kind === 'outdated') setting.addButton((b) => b.setButtonText('Update').setCta().onClick(install));
			if (state.kind === 'installed' || state.kind === 'outdated') {
				if (docling.sidecar.running) {
					setting.addButton((b) => b.setButtonText('Stop').onClick(() => docling.sidecar.stop()));
				}
				setting.addButton((b) =>
					b
						.setButtonText('Remove')
						.setDestructive()
						.onClick(() => confirmAndRemove(this.app, docling)),
				);
			}
		};
		draw();
		return docling.onChange(draw);
	}

	private ai(): AiProvider {
		return this.owner.settings.aiProvider;
	}

	/** Features run on a model server the user runs: an app or another server. */
	private onServer(): boolean {
		return usesServer(this.ai());
	}

	/** On a model server, each feature picks its own model on its page. */
	private perFeature(): boolean {
		return this.onServer() && this.owner.settings.modelScope === 'perFeature';
	}

	/** On a model server, one model does everything and is picked under AI. */
	private oneModel(): boolean {
		return this.onServer() && this.owner.settings.modelScope === 'one';
	}

	/** The model Readable's own AI uses for text, as the server will pick it; its name for row values. */
	private ownModel(use: 'text' | 'vision'): LocalModel | null {
		return pickModel(this.picker.foundLocalModels ?? [], this.owner.settings.builtinModel, use);
	}

	private modelName(model: LocalModel | null): string {
		if (!model) return '';
		return (model.catalog && catalogModel(model.catalog)?.name) || model.id;
	}

	/** The text model in use, for row values; '' when none. */
	private textModelName(): string {
		const s = this.owner.settings;
		if (s.aiProvider === 'own') return this.modelName(this.ownModel('text'));
		return this.onServer() ? s.llmModel : '';
	}

	/** The picture model in use; '' when none, so describing falls back to text only. */
	private visionModelName(): string {
		const s = this.owner.settings;
		if (s.aiProvider === 'own') return this.modelName(this.ownModel('vision'));
		return this.onServer() ? serverVisionModel(s) : '';
	}

	/** Follows the AI choice, like the Output description. */
	private aiDescription(): DocumentFragment {
		return createFragment((frag) => {
			frag.createSpan({ cls: AI_DESC_CLASS, text: aiDescription(this.ai()) });
		});
	}

	/** Under the one Model row: what it is used for, and when it cannot do pictures that are to be described. */
	private sharedModelDesc(): string {
		const s = this.owner.settings;
		const used = 'Used for summaries, titles, tags and pictures.';
		if (!s.llmModel.trim() || !this.describing() || serverVisionModel(s)) return used;
		return `${used} This one doesn't read pictures, so pictures are read for text only.`;
	}

	/** Images or pictures in documents are set to be described. */
	private describing(): boolean {
		const s = this.owner.settings;
		return s.images === 'describe' || (s.documents !== 'skip' && s.documentPictures === 'describe');
	}

	/** The Vision model row on Images and Documents: which model describes pictures, chosen under AI, or why none does. */
	private renderVision(setting: Setting): () => void {
		const draw = () => {
			const s = this.owner.settings;
			const model = serverVisionModel(s);
			if (model) setting.setDesc(`${model}, chosen under AI.`);
			else if (s.modelScope === 'perFeature') setting.setDesc('None chosen under AI, so pictures are read for text only.');
			else if (!s.llmModel.trim()) setting.setDesc('Choose a model under AI first.');
			else setting.setDesc(`${s.llmModel.trim()} doesn't read pictures. Under AI, choose a model per feature to use one that does.`);
		};
		draw();
		return this.picker.onChange(draw);
	}

	/** Models found that are not from the catalog: the user's own files, and older downloads. */
	private ownModels(): LocalModel[] {
		return (this.picker.foundLocalModels ?? []).filter((m) => !m.catalog);
	}

	/** Makes `id` the model in use and redraws the rows that show it. */
	private async useModel(id: string): Promise<void> {
		this.owner.settings.builtinModel = id;
		await this.owner.saveSettings();
		this.update();
	}

	/** A catalog model: what it is, its size, and one action for its state (Download, Use, In use), plus Delete. */
	private renderCatalogModel(setting: Setting, cm: CatalogModel): () => void {
		const llama = this.owner.llama;
		const draw = () => {
			const local = (this.picker.foundLocalModels ?? []).find((m) => m.catalog === cm.id);
			const download = llama.downloads.get(cm.id);
			const recommended = recommendedForThisComputer().id === cm.id;
			const inUse = local !== undefined && this.ownModel('text')?.path === local.path;
			setting.setName(recommended ? `${cm.name} · recommended for this computer` : cm.name);
			const size = `${downloadGB(cm)} GB download, works best with ${cm.memoryGB} GB of memory or more.`;
			setting.setDesc(download ? `Downloading… ${download.detail}` : `${cm.blurb} ${size}`);
			setting.controlEl.empty();
			if (download) {
				setting.addButton((b) => b.setButtonText('Cancel').onClick(() => llama.cancelDownload(cm.id)));
				return;
			}
			if (!local) {
				setting.addButton((b) => {
					b.setButtonText('Download').onClick(() => {
						void llama.downloadModel(cm.id).then(
							async (done) => {
								if (!done) return;
								await this.picker.scanLocal(true);
								notify(`${cm.name} is ready.`);
							},
							(error: unknown) => notify(`Couldn't download ${cm.name}. ${error instanceof Error ? error.message : ''}`),
						);
					});
					if (recommended) b.setCta();
				});
				return;
			}
			if (inUse) setting.controlEl.createSpan({ cls: 'readable-in-use', text: 'In use' });
			else setting.addButton((b) => b.setButtonText('Use').onClick(() => void this.useModel(cm.id)));
			setting.addExtraButton((b) =>
				b
					.setIcon('trash-2')
					.setTooltip('Delete to free disk space')
					.onClick(() =>
						confirmAndDeleteModel(this.app, llama, local, cm.name, () => {
							if (this.owner.settings.builtinModel === cm.id) void this.useModel('');
							void this.picker.scanLocal(true);
						}),
					),
			);
		};
		draw();
		void this.picker.scanLocal();
		const offLlama = llama.onChange(draw);
		const offScan = this.picker.onChange(draw);
		return () => {
			offLlama();
			offScan();
		};
	}

	/** A model file not from the catalog: Use, and Delete when it is in Readable's own folder. */
	private renderOwnModel(setting: Setting, model: LocalModel): () => void {
		const llama = this.owner.llama;
		const draw = () => {
			const inUse = this.ownModel('text')?.path === model.path;
			const where = llama.owns(model) ? "In Readable's folder" : 'In your models folder';
			setting.setDesc(`${where}. ${sizeLabel(model.bytes)}, ${model.projector ? 'reads pictures' : 'text only'}.`);
			setting.controlEl.empty();
			if (inUse) setting.controlEl.createSpan({ cls: 'readable-in-use', text: 'In use' });
			else setting.addButton((b) => b.setButtonText('Use').onClick(() => void this.useModel(model.id)));
			if (llama.owns(model)) {
				setting.addExtraButton((b) =>
					b
						.setIcon('trash-2')
						.setTooltip('Delete to free disk space')
						.onClick(() =>
							confirmAndDeleteModel(this.app, llama, model, model.id, () => {
								if (this.owner.settings.builtinModel === model.id) void this.useModel('');
								void this.picker.scanLocal(true);
							}),
						),
				);
			}
		};
		draw();
		return this.picker.onChange(draw);
	}

	private titlesAndTagsSummary(): string {
		const s = this.owner.settings;
		const parts = [s.titles ? 'Title' : '', s.tags ? `${s.tagCount} tags` : ''].filter(Boolean);
		return parts.length > 0 ? parts.join(' · ') : 'Off';
	}

	/** The extra models folder: a path field, and a button that opens Readable's own folder. */
	private renderModelsFolder(setting: Setting): void {
		let timer: number | null = null;
		setting.addText((text) =>
			text
				.setPlaceholder('Not set')
				.setValue(this.owner.settings.builtinModelsFolder)
				.onChange((value) => {
					this.owner.settings.builtinModelsFolder = value.trim();
					void this.owner.saveSettings();
					if (timer !== null) window.clearTimeout(timer);
					timer = window.setTimeout(() => void this.picker.scanLocal(true), 800);
				}),
		);
		setting.addExtraButton((b) =>
			b
				.setIcon('folder-open')
				.setTooltip("Open Readable's models folder")
				.onClick(() => void openFolder(this.owner.llama.paths.models)),
		);
	}

	/** Readable's model: what it costs, with Install, Update, Stop and Remove; follows the install live. */
	private renderLlamaStatus(setting: Setting): () => void {
		const llama = this.owner.llama;
		const draw = () => {
			const state = llama.installState;
			setting.setDesc(describeLlama(llama));
			setting.controlEl.empty();
			const install = () => confirmAndInstallLlama(this.app, llama, () => undefined);
			if (state.kind === 'installing') {
				setting.addButton((b) => b.setButtonText('Cancel').onClick(() => llama.cancelInstall()));
				return;
			}
			if (state.kind === 'missing' || state.kind === 'failed') {
				setting.addButton((b) => b.setButtonText(state.kind === 'failed' ? 'Try again' : 'Install').setCta().onClick(install));
				return;
			}
			if (state.kind === 'outdated') setting.addButton((b) => b.setButtonText('Update').setCta().onClick(install));
			if (state.kind === 'installed' || state.kind === 'outdated') {
				if (llama.server.running) setting.addButton((b) => b.setButtonText('Stop').onClick(() => llama.server.stop()));
				setting.addButton((b) =>
					b
						.setButtonText('Remove')
						.setDestructive()
						.onClick(() => confirmAndRemoveLlama(this.app, llama)),
				);
			}
		};
		draw();
		return llama.onChange(draw);
	}

	/** Without the speech add-on, transcribing cannot work yet. */
	private needsSpeechAddon(): boolean {
		return !this.owner.managedDocling.speechInstalled;
	}

	/** Rows shared by the Audio and Video pages: add-on status, language, timestamps. */
	private speechRows(): SettingDefinition<SettingKey>[] {
		const transcribing = () =>
			this.getControlValue('audio') === 'transcribe' || this.getControlValue('video') === 'transcribe';
		return [
			{
				name: 'Speech add-on',
				aliases: ['whisper', 'ffmpeg', 'install'],
				render: (setting) => this.renderSpeechStatus(setting),
			},
			{
				name: 'Language',
				desc: 'Detect works for most recordings; set it when the language is known or detection gets it wrong.',
				visible: transcribing,
				control: {
					type: 'dropdown',
					key: 'speechLanguage',
					defaultValue: DEFAULT_SETTINGS.speechLanguage,
					options: SPEECH_LANGUAGES,
				},
			},
			{
				name: 'Timestamps',
				desc: 'Keep a time marker on each line of the transcript.',
				visible: transcribing,
				control: {
					type: 'toggle',
					key: 'speechTimestamps',
					defaultValue: DEFAULT_SETTINGS.speechTimestamps,
				},
			},
		];
	}

	/** Speech add-on state with Install; follows the install live. */
	private renderSpeechStatus(setting: Setting): () => void {
		return this.renderAddonStatus(setting, 'speech');
	}

	/** An add-on's state with Install; follows the install live. RapidOCR prefetches the OCR languages set now. */
	private renderAddonStatus(setting: Setting, addon: AddonId): () => void {
		const docling = this.owner.managedDocling;
		const draw = () => {
			const state = docling.installState;
			setting.setDesc(addonAvailable(addon) ? describeAddon(docling, addon) : 'Not available on this system.');
			setting.controlEl.empty();
			if (!addonAvailable(addon)) return;
			if (state.kind === 'installing') {
				setting.addButton((b) => b.setButtonText('Cancel').onClick(() => docling.cancelInstall()));
				return;
			}
			if (!docling.ready) return; // Docling itself first
			if (!docling.addonInstalled(addon)) {
				setting.addButton((b) =>
					b
						.setButtonText('Install')
						.setCta()
						.onClick(() => {
							const onReady = () => this.owner.onDoclingReady();
							if (addon === 'speech') return confirmAndInstallSpeech(this.app, docling, onReady);
							const ocr = { mode: 'auto', languages: resolveOcrLanguages(this.owner.settings.ocrLanguages), engine: addon };
							confirmAndInstallAddon(this.app, docling, addon, onReady, { ocr });
						}),
				);
			}
		};
		draw();
		return docling.onChange(draw);
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		this.watchLlama();
		// The Models row and the summary warnings read the scan; without it they say "None downloaded" until the Models page opens
		void this.picker.scanLocal();
		const readsDocuments = () => this.getControlValue('documents') !== 'skip';
		const usesOcr = () => readsDocuments() && this.getControlValue('doclingOcr') !== 'off';
		return [
			{
				type: 'group',
				heading: 'Notes',
				items: [
					{
						name: 'Output',
						aliases: ['embed', 'inline', 'attachment', 'extracted text'],
						desc: this.outputDescription(),
						control: {
							type: 'dropdown',
							key: 'outputMode',
							defaultValue: DEFAULT_SETTINGS.outputMode,
							options: {
								note: 'Separate note',
								inline: 'Under the embed',
								both: 'Both',
							},
						},
					},
					{
						name: 'Note location',
						desc: 'Where new Readable notes are placed.',
						control: {
							type: 'dropdown',
							key: 'noteLocation',
							defaultValue: DEFAULT_SETTINGS.noteLocation,
							options: {
								folder: 'In the folder specified below',
								beside: 'Same folder as the file',
								subfolder: 'In subfolder under the file\'s folder',
							},
						},
					},
					{
						name: 'Folder for notes',
						visible: () => this.getControlValue('noteLocation') === 'folder',
						control: {
							type: 'folder',
							key: 'outputFolder',
							defaultValue: DEFAULT_SETTINGS.outputFolder,
						},
					},
					{
						name: 'Subfolder name',
						visible: () => this.getControlValue('noteLocation') === 'subfolder',
						control: {
							type: 'text',
							key: 'subfolderName',
							defaultValue: DEFAULT_SETTINGS.subfolderName,
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Automation',
				items: [
					{
						name: 'Auto-ingest new files',
						desc: 'Process files as soon as they are added to the vault.',
						control: {
							type: 'toggle',
							key: 'autoIngest',
							defaultValue: DEFAULT_SETTINGS.autoIngest,
						},
					},
					{
						name: 'Watched folder',
						desc: 'Leave empty to watch the whole vault.',
						visible: () => this.getControlValue('autoIngest') === true,
						control: {
							type: 'folder',
							key: 'inboxFolder',
							defaultValue: DEFAULT_SETTINGS.inboxFolder,
						},
					},
					{
						name: 'Reprocess changed files',
						desc: 'When a file in the watched folder changes, update its note after it has been left alone for a minute. Your own additions to the note are kept.',
						visible: () => this.getControlValue('autoIngest') === true,
						control: {
							type: 'toggle',
							key: 'reprocessOnModify',
							defaultValue: DEFAULT_SETTINGS.reprocessOnModify,
						},
					},
					{
						name: 'Parallel jobs',
						desc: 'Files processed at the same time; recordings run beside documents.',
						control: {
							type: 'dropdown',
							key: 'concurrency',
							defaultValue: String(DEFAULT_SETTINGS.concurrency),
							options: { '1': '1', '2': '2', '3': '3', '4': '4' },
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Extraction',
				items: [
					{
						name: 'Docling',
						aliases: ['install', 'engine', 'extractor', 'status'],
						render: (setting) => this.renderManagedStatus(setting),
					},
					{
						type: 'page',
						name: 'Documents',
						desc: 'PDF, Word, PowerPoint, Excel and web pages.',
						displayValue: () => DOCUMENT_LABELS[this.owner.settings.documents],
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'What to do',
										desc: 'Read with layout, tables and OCR, or skip them.',
										control: {
											type: 'dropdown',
											key: 'documents',
											defaultValue: DEFAULT_SETTINGS.documents,
											options: DOCUMENT_LABELS,
										},
									},
									{
										name: 'OCR',
										desc: 'When needed reads scanned pages and photos. Every page also replaces a bad text layer.',
										visible: readsDocuments,
										control: {
											type: 'dropdown',
											key: 'doclingOcr',
											defaultValue: DEFAULT_SETTINGS.doclingOcr,
											options: { auto: 'When needed', all: 'Every page', off: 'Off' },
										},
									},
									{
										name: 'OCR languages',
										aliases: ['russian', 'cyrillic', 'chinese', 'language'],
										desc: `Language codes, most likely first. Empty uses this computer's languages: ${systemOcrLanguages().join(', ')}.`,
										visible: usesOcr,
										control: {
											type: 'text',
											key: 'ocrLanguages',
											defaultValue: DEFAULT_SETTINGS.ocrLanguages,
											placeholder: systemOcrLanguages().join(', '),
											validate: (value: string) =>
												value.trim() === '' || /^[a-z]{2,3}(-[a-z0-9]{2,8})*([\s,;]+[a-z]{2,3}(-[a-z0-9]{2,8})*)*$/i.test(value.trim())
													? undefined
													: 'Use language codes such as en, ru or zh-Hant, separated by commas.',
										},
									},
									{
										name: 'OCR engine',
										desc: 'Automatic picks the best installed engine: Apple Vision on a Mac, then RapidOCR.',
										visible: usesOcr,
										control: {
											type: 'dropdown',
											key: 'ocrEngine',
											defaultValue: DEFAULT_SETTINGS.ocrEngine,
											options: OCR_ENGINE_LABELS,
										},
									},
									{
										name: 'Apple Vision OCR',
										aliases: ['ocrmac', 'install'],
										visible: () => usesOcr() && this.getControlValue('ocrEngine') === 'ocrmac',
										render: (setting) => this.renderAddonStatus(setting, 'ocrmac'),
									},
									{
										name: 'RapidOCR',
										aliases: ['onnx', 'install'],
										visible: () => usesOcr() && this.getControlValue('ocrEngine') === 'rapidocr',
										render: (setting) => this.renderAddonStatus(setting, 'rapidocr'),
									},
									{
										name: 'Table mode',
										desc: 'Accurate recovers complex tables better; fast is quicker.',
										visible: readsDocuments,
										control: {
											type: 'dropdown',
											key: 'doclingTableMode',
											defaultValue: DEFAULT_SETTINGS.doclingTableMode,
											options: { accurate: 'Accurate', fast: 'Fast' },
										},
									},
									{
										name: 'Pictures',
										aliases: ['figures', 'images', 'attachments'],
										desc: 'Pictures found in the document. Saved ones go to your attachment folder and are embedded where they were. Describe adds a short description from the vision model.',
										visible: readsDocuments,
										control: {
											type: 'dropdown',
											key: 'documentPictures',
											defaultValue: DEFAULT_SETTINGS.documentPictures,
											options: { attach: 'Save as attachments', describe: 'Save and describe', skip: 'Leave out' },
										},
									},
									{
										name: 'Vision model',
										visible: () => this.onServer() && readsDocuments() && this.getControlValue('documentPictures') === 'describe',
										render: (setting) => this.renderVision(setting),
									},
									{
										name: 'Where pictures go',
										aliases: ['attachments', 'folder', 'figures'],
										desc: "Next to the note that embeds them, or wherever Obsidian puts attachments (Files and links). Obsidian's default is the vault folder.",
										visible: () => readsDocuments() && this.getControlValue('documentPictures') !== 'skip',
										control: {
											type: 'dropdown',
											key: 'figureLocation',
											defaultValue: DEFAULT_SETTINGS.figureLocation,
											options: { note: 'Next to the note', attachments: "Obsidian's attachment folder" },
										},
									},
									{
										name: 'Group per document',
										desc: 'Put each document\'s pictures in its own folder, named like report-figures.',
										visible: () => readsDocuments() && this.getControlValue('documentPictures') !== 'skip',
										control: {
											type: 'toggle',
											key: 'groupFigures',
											defaultValue: DEFAULT_SETTINGS.groupFigures,
										},
									},
								],
							},
						],
					},
					{
						type: 'page',
						name: 'Images',
						desc: 'Photos and screenshots.',
						displayValue: () => IMAGE_LABELS[this.owner.settings.images],
						status: () => (this.owner.settings.images === 'describe' && !this.visionModelName() ? 'warning' : null),
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'What to do',
										desc: 'Read text uses OCR. Describe adds a short description of what the picture shows, written by the vision model, so a photo without text still says something.',
										control: {
											type: 'dropdown',
											key: 'images',
											defaultValue: DEFAULT_SETTINGS.images,
											options: IMAGE_LABELS,
										},
									},
									{
										name: 'Vision model',
										visible: () => this.onServer() && this.getControlValue('images') === 'describe',
										render: (setting) => this.renderVision(setting),
									},
									{
										name: 'Instructions',
										aliases: ['prompt', 'language', 'describe'],
										desc: 'What a description should say, in your words; pictures inside documents use these too. Empty uses the default shown.',
										visible: () => this.getControlValue('images') === 'describe' || this.getControlValue('documentPictures') === 'describe',
										control: {
											type: 'textarea',
											key: 'describePrompt',
											defaultValue: DEFAULT_SETTINGS.describePrompt,
											placeholder: DEFAULT_PROMPTS.describe,
											rows: 3,
										},
									},
								],
							},
						],
					},
					{
						type: 'page',
						name: 'Audio',
						desc: 'Voice notes and recordings.',
						displayValue: () => AUDIO_LABELS[this.owner.settings.audio],
						status: () => (this.owner.settings.audio === 'transcribe' && this.needsSpeechAddon() ? 'warning' : null),
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'What to do',
										desc: 'Transcribe with Whisper, on this machine.',
										control: {
											type: 'dropdown',
											key: 'audio',
											defaultValue: DEFAULT_SETTINGS.audio,
											options: AUDIO_LABELS,
										},
									},
									...this.speechRows(),
								],
							},
						],
					},
					{
						type: 'page',
						name: 'Video',
						desc: 'Only the audio track is used.',
						displayValue: () => VIDEO_LABELS[this.owner.settings.video],
						status: () => (this.owner.settings.video === 'transcribe' && this.needsSpeechAddon() ? 'warning' : null),
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'What to do',
										desc: 'The audio track is pulled out and transcribed like a recording.',
										control: {
											type: 'dropdown',
											key: 'video',
											defaultValue: DEFAULT_SETTINGS.video,
											options: VIDEO_LABELS,
										},
									},
									...this.speechRows(),
								],
							},
						],
					},
					{
						type: 'page',
						name: 'Plain text',
						desc: 'Text and JSON files.',
						displayValue: () => TEXT_LABELS[this.owner.settings.plainText],
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'What to do',
										desc: 'Copied as they are.',
										control: {
											type: 'dropdown',
											key: 'plainText',
											defaultValue: DEFAULT_SETTINGS.plainText,
											options: TEXT_LABELS,
										},
									},
								],
							},
						],
					},
					{
						name: 'Ignore',
						aliases: ['extensions', 'exclude'],
						desc: 'File extensions never processed, separated by commas.',
						control: {
							type: 'text',
							key: 'ignoreExtensions',
							defaultValue: DEFAULT_SETTINGS.ignoreExtensions,
							placeholder: 'svg, ico',
						},
					},
					{
						name: 'Timeout',
						aliases: ['timeout per file', 'stuck', 'stall'],
						desc: 'Seconds without progress before Docling gives up on a file. Long PDFs keep going while pages advance.',
						control: {
							type: 'number',
							key: 'doclingTimeout',
							defaultValue: DEFAULT_SETTINGS.doclingTimeout,
							min: MIN_DOCLING_TIMEOUT_SEC,
							step: 1,
							validate: (value: number) =>
								Number.isFinite(value) && value >= MIN_DOCLING_TIMEOUT_SEC
									? undefined
									: `Enter at least ${MIN_DOCLING_TIMEOUT_SEC} seconds.`,
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Output',
				items: [
					{
						name: 'Text in separate notes',
						aliases: ['format', 'callout', 'plain', 'markdown', 'extracted text'],
						desc: 'Markdown keeps the document\'s headings and reads cleanly for search and AI tools. Folded box starts collapsed.',
						control: {
							type: 'dropdown',
							key: 'extractFormat',
							defaultValue: DEFAULT_SETTINGS.extractFormat,
							options: EXTRACT_FORMAT_LABELS,
						},
					},
					{
						name: 'Text under embeds',
						aliases: ['format', 'callout', 'plain', 'inline'],
						desc: 'Inside your own notes. Folded box keeps long documents out of the way.',
						control: {
							type: 'dropdown',
							key: 'inlineFormat',
							defaultValue: DEFAULT_SETTINGS.inlineFormat,
							options: EXTRACT_FORMAT_LABELS,
						},
					},
					{
						name: 'Largest note',
						aliases: ['size', 'limit', 'cut', 'truncate'],
						desc: 'Longer text is cut, with a note saying so. Very large notes can crash Obsidian.',
						control: {
							type: 'dropdown',
							key: 'largestNoteMb',
							defaultValue: String(DEFAULT_SETTINGS.largestNoteMb),
							options: Object.fromEntries(LARGEST_NOTE_CHOICES.map((mb) => [String(mb), `${mb} MB`])),
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Display',
				items: [
					{
						name: 'Show notice when done',
						desc: 'Includes a link to the new note.',
						control: {
							type: 'toggle',
							key: 'notifyOnDone',
							defaultValue: DEFAULT_SETTINGS.notifyOnDone,
						},
					},
					{
						name: 'Mark processed files',
						desc: 'Show a check next to processed files in the file explorer.',
						control: {
							type: 'toggle',
							key: 'showBadges',
							defaultValue: DEFAULT_SETTINGS.showBadges,
						},
					},
					{
						name: 'Reduce motion',
						desc: 'Queue rows move to their new place at once instead of sliding.',
						aliases: ['animation', 'motion'],
						control: {
							type: 'toggle',
							key: 'reduceMotion',
							defaultValue: DEFAULT_SETTINGS.reduceMotion,
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'LLM',
				items: [
					{
						name: 'Provider',
						aliases: ['ai', 'ollama', 'lm studio', 'llama.cpp', 'jan', 'vllm', 'gpt4all', 'server', 'openai'],
						desc: this.aiDescription(),
						control: {
							type: 'dropdown',
							key: 'aiProvider',
							defaultValue: DEFAULT_SETTINGS.aiProvider,
							options: PROVIDER_LABELS,
						},
					},
					{
						name: "Readable's AI",
						aliases: ['install', 'gemma', 'download', 'remove'],
						visible: () => this.ai() === 'own',
						render: (setting) => this.renderLlamaStatus(setting),
					},
					{
						type: 'page',
						name: 'Models',
						aliases: ['gguf', 'download', 'models folder', 'memory', 'keep loaded', 'gemma', 'qwen'],
						desc: 'Download, choose and delete models, and how long one stays in memory.',
						visible: () => this.ai() === 'own',
						displayValue: () => this.textModelName() || 'None downloaded',
						status: () => (this.owner.llama.ready && this.picker.foundLocalModels?.length === 0 ? 'warning' : null),
						items: [
							{
								type: 'group',
								heading: 'Recommended',
								items: CATALOG.map((cm) => ({
									name: cm.name,
									aliases: [cm.id, 'download'],
									render: (setting: Setting) => this.renderCatalogModel(setting, cm),
								})),
							},
							{
								type: 'group',
								heading: 'Your models',
								items: [
									...this.ownModels().map((m) => ({
										name: m.id,
										render: (setting: Setting) => this.renderOwnModel(setting, m),
									})),
									{
										name: 'Models folder',
										desc: "Any .gguf model here can be used, such as LM Studio's. A model reads pictures when an mmproj file sits beside it. The button opens Readable's own folder.",
										render: (setting: Setting) => this.renderModelsFolder(setting),
									},
								],
							},
							{
								type: 'group',
								heading: 'Memory',
								items: [
									{
										name: 'Keep in memory for',
										desc: 'After the last note, the model is unloaded to free memory. Loading again takes a few seconds.',
										control: {
											type: 'dropdown',
											key: 'builtinKeepLoaded',
											defaultValue: String(DEFAULT_SETTINGS.builtinKeepLoaded),
											options: Object.fromEntries(KEEP_LOADED_CHOICES.map((m) => [String(m), m === 1 ? '1 minute' : `${m} minutes`])),
										},
									},
								],
							},
						],
					},
					{
						name: 'Address',
						aliases: ['url', 'port', 'base url'],
						visible: () => this.onServer(),
						render: (setting) => this.picker.renderAddress(setting),
					},
					{
						name: 'API key',
						desc: 'Only if the server is set to require one.',
						visible: () => takesKey(this.ai()),
						control: {
							type: 'secret',
							key: 'llmApiKey',
							defaultValue: DEFAULT_SETTINGS.llmApiKey,
						},
					},
					{
						name: 'Available models',
						aliases: ['fetch models', 'refresh', 'list'],
						visible: () => this.onServer(),
						render: (setting) => this.picker.renderFetch(setting),
					},
					{
						name: 'Check it works',
						desc: 'Send a short question and see how long the answer takes.',
						aliases: ['test', 'try'],
						visible: () => this.ai() !== 'off',
						action: () => void tryModel(this.owner.llm, this.ai() === 'own' ? this.owner.settings.builtinModel : this.owner.settings.llmModel, this.textModelName()),
					},
				],
			},
			{
				type: 'group',
				heading: 'AI',
				visible: () => this.ai() !== 'off',
				items: [
					{
						name: 'Model scope',
						aliases: ['unified', 'per feature', 'per task'],
						desc: 'One model for every feature, or a model for each.',
						visible: () => this.onServer(),
						control: {
							type: 'dropdown',
							key: 'modelScope',
							defaultValue: DEFAULT_SETTINGS.modelScope,
							options: { one: 'One model for everything', perFeature: 'A model per feature' },
						},
					},
					{
						name: 'Model',
						aliases: ['llm'],
						visible: () => this.oneModel(),
						render: (setting) => this.picker.renderModel(setting, 'llmModel', () => this.sharedModelDesc()),
					},
					{
						name: 'Summaries model',
						aliases: ['llm'],
						desc: 'Writes summaries. Titles and tags use it too unless set below.',
						visible: () => this.perFeature(),
						render: (setting) => this.picker.renderModel(setting, 'llmModel'),
					},
					{
						name: 'Titles and tags model',
						visible: () => this.perFeature(),
						render: (setting) => this.picker.renderModel(setting, 'tagsModel'),
					},
					{
						name: 'Vision model',
						aliases: ['pictures', 'images'],
						desc: 'Describes pictures; models known to read them are marked. None reads pictures for text only.',
						visible: () => this.perFeature(),
						render: (setting) => this.picker.renderModel(setting, 'visionModel'),
					},
					{
						type: 'page',
						name: 'Summaries',
						desc: 'A short summary at the top of each note.',
						visible: () => this.ai() !== 'off',
						// The model shows only on a server, where it is chosen; Readable's own picks its one model
						displayValue: () =>
							!this.owner.settings.summaries ? 'Off' : !this.onServer() ? 'On' : this.textModelName() ? `On · ${this.textModelName()}` : 'On, no model',
						status: () => (this.owner.settings.summaries && !this.textModelName() ? 'warning' : null),
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'Summaries',
										desc: 'Write a short summary at the top of each note. Text under 1,000 characters is left alone.',
										control: {
											type: 'toggle',
											key: 'summaries',
											defaultValue: DEFAULT_SETTINGS.summaries,
										},
									},
									{
										name: 'Length',
										visible: () => this.getControlValue('summaries') === true,
										control: {
											type: 'dropdown',
											key: 'summaryLength',
											defaultValue: DEFAULT_SETTINGS.summaryLength,
											options: SUMMARY_LENGTH_LABELS,
										},
									},
									{
										name: 'Instructions',
										aliases: ['prompt', 'language'],
										desc: 'What the summary should be like, in your words. The last sentence sets the language. Empty uses the default shown.',
										visible: () => this.getControlValue('summaries') === true,
										control: {
											type: 'textarea',
											key: 'summaryPrompt',
											defaultValue: DEFAULT_SETTINGS.summaryPrompt,
											placeholder: DEFAULT_PROMPTS.summary,
											rows: 4,
										},
									},
								],
							},
						],
					},
					{
						type: 'page',
						name: 'Titles and tags',
						aliases: ['title', 'tags', 'alias'],
						visible: () => this.ai() !== 'off',
						desc: 'A title and topic tags from the content, so notes named after their files are still found by what they are.',
						displayValue: () => this.titlesAndTagsSummary(),
						items: [
							{
								type: 'group',
								items: [
									{
										name: 'Title',
										desc: 'Set the title property and an alias from the content, so search and links find the note by its title.',
										control: {
											type: 'toggle',
											key: 'titles',
											defaultValue: DEFAULT_SETTINGS.titles,
										},
									},
									{
										name: 'Tags',
										desc: 'Add a few topic tags to each note, next to the readable and file-type tags. Lower-case, hyphenated.',
										control: {
											type: 'toggle',
											key: 'tags',
											defaultValue: DEFAULT_SETTINGS.tags,
										},
									},
									{
										name: 'How many tags',
										visible: () => this.getControlValue('tags') === true,
										control: {
											type: 'dropdown',
											key: 'tagCount',
											defaultValue: String(DEFAULT_SETTINGS.tagCount),
											options: TAG_COUNT_OPTIONS,
										},
									},
									{
										name: 'Instructions',
										aliases: ['prompt', 'language'],
										desc: 'How to pick the title and tags, in your words. Empty uses the default shown.',
										visible: () => this.getControlValue('tags') === true || this.getControlValue('titles') === true,
										control: {
											type: 'textarea',
											key: 'tagsPrompt',
											defaultValue: DEFAULT_SETTINGS.tagsPrompt,
											placeholder: DEFAULT_PROMPTS.tags,
											rows: 4,
										},
									},
								],
							},
						],
					},
				],
			},
			{
				type: 'group',
				heading: 'Advanced',
				items: [
					{
						name: 'Developer mode',
						desc: 'Show internal events as notices and keep a developer log.',
						control: {
							type: 'toggle',
							key: 'devMode',
							defaultValue: DEFAULT_SETTINGS.devMode,
						},
					},
				],
			},
		];
	}
}
