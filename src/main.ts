import { resolveOcrLanguages } from './extract/docling/ocr-languages';
import { FileSystemAdapter, Plugin, TFile } from 'obsidian';
import type { IngestService } from './core/ingest-service';
import { PersistentIngestService } from './queue/service';
import { isEngineFatal } from './core/types';
import type { JobTrigger } from './core/types';
import { errorMessage } from './core/errors';
import { LlmClient, openAiBaseUrl } from './llm/client';
import { ManagedLlama, recommendedForThisComputer } from './llm/builtin/manager';
import { promptOr } from './llm/prompts';
import type { EnrichTarget } from './llm/enrich';
import { enrichTargetFrom, visionTargetFrom } from './llm/targets';
import { serverUrl, takesKey } from './llm/providers';
import type { VisionTarget } from './llm/targets';
import type { DoclingCommonOptions } from './extract/docling/options';
import { ManagedDocling } from './extract/docling/managed/manager';
import { ExtractorRegistry } from './extract/registry';
import { attachmentsOf, filesInFolder, isIngestable } from './ingest/targets';
import { excludedByExtension } from './extract/kinds';
import { followSourceRenames } from './notes/follow-rename';
import { IngestedIndex } from './notes/ingested-index';
import { InlineWriter } from './notes/inline-writer';
import { NoteWriter } from './notes/writer';
import { QueueStore } from './queue/store';
import { extractionPolicy, normalizeSettings } from './settings/model';
import { ReadableSettingTab } from './settings/tab';
import type { ReadableSettings } from './settings/model';
import type { UiActions } from './ui/actions';
import { ExplorerBadges, latestJobs } from './ui/badges';
import { bindServiceToUi } from './ui/bindings';
import { createAiCommands } from './ui/ai-commands';
import { confirmAndInstall } from './ui/docling-install';
import { registerCommands } from './ui/commands';
import { configureDevLog, devLog, devNotice } from './ui/dev-log';
import { registerFileMenus } from './ui/file-menus';
import { FolderPicker } from './ui/folder-picker';
import { buildIngestMenu } from './ui/ingest-menu';
import { openJobLog } from './ui/log-modal';
import { showMenuForButton } from './ui/menu';
import { noticeWithAction, notify, ResultNotifier } from './ui/notices';
import { QueueView } from './ui/queue-view';
import { openNote, openQueue, openSettings, QUEUE_VIEW_TYPE } from './ui/workspace';
import { StatusBar } from './ui/status-bar';
import { vaultDataDir } from './storage/app-data';
import { registerAttachWatcher } from './watch/attach-watcher';
import { registerVaultWatcher } from './watch/vault-watcher';

/**
 * The plugin's entry point, and the one place that wires Readable together.
 * onload builds the backend first (managed Docling, the built-in model server,
 * the model client, the persistent queue and its pipeline), then the passive UI
 * (status bar, explorer badges, notices), the active UI (queue view, ribbon
 * menu, commands, file menus) and the two watchers behind auto-ingest. Other
 * modules get services and settings as callbacks that read this.settings when
 * called, so a settings change applies without a reload. Persisted jobs resume
 * only at layout ready, once the vault index is built.
 */
export default class ReadablePlugin extends Plugin {
	settings!: ReadableSettings;
	/** Docling installed and run by Readable; shared with the settings tab. */
	managedDocling!: ManagedDocling;
	/** The model server; shared with the settings tab for "Test connection". */
	llm!: LlmClient;
	/** The model server Readable installs and runs itself; the provider "Built-in". */
	llama!: ManagedLlama;
	private service!: IngestService;
	private badges!: ExplorerBadges;

