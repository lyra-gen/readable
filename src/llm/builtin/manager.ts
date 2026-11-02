import * as os from 'os';
import * as path from 'path';
import { errorMessage, isAbort } from '../../core/errors';
import { scanModels } from './catalog';
import type { LocalModel } from './catalog';
import { deleteModelFiles, downloadModel, expectedLlamaManifest, installLlama, LlamaInstallError, modelDir, readLlamaManifest, uninstallLlama } from './installer';
import type { LlamaManifest, LlamaStep } from './installer';
import { llamaPaths } from './paths';
import type { LlamaPaths } from './paths';
import { catalogModel, CATALOG, recommendedModel } from './release';
import type { CatalogModel } from './release';
import { LlamaServer } from './server';

export type LlamaState =
	| { kind: 'checking' }
	| { kind: 'missing' }
	| { kind: 'outdated'; manifest: LlamaManifest }
	| { kind: 'installed'; manifest: LlamaManifest }
	| { kind: 'installing'; step: LlamaStep; detail?: string }
	| { kind: 'failed'; message: string };

/** Loading a large model from a cold disk takes a while. */
const START_TIMEOUT_MS = 180_000;

export interface ManagedLlamaDeps {
	devLog: (line: string) => void;
	/** The user's extra models folder; '' for none. Readable's own folder is always scanned. */
	modelsFolder: () => string;
	/** How long a loaded model stays in memory after the last request. */
	idleMs: () => number;
}

/** What a model is for: any model reads text; pictures need a vision part. */
export type ModelUse = 'text' | 'vision';

/** A catalog download in progress. */
export interface Download {
	detail: string;
	abort: AbortController;
}

/** The catalog model this computer has the memory for. */
export function recommendedForThisComputer(): CatalogModel {
	return recommendedModel(os.totalmem() / 1024 ** 3);
}

/**
 * The model to use for `id` and `use` among `models`: the chosen one when it
 * is there and fits, else the recommended catalog model, else the first
 * catalog model downloaded, else any model that fits. Null when none fits.
 */
export function pickModel(models: LocalModel[], id: string, use: ModelUse): LocalModel | null {
	const fits = (m: LocalModel) => use === 'text' || m.projector !== null;
	const chosen = id ? models.find((m) => m.id === id && fits(m)) : undefined;
	if (chosen) return chosen;
	const byCatalog = [recommendedForThisComputer().id, ...CATALOG.map((c) => c.id)];
	for (const cid of byCatalog) {
		const found = models.find((m) => m.catalog === cid && fits(m));
		if (found) return found;
	}
	return models.find(fits) ?? null;
}

/**
 * Readable's own AI: the server's install state, the catalog downloads,
 * and the llama-server process. The AI choice "Readable's own" resolves to
 * this server's URL, starting it with the right model when a request needs it.
 */
