import type { Extractor } from '../../types';
import { errorMessage, isAbort } from '../../../core/errors';
import type { DoclingCommonOptions } from '../options';
import { ManagedDoclingExtractor } from './extractor';
import { addonsOf, ensureSidecarScript, install, installAddon, InstallError, missingBaseAddons, readManifest, refreshSidecar, sameRelease, uninstall } from './installer';
import type { AddonId, InstallManifest, InstallStep } from './installer';
import { managedPaths } from './paths';
import type { ManagedPaths } from './paths';
import { DoclingSidecar, SidecarExited } from './sidecar';

export type InstallState =
	| { kind: 'checking' }
	| { kind: 'missing' }
	/** Installed by an older plugin version; still usable until updated. */
	| { kind: 'outdated'; manifest: InstallManifest }
	| { kind: 'installed'; manifest: InstallManifest }
	| { kind: 'installing'; step: InstallStep; detail?: string }
	| { kind: 'failed'; message: string };

/** Pictures are written to files for the pipeline to attach. */
export interface ManagedOptions extends DoclingCommonOptions {
	/** Whisper language code, or '' to detect. */
	language: string;
	/** Keep `[mm:ss]` segment markers in transcripts. */
	timestamps: boolean;
	/** The model server and vision model for descriptions; null when none is set. */
	vision: { url: string; apiKey: string | null; model: string; prompt: string } | null;
	/** Describe pictures inside documents. */
	describePictures: boolean;
	/** Describe standalone images. */
	describeImages: boolean;
}

export interface ManagedDoclingDeps {
	/** Vault-relative path → absolute path on disk. */
	fullPath: (vaultPath: string) => string;
	options: () => ManagedOptions;
	/** Runs before a job reads its options: a chance to start what they refer to (the built-in model server). */
	prepare?: () => Promise<void>;
	/** Sidecar stderr and install output, for the dev log. */
	devLog: (line: string) => void;
	/** Where LibreOffice is, for old Office files; `findLibreOffice` unless a test stands in. */
	findLibreOffice?: () => Promise<string | null>;
}

const IDLE_MS = 10 * 60_000;
/** Imports torch and Docling; slow on a cold disk. */
const START_TIMEOUT_MS = 180_000;

/**
 * Docling installed and run by Readable: install state, the sidecar
 * process, and the Extractor the queue uses. The plugin creates one at load;
 * the install controls (src/ui/docling-install.ts) call install, installAddon
 * and remove, and they and the settings redraw through onChange. An install
 * from an older plugin version stays usable (`outdated`) until updated; an
 * update that only lacks newer base add-ons adds them in place. Each install
 * stops the running sidecar first; during the install it starts only to fetch
 * models.
 */