	async onload() {
		await this.loadSettings();
		configureDevLog(() => this.settings.devMode);

		// Backend
		const ingested = new IngestedIndex(this);
		const adapter = this.app.vault.adapter;
		this.managedDocling = new ManagedDocling({
			fullPath: (vaultPath) => (adapter instanceof FileSystemAdapter ? adapter.getFullPath(vaultPath) : vaultPath),
			options: () => ({
				...this.doclingCommon(),
				language: this.settings.speechLanguage,
				timestamps: this.settings.speechTimestamps,
				vision: this.visionTarget(),
				describePictures: this.settings.documentPictures === 'describe',
				describeImages: this.settings.images === 'describe',
			}),
			prepare: async () => {
				// A vision target on the built-in server needs it running before the sidecar reads the URL
				const describing = this.settings.documentPictures === 'describe' || this.settings.images === 'describe';
				if (this.builtinProvider() && describing && this.llama.ready) {
					await this.llama
						.ensureRunning(this.settings.builtinModel, 'vision')
						.catch((error: unknown) => devLog(`[llama] ${errorMessage(error)}`));
				}
			},
			devLog: (line) => devLog(line),
		});
		this.register(() => this.managedDocling.dispose());
		const doclingInit = this.managedDocling.init();
		this.llama = new ManagedLlama({
			devLog: (line) => devLog(line),
			modelsFolder: () => this.settings.builtinModelsFolder,
			idleMs: () => this.settings.builtinKeepLoaded * 60_000,
		});
		this.register(() => this.llama.dispose());
		void this.llama.init();
		this.llm = new LlmClient(() =>
			this.builtinProvider()
				? { baseUrl: this.llama.server.baseUrl ?? 'http://127.0.0.1', apiKey: this.llama.server.apiKey, ensure: async (model) => (await this.llama.ensureRunning(model, 'text')).url }
				: { baseUrl: serverUrl(this.settings), apiKey: this.serverKey() },
		);
		// After everything the tab reads (Docling, the built-in server, the model client): Obsidian may build its definitions right away
		this.addSettingTab(new ReadableSettingTab(this.app, this));
		const service = new PersistentIngestService({
			app: this.app,
			store: new QueueStore(vaultDataDir(this.app)),
			extractors: new ExtractorRegistry(() => this.managedDocling.extractor),
			writer: new NoteWriter(this.app, () => this.settings, () => this.settings.extractFormat, ingested),
			inline: new InlineWriter(this.app, () => this.settings.inlineFormat, ingested),
			outputMode: () => this.settings.outputMode,
			maxNoteBytes: () => this.settings.largestNoteMb * 1024 * 1024,
			isOwnNote: (note, sourcePath) => ingested.isNoteFor(note, sourcePath),
			pictures: () => this.settings.documentPictures,
			figures: () => ({ location: this.settings.figureLocation, group: this.settings.groupFigures }),
			policy: () => extractionPolicy(this.settings),
			llm: () => this.enrichTarget(),
			concurrency: () => this.settings.concurrency,
		});
		this.register(() => service.dispose());
		this.service = service;

		const actions = this.buildActions();

		// Passive UI
		const statusBar = new StatusBar(this, actions.openQueue);
		this.badges = new ExplorerBadges(this, (path) => ingested.has(path));
		this.register(ingested.onChange(() => this.badges.apply()));
		followSourceRenames(this, ingested);
		this.badges.setEnabled(this.settings.showBadges);
		const results = new ResultNotifier({
			openQueue: actions.openQueue,
			openLog: (job) => openJobLog(this.app, this.service, job),
			showDone: () => this.settings.notifyOnDone,
			openSettings: actions.openSettings,
			openNote: (notePath) => openNote(this.app, notePath),
			doclingMissing: () => !this.managedDocling.ready,
			installDocling: () => this.installDocling(),
		});
		this.register(() => results.dispose());
		bindServiceToUi(this, this.service, { statusBar, badges: this.badges, results });

		// Active UI
		this.registerView(QUEUE_VIEW_TYPE, (leaf) => new QueueView(leaf, this.service, actions));
		const ribbonEl = this.addRibbonIcon('file-input', 'Readable', () =>
			showMenuForButton(buildIngestMenu(actions), ribbonEl, 'right'),
		);
		// Dev helper: queue up to five real files from the vault
		const seedSampleJobs = () =>
			this.service.enqueue(
				this.app.vault.getFiles().filter(isIngestable).slice(0, 5).map((f) => f.path),
				'manual',
			);
		registerCommands(this, {
			actions,
			service: this.service,
			isDevMode: () => this.settings.devMode,
			dev: { seedSampleJobs, clearBadges: () => this.badges.clear() },
			ai: createAiCommands(this.app, ingested, () => this.enrichTarget()),
		});
		registerFileMenus(this, {
			ingest: (files, emptyMessage) => this.enqueueOrNotify(files, 'context-menu', emptyMessage),
			notesFor: (path) => ingested.notesFor(path),
			jobFor: (path) => latestJobs(this.service.getSnapshot().jobs).get(path),
			exclude: (paths) => this.service.excludePaths(paths),
			include: (jobIds) => this.service.includeJobs(jobIds),
		});
		// Jobs follow renamed and moved files, so a paused or excluded file stays so
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) this.service.renamePath(oldPath, file.path);
			}),
		);
		registerVaultWatcher(this, {
			isEnabled: () => this.settings.autoIngest,
			watchedFolder: () => this.settings.inboxFolder,
			reprocessOnModify: () => this.settings.reprocessOnModify,
			isIngested: (path) => ingested.has(path),
			isExcluded: (ext) => excludedByExtension(extractionPolicy(this.settings), ext),
			onFile: (file, why) => {
				devNotice(why === 'modified' ? 'Changed, reprocessing' : why === 'moved' ? 'Moved in' : 'Auto-ingest', file.path);
				this.service.enqueue([file.path], 'auto-ingest');
			},
			onBackfill: (files) => {
				devNotice('Backfill', `${files.length} file(s) without a note in the watched folder`);
				this.service.enqueue(files.map((f) => f.path), 'backfill');
			},
		});

		registerAttachWatcher(this, {
			isEnabled: () => this.settings.autoIngest && this.settings.outputMode !== 'note',
			isExcluded: (ext) => excludedByExtension(extractionPolicy(this.settings), ext),
			isOwnNote: (note, file) => ingested.isNoteFor(note, file.path),
			onAttached: (file, note) => {
				devNotice('Attached', `${file.path} in ${note.path}`);
				this.service.enqueue([file.path], 'auto-ingest');
			},
		});

		// obsidian://readable?action=settings|queue|dev-seed (dev mode)
		this.registerObsidianProtocolHandler('readable', (params) => {
			if (params.action === 'settings') actions.openSettings();
			else if (params.action === 'queue') actions.openQueue();
			else if (params.action === 'dev-seed' && this.settings.devMode) seedSampleJobs();
		});

		// Resume persisted jobs once the vault index is ready
		this.app.workspace.onLayoutReady(() => void service.init());
		// Docling reads every file but plain text: without it there is nothing to do, so ask straight away
		this.app.workspace.onLayoutReady(() => void doclingInit.then(() => this.promptDoclingInstall()));
	}

	/** Once per load, a notice that stays until dismissed, while Docling is not installed. */
	private promptDoclingInstall(): void {
		const kind = this.managedDocling.installState.kind;
		if (kind !== 'missing' && kind !== 'failed') return;
		noticeWithAction('Readable needs Docling to read files.', { label: 'Install', run: () => this.installDocling() }, 0);
	}

	private installDocling(): void {
		confirmAndInstall(this.app, this.managedDocling, () => this.onDoclingReady());
	}

	private buildActions(): UiActions {
		return {
			ingestActiveFile: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return notify('No file is open.');
				if (file.extension === 'md') return notify('The active file is a note. Use Ingest attachments instead.');
				if (!isIngestable(file)) return notify('Readable does not process this file.');
				this.service.enqueue([file.path], 'manual');
			},
			ingestNoteAttachments: () => {
				const note = this.app.workspace.getActiveFile();
				if (!note || note.extension !== 'md') return notify('Open a note first.');
				this.enqueueOrNotify(attachmentsOf(this.app, note), 'manual', `${note.basename} has no attachments to process.`);
			},
			ingestFolder: () => {
				new FolderPicker(this.app, (folder) =>
					this.enqueueOrNotify(filesInFolder(folder), 'manual', `${folder.path || 'Vault'} has no files to process.`),
				).open();
			},
			openQueue: () => void openQueue(this.app),
			openSettings: () => openSettings(this.app, this.manifest.id),
			isAutoIngest: () => this.settings.autoIngest,
			reduceMotion: () => this.settings.reduceMotion,
			setAutoIngest: (on) => {
				this.settings.autoIngest = on;
				void this.saveSettings();
			},
		};
	}

	private enqueueOrNotify(files: TFile[], trigger: JobTrigger, emptyMessage: string): void {
		if (files.length === 0) return notify(emptyMessage);
		this.service.enqueue(files.map((f) => f.path), trigger);
	}

	/** A key from Obsidian's secret storage, by the setting that names it; null when unset. */
	secret(key: 'llmApiKey'): string | null {
		const name = this.settings[key];
		return name ? this.app.secretStorage.getSecret(name) : null;
	}

	/** The API key for the model server, when its provider takes one. */
	serverKey(): string | null {
		return takesKey(this.settings.aiProvider) ? this.secret('llmApiKey') : null;
	}

	/** The provider and the AI features to run on text; null when none is on or no model is chosen. */
	enrichTarget(): EnrichTarget | null {
		if (this.settings.aiProvider === 'off') return null;
		return enrichTargetFrom(this.settings, this.llm, this.builtinProvider() ? this.settings.builtinModel || recommendedForThisComputer().id : null);
	}

	/** AI runs on Readable's own model server. */
	builtinProvider(): boolean {
		return this.settings.aiProvider === 'own';
	}

	/** Docling conversion options from settings. */
	private doclingCommon(): DoclingCommonOptions {
		const s = this.settings;
		return {
			figures: s.documentPictures !== 'skip',
			ocr: { mode: s.doclingOcr, languages: resolveOcrLanguages(s.ocrLanguages), engine: s.ocrEngine },
			tableMode: s.doclingTableMode,
			timeoutSec: s.doclingTimeout,
		};
	}

	/** The model server and vision model, for picture descriptions; null when no vision model is set. */
	private visionTarget(): VisionTarget | null {
		if (this.settings.aiProvider === 'off') return null;
		if (this.builtinProvider()) {
			// prepare() started the server with the vision model; not running means not installed or failed
			const url = this.llama.server.baseUrl;
			const model = this.llama.server.loadedModel;
			if (!url || !model?.projector) return null;
			return { url: openAiBaseUrl(url), apiKey: this.llama.server.apiKey, model: model.id, prompt: promptOr('describe', this.settings.describePrompt) };
		}
		return visionTargetFrom(this.settings, this.llm, this.serverKey());
	}


	/** Managed Docling finished installing: retry what failed waiting for it, resume. */
	onDoclingReady(): void {
		this.retryEngineFailures();
		this.service.resume();
	}

	private retryEngineFailures(): void {
		for (const job of this.service.getSnapshot().jobs) {
			if (job.state === 'failed' && isEngineFatal(job.errorCode)) this.service.retry(job.id);
		}
	}

	async loadSettings() {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.badges.setEnabled(this.settings.showBadges);
		for (const leaf of this.app.workspace.getLeavesOfType(QUEUE_VIEW_TYPE)) {
			if (leaf.view instanceof QueueView) leaf.view.refreshSettings();
		}
	}
}