export class ManagedLlama {
	readonly paths: LlamaPaths = llamaPaths();
	readonly server: LlamaServer;
	private state: LlamaState = { kind: 'checking' };
	private installAbort: AbortController | null = null;
	private readonly downloadsById = new Map<string, Download>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: ManagedLlamaDeps) {
		this.server = new LlamaServer(this.paths, {
			onStderr: (line) => deps.devLog(`[llama] ${line}`),
			onStateChange: () => this.emit(),
			idleMs: deps.idleMs,
			startTimeoutMs: START_TIMEOUT_MS,
		});
	}

	async init(): Promise<void> {
		const manifest = await readLlamaManifest(this.paths);
		if (!manifest) return this.setState({ kind: 'missing' });
		const current = manifest.build === expectedLlamaManifest().build;
		this.setState(current ? { kind: 'installed', manifest } : { kind: 'outdated', manifest });
	}

	get installState(): LlamaState {
		return this.state;
	}

	/** The server is installed (possibly by an older version); models are separate. */
	get ready(): boolean {
		return this.state.kind === 'installed' || this.state.kind === 'outdated';
	}

	/** Catalog downloads in progress, by catalog id. */
	get downloads(): ReadonlyMap<string, Download> {
		return this.downloadsById;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Readable's folder first (a downloaded model wins a name clash), then the user's. */
	modelFolders(): string[] {
		const extra = this.deps.modelsFolder().trim().replace(/^~(?=$|[\\/])/, os.homedir());
		return extra && path.resolve(extra) !== path.resolve(this.paths.models) ? [this.paths.models, extra] : [this.paths.models];
	}

	/** Every model in the folders. Scanned on each call: folders change while Obsidian runs. */
	models(): Promise<LocalModel[]> {
		return scanModels(this.modelFolders());
	}

	/** True for a model in Readable's own folder, which Readable may delete. */
	owns(model: LocalModel): boolean {
		return path.resolve(model.path).startsWith(path.resolve(this.paths.models) + path.sep);
	}

	/** The model for `id` and `use`, as pickModel chooses it. Throws when there is none. */
	async resolve(id: string, use: ModelUse): Promise<LocalModel> {
		const models = await this.models();
		const model = pickModel(models, id, use);
		if (!model) {
			throw new Error(
				use === 'vision'
					? "No downloaded model reads pictures. Download one under Settings › AI › Models."
					: 'No model downloaded. Download one under Settings › AI › Models.',
			);
		}
		if (id && model.id !== id) this.deps.devLog(`[llama] ${id} is not available${use === 'vision' ? ' for pictures' : ''}; using ${model.id}`);
		return model;
	}

	/** Serves the model for `id`, starting or switching the server; resolves with its base URL. */
	async ensureRunning(id: string, use: ModelUse): Promise<{ url: string; model: LocalModel }> {
		if (!this.ready) throw new Error("Readable's AI isn't installed. Install it under Settings › AI.");
		const model = await this.resolve(id, use);
		return { url: await this.server.start(model), model };
	}

	/** Installs or updates the server, and downloads the recommended model when no catalog model is there yet. */
	async install(): Promise<boolean> {
		if (this.state.kind === 'installing') return false;
		this.server.stop();
		const abort = new AbortController();
		this.installAbort = abort;
		try {
			const haveCatalogModel = (await this.models()).some((m) => m.catalog);
			await installLlama(
				this.paths,
				(step, detail) => this.setState({ kind: 'installing', step, detail }),
				abort.signal,
				haveCatalogModel ? undefined : recommendedForThisComputer(),
			);
			const manifest = await readLlamaManifest(this.paths);
			if (!manifest) throw new LlamaInstallError('The install did not finish.');
			this.setState({ kind: 'installed', manifest });
			return true;
		} catch (error) {
			if (isAbort(error)) {
				await this.init();
				return false;
			}
			if (error instanceof LlamaInstallError && error.detail) this.deps.devLog(`[llama install] ${error.detail}`);
			this.setState({ kind: 'failed', message: errorMessage(error) });
			return false;
		} finally {
			this.installAbort = null;
		}
	}

	cancelInstall(): void {
		this.installAbort?.abort();
	}

	/** Downloads a catalog model; resolves true when it is ready to use. Several may run at once. */
	async downloadModel(id: string): Promise<boolean> {
		const model = catalogModel(id);
		if (!model || this.downloadsById.has(id)) return false;
		const download: Download = { detail: 'Starting…', abort: new AbortController() };
		this.downloadsById.set(id, download);
		this.emit();
		try {
			await downloadModel(
				this.paths,
				model,
				(detail) => {
					download.detail = detail;
					this.emit();
				},
				download.abort.signal,
			);
			return true;
		} catch (error) {
			if (!isAbort(error)) {
				this.deps.devLog(`[llama] download of ${id} failed: ${errorMessage(error)}`);
				throw error;
			}
			return false;
		} finally {
			this.downloadsById.delete(id);
			this.emit();
		}
	}

	cancelDownload(id: string): void {
		this.downloadsById.get(id)?.abort.abort();
	}

	/** Deletes a model in Readable's folder, stopping the server first if it is loaded. */
	async deleteModel(model: LocalModel): Promise<void> {
		if (this.server.loadedModel?.path === model.path) this.server.stop();
		const catalog = model.catalog ? catalogModel(model.catalog) : undefined;
		await deleteModelFiles(this.paths, catalog ? path.join(modelDir(this.paths, catalog), catalog.weights.name) : model.path, model.projector);
		this.emit();
	}

	/** Deletes the server and every downloaded model. */
	async remove(): Promise<void> {
		this.cancelInstall();
		for (const id of [...this.downloadsById.keys()]) this.cancelDownload(id);
		this.server.stop();
		await uninstallLlama(this.paths);
		this.setState({ kind: 'missing' });
	}

	dispose(): void {
		this.cancelInstall();
		for (const id of [...this.downloadsById.keys()]) this.cancelDownload(id);
		this.server.dispose();
		this.listeners.clear();
	}

	private setState(state: LlamaState): void {
		this.state = state;
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