export class ManagedDocling {
	readonly paths: ManagedPaths = managedPaths();
	readonly sidecar: DoclingSidecar;
	readonly extractor: Extractor;
	private state: InstallState = { kind: 'checking' };
	private installAbort: AbortController | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: ManagedDoclingDeps) {
		this.sidecar = new DoclingSidecar(this.paths, {
			onStderr: (line) => deps.devLog(`[docling] ${line}`),
			onStateChange: () => this.emit(),
			idleMs: IDLE_MS,
			startTimeoutMs: START_TIMEOUT_MS,
			// Models are fetched while installing; afterwards the sidecar runs with the network off
			online: () => this.state.kind === 'installing',
			beforeSpawn: () => ensureSidecarScript(this.paths),
		});
		this.extractor = new ManagedDoclingExtractor(this, deps);
	}

	/** Reads install.json. Call once at load. */
	async init(): Promise<void> {
		const manifest = await readManifest(this.paths);
		if (!manifest) return this.setState({ kind: 'missing' });
		const fresh = await refreshSidecar(this.paths, manifest).catch(() => manifest);
		const current = sameRelease(fresh) && missingBaseAddons(fresh).length === 0;
		this.setState(current ? { kind: 'installed', manifest: fresh } : { kind: 'outdated', manifest: fresh });
	}

	get installState(): InstallState {
		return this.state;
	}

	/** Usable now: installed, possibly by an older version. */
	get ready(): boolean {
		return this.manifest !== null;
	}

	/** The speech add-on is installed, so audio and video can be transcribed. */
	get speechInstalled(): boolean {
		return this.addonInstalled('speech');
	}

	addonInstalled(addon: AddonId): boolean {
		const manifest = this.manifest;
		return manifest !== null && addonsOf(manifest).includes(addon);
	}

	/**
	 * Adds an add-on to an existing install; resolves true when done. The
	 * sidecar's `download` fetches its models with `params` (e.g. the OCR
	 * languages to prefetch), and fails early when it cannot serve them.
	 */
	async installAddon(addon: AddonId, params: Record<string, unknown> = {}): Promise<boolean> {
		const manifest = this.manifest;
		if (!manifest) return false;
		return this.runInstall(
			(signal) =>
				installAddon(
					this.paths,
					manifest,
					addon,
					(step, detail) => this.setState({ kind: 'installing', step, detail }),
					async () => {
						await this.sidecar.request('download', { addon, ...params }, { signal });
					},
					signal,
				),
			{ kind: 'installed', manifest },
		);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Installs or updates. Resolves true when Docling is ready. */
	async install(): Promise<boolean> {
		if (this.state.kind === 'installing') return false;
		const manifest = this.manifest;
		if (this.state.kind === 'outdated' && manifest && sameRelease(manifest)) return this.addBaseAddons(manifest);
		const fresh = this.state.kind === 'outdated';
		return this.runInstall(async (signal) => {
			await install(
				this.paths,
				(step, detail) => this.setState({ kind: 'installing', step, detail }),
				async () => {
					await this.sidecar.request('download', { ocr: this.deps.options().ocr }, { signal });
				},
				signal,
				fresh,
			);
			const manifest = await readManifest(this.paths);
			if (!manifest) throw new InstallError('The install did not finish.');
			return manifest;
		}, { kind: 'missing' });
	}

	/** An update that only adds base add-ons newer than the install: their packages, in place. None has models. */
	private addBaseAddons(manifest: InstallManifest): Promise<boolean> {
		return this.runInstall(async (signal) => {
			let updated = manifest;
			for (const addon of missingBaseAddons(manifest)) {
				updated = await installAddon(
					this.paths,
					updated,
					addon,
					(step, detail) => this.setState({ kind: 'installing', step, detail }),
					() => Promise.resolve(),
					signal,
				);
			}
			return updated;
		}, { kind: 'outdated', manifest });
	}

	cancelInstall(): void {
		this.installAbort?.abort();
	}

	/** Stops the sidecar and deletes everything Readable installed. */
	async remove(): Promise<void> {
		this.cancelInstall();
		this.sidecar.kill();
		await uninstall(this.paths);
		this.setState({ kind: 'missing' });
	}

	dispose(): void {
		this.cancelInstall();
		this.sidecar.dispose();
		this.listeners.clear();
	}

	/** The install manifest when Docling is usable (installed or outdated). */
	private get manifest(): InstallManifest | null {
		return this.state.kind === 'installed' || this.state.kind === 'outdated' ? this.state.manifest : null;
	}

	/**
	 * Runs an install step with the sidecar stopped and cancel wired up.
	 * Success sets `installed`; a cancel restores `onAbort`; anything else sets `failed`.
	 */
	private async runInstall(work: (signal: AbortSignal) => Promise<InstallManifest>, onAbort: InstallState): Promise<boolean> {
		this.sidecar.dispose();
		const abort = new AbortController();
		this.installAbort = abort;
		try {
			const manifest = await work(abort.signal);
			this.setState({ kind: 'installed', manifest });
			return true;
		} catch (error) {
			this.sidecar.kill();
			if (isAbort(error)) {
				this.setState(onAbort);
				return false;
			}
			if (error instanceof InstallError && error.detail) this.deps.devLog(`[install] ${error.detail}`);
			if (error instanceof SidecarExited && error.stderrTail) this.deps.devLog(`[install] ${error.stderrTail}`);
			this.setState({ kind: 'failed', message: errorMessage(error) });
			return false;
		} finally {
			this.installAbort = null;
			// The install's sidecar ran online; the next start is offline
			this.sidecar.dispose();
		}
	}

	private setState(state: InstallState): void {
		this.state = state;
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
