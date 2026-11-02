import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { requestUrl } from 'obsidian';
import sidecarSource from '../../../../python/docling_sidecar.py';
import { abortError, throwIfAborted } from '../../../core/errors';
import { managedEnv } from './paths';
import type { ManagedPaths } from './paths';
import { ADDON_PACKAGES, DOCLING_VERSION, HEIF_PACKAGE, PYTHON_VERSION, RESOLVE_CUTOFF, UV_VERSION, uvAsset } from './release';

/** Where packages come from; passed explicitly so an environment variable cannot change it. */
const PYPI = 'https://pypi.org/simple';

/**
 * Installs managed Docling into the app-data folder, never the vault. It
 * downloads the pinned uv (checked against its sha256), has uv create a venv
 * with a Python of its own, installs the pinned Docling and the base add-ons
 * with dependencies resolved as of RESOLVE_CUTOFF, writes the sidecar script
 * bundled in main.js, and has the sidecar fetch the models. Add-ons (speech,
 * OCR engines) are added to an existing install later. install.json records
 * what is there: a different Docling or Python means an update, which starts
 * fresh; a missing newer base add-on is added in place; a changed sidecar
 * script is only rewritten at load.
 * ManagedDocling drives all of this and owns the sidecar.
 */

export type InstallStep = 'uv' | 'python' | 'docling' | 'models' | 'cleanup' | 'speech' | 'speech-model' | 'ocr' | 'ocr-model';

export const STEP_LABELS: Record<InstallStep, string> = {
	uv: 'Downloading the installer',
	python: 'Installing Python',
	docling: 'Installing Docling',
	models: 'Downloading models',
	cleanup: 'Finishing',
	speech: 'Installing speech recognition',
	'speech-model': 'Downloading the speech model',
	ocr: 'Installing the OCR engine',
	'ocr-model': 'Downloading OCR models',
};

export type AddonId = keyof typeof ADDON_PACKAGES;
export const ADDON_IDS = Object.keys(ADDON_PACKAGES) as AddonId[];

interface AddonSpec {
	step: InstallStep;
	/** When set, `downloadModels` runs under this step after the packages are in. */
	modelStep?: InstallStep;
	platforms?: NodeJS.Platform[];
	/** Runs after the packages are installed, before models. */
	after?: (paths: ManagedPaths, signal: AbortSignal) => Promise<void>;
}

const ADDONS: Record<AddonId, AddonSpec> = {
	speech: { step: 'speech', modelStep: 'speech-model', after: exposeFfmpeg },
	ocrmac: { step: 'ocr', platforms: ['darwin'] },
	rapidocr: { step: 'ocr', modelStep: 'ocr-model' },
	opendocument: { step: 'docling' },
};

/** Add-ons the base install includes on this platform, so they need no separate Install. */
export function baseAddons(): AddonId[] {
	return process.platform === 'darwin' ? ['opendocument', 'ocrmac'] : ['opendocument'];
}

/** Base add-ons an install lacks because it predates them; added in place, without reinstalling. */
export function missingBaseAddons(manifest: InstallManifest): AddonId[] {
	const installed = addonsOf(manifest);
	return baseAddons().filter((a) => !installed.includes(a));
}

/** Whether the install has this release's Docling and Python, so an update can add packages in place. */
export function sameRelease(manifest: InstallManifest): boolean {
	const expected = expectedManifest();
	return manifest.docling === expected.docling && manifest.python === expected.python;
}

export function addonAvailable(addon: AddonId): boolean {
	const platforms = ADDONS[addon].platforms;
	return !platforms || platforms.includes(process.platform);
}

/** The add-ons a manifest records; pre-release installs wrote `speech: true` instead. */
export function addonsOf(manifest: InstallManifest): AddonId[] {
	return manifest.addons ?? (manifest.speech ? ['speech'] : []);
}

export type InstallProgress = (step: InstallStep, detail?: string) => void;

/** uv's summary lines: "Resolved 98 packages", "Prepared 98 packages", "Installed 98 packages". */
const UV_PROGRESS = /^(Resolved|Prepared|Installed|Downloading)\b.*/;

/** What install.json records. A mismatch with the running plugin means "update needed". */
export interface InstallManifest {
	uv: string;
	docling: string;
	python: string;
	/** sha256 of the sidecar script, so a changed script is rewritten. */
	sidecar: string;
	installedAt: number;
	addons?: AddonId[];
	/** Pre-release form of `addons: ['speech']`. */
	speech?: boolean;
}

export class InstallError extends Error {
	constructor(
		message: string,
		/** Output tail of the failing command, for the dev log. */
		readonly detail = '',
	) {
		super(message);
		this.name = 'InstallError';
	}
}

export function expectedManifest(): Omit<InstallManifest, 'installedAt'> {
	return { uv: UV_VERSION, docling: DOCLING_VERSION, python: PYTHON_VERSION, sidecar: sha256(sidecarSource) };
}

export async function readManifest(paths: ManagedPaths): Promise<InstallManifest | null> {
	try {
		return JSON.parse(await fs.readFile(paths.manifest, 'utf8')) as InstallManifest;
	} catch {
		return null;
	}
}

/**
 * Installs everything managed mode needs into `paths.root`. Each step is
 * skipped when its result is already there, so a failed or cancelled install
 * resumes where it stopped. install.json is written last: until then the
 * install counts as missing.
 *
 * `downloadModels` runs the sidecar's `download`; the caller owns the sidecar.
 */
export async function install(
	paths: ManagedPaths,
	progress: InstallProgress,
	downloadModels: () => Promise<void>,
	signal: AbortSignal,
	/** Update: drop the old Python, packages and models first, so versions never pile up. */
	fresh = false,
): Promise<void> {
	await fs.mkdir(paths.root, { recursive: true });
	await fs.rm(paths.manifest, { force: true });
	if (fresh) {
		for (const dir of [paths.venv, paths.models, paths.pythons, paths.uvCache]) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	progress('uv');
	if (!(await uvMatches(paths, signal))) await installUv(paths, signal);

	progress('python');
	if (!(await exists(paths.python))) {
		await run(paths.uv, ['venv', '--python', PYTHON_VERSION, '--python-preference', 'only-managed', paths.venv], paths, signal);
	}

	progress('docling');
	const addons = baseAddons();
	await pipInstall(paths, [`docling==${DOCLING_VERSION}`, HEIF_PACKAGE, ...addons.flatMap((a) => ADDON_PACKAGES[a])], 'docling', progress, signal);
	await fs.writeFile(paths.sidecar, sidecarSource, 'utf8');

	progress('models');
	throwIfAborted(signal);
	await downloadModels();

	progress('cleanup');
	await fs.rm(paths.uvCache, { recursive: true, force: true });
	await fs.rm(paths.tmp, { recursive: true, force: true });
	await writeManifest(paths, { ...expectedManifest(), installedAt: Date.now(), addons });
}

/**
 * Adds one add-on to an existing install: its packages, any follow-up step,
 * then its models through `downloadModels` (the sidecar's `download`; the
 * caller owns the sidecar). Records it in install.json when done.
 */
export async function installAddon(
	paths: ManagedPaths,
	manifest: InstallManifest,
	addon: AddonId,
	progress: InstallProgress,
	downloadModels: () => Promise<void>,
	signal: AbortSignal,
): Promise<InstallManifest> {
	const spec = ADDONS[addon];
	if (!addonAvailable(addon)) throw new InstallError(`This add-on is not available on ${process.platform}.`);
	progress(spec.step);
	await pipInstall(paths, [...ADDON_PACKAGES[addon]], spec.step, progress, signal);
	await spec.after?.(paths, signal);
	if (spec.modelStep) {
		progress(spec.modelStep);
		throwIfAborted(signal);
		await downloadModels();
	}
	await fs.rm(paths.uvCache, { recursive: true, force: true });
	const updated: InstallManifest = { ...manifest, addons: [...new Set([...addonsOf(manifest), addon])] };
	delete updated.speech;
	await writeManifest(paths, updated);
	return updated;
}

/** Whisper runs `ffmpeg` from PATH; expose the wheel's binary under that name in bin/. */
async function exposeFfmpeg(paths: ManagedPaths, signal: AbortSignal): Promise<void> {
	const source = (await run(paths.python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], paths, signal)).trim();
	const target = path.join(paths.bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
	await fs.mkdir(paths.bin, { recursive: true });
	await fs.rm(target, { force: true });
	await fs.copyFile(source, target);
	await fs.chmod(target, 0o755);
}

/** Rewrites the sidecar script when the plugin ships a new one; no reinstall needed. */
export async function refreshSidecar(paths: ManagedPaths, manifest: InstallManifest): Promise<InstallManifest> {
	await ensureSidecarScript(paths);
	const expected = expectedManifest();
	if (manifest.sidecar === expected.sidecar) return manifest;
	const updated = { ...manifest, sidecar: expected.sidecar };
	await writeManifest(paths, updated);
	return updated;
}

/**
 * The script on disk is exactly the one bundled in the plugin; anything else
 * there (an older version, or a change by another program) is overwritten.
 * Runs before every start of the sidecar.
 */
export async function ensureSidecarScript(paths: ManagedPaths): Promise<void> {
	const current = await fs.readFile(paths.sidecar, 'utf8').catch(() => null);
	if (current === sidecarSource) return;
	await fs.mkdir(paths.root, { recursive: true });
	await fs.writeFile(paths.sidecar, sidecarSource, 'utf8');
}

/** The OS's tar by its full path, so nothing on PATH can stand in for it. */
function systemTar(): string {
	if (process.platform === 'win32') return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
	return '/usr/bin/tar';
}

/** Deletes the whole managed folder. The caller stops the sidecar first. */
/**
 * Removes managed Docling and only that. The app-data folder also holds
 * Readable's own AI with its models (`llama/`) and each vault's queue
 * (`vaults/`), which must survive removing Docling.
 */
export async function uninstall(paths: ManagedPaths): Promise<void> {
	// Guard against a bad root ever deleting something else
	if (!/readable$/i.test(path.basename(paths.root))) throw new InstallError(`Refusing to delete in ${paths.root}`);
	// The manifest first: if removal stops halfway, Docling reads as not installed rather than broken
	await fs.rm(paths.manifest, { force: true });
	for (const item of [paths.sidecar, paths.venv, paths.bin, paths.pythons, paths.models, paths.uvCache, paths.tmp, paths.checkpoints]) {
		await fs.rm(item, { recursive: true, force: true });
	}
}

async function writeManifest(paths: ManagedPaths, manifest: InstallManifest): Promise<void> {
	await fs.writeFile(paths.manifest, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * `uv pip install` into the managed venv, reporting uv's summary lines as
 * `step` progress. The index is named so nothing in the environment can
 * point uv elsewhere; uv checks each file against the index's sha256.
 */
async function pipInstall(paths: ManagedPaths, packages: string[], step: InstallStep, progress: InstallProgress, signal: AbortSignal): Promise<void> {
	await run(
		paths.uv,
		['pip', 'install', '--python', paths.python, '--default-index', PYPI, '--exclude-newer', RESOLVE_CUTOFF, ...packages],
		paths,
		signal,
		(line) => {
			const match = UV_PROGRESS.exec(line.trim());
			if (match) progress(step, match[0]);
		},
	);
}

async function uvMatches(paths: ManagedPaths, signal: AbortSignal): Promise<boolean> {
	if (!(await exists(paths.uv))) return false;
	try {
		const out = await run(paths.uv, ['--version'], paths, signal);
		return out.includes(UV_VERSION);
	} catch {
		return false;
	}
}

async function installUv(paths: ManagedPaths, signal: AbortSignal): Promise<void> {
	const asset = uvAsset();
	if (!asset) throw new InstallError(`Docling can't be installed on this system (${process.platform} ${process.arch}).`);
	let bytes: ArrayBuffer;
	try {
		bytes = (await requestUrl({ url: asset.url, method: 'GET' })).arrayBuffer;
	} catch (error) {
		throw new InstallError(`Couldn't download the installer. Check your internet connection.`, String(error));
	}
	throwIfAborted(signal);
	const actual = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
	if (actual !== asset.sha256) {
		throw new InstallError('The installer download was corrupted. Try again.', `sha256 ${actual}, expected ${asset.sha256}`);
	}

	await fs.rm(paths.tmp, { recursive: true, force: true });
	const unpacked = path.join(paths.tmp, 'uv');
	await fs.mkdir(unpacked, { recursive: true });
	const archive = path.join(paths.tmp, asset.file);
	await fs.writeFile(archive, new Uint8Array(bytes));
	// bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads the Windows .zip
	await run(systemTar(), ['-xf', archive, '-C', unpacked], paths, signal);

	const binary = await findFile(unpacked, path.basename(paths.uv));
	if (!binary) throw new InstallError('The installer download had an unexpected layout.');
	await fs.mkdir(path.dirname(paths.uv), { recursive: true });
	await fs.copyFile(binary, paths.uv);
	await fs.chmod(paths.uv, 0o755);
}

async function findFile(dir: string, name: string): Promise<string | null> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return full;
		if (entry.isDirectory()) {
			const found = await findFile(full, name);
			if (found) return found;
		}
	}
	return null;
}

const OUTPUT_TAIL_CHARS = 4000;

/** Runs a command to completion; rejects with its output tail on a non-zero exit. Abort kills it. */
function run(
	command: string,
	args: string[],
	paths: ManagedPaths,
	signal: AbortSignal,
	onLine?: (line: string) => void,
): Promise<string> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env: managedEnv(paths, { online: true }), windowsHide: true });
		let output = '';
		let partial = '';
		const onData = (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			output = (output + text).slice(-OUTPUT_TAIL_CHARS);
			if (!onLine) return;
			const lines = (partial + text).split(/\r?\n|\r/);
			partial = lines.pop() ?? '';
			lines.forEach(onLine);
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		const onAbort = () => child.kill('SIGKILL');
		signal.addEventListener('abort', onAbort, { once: true });
		child.on('error', (error) => {
			signal.removeEventListener('abort', onAbort);
			reject(new InstallError(`Couldn't run ${path.basename(command)}: ${error.message}`));
		});
		child.on('close', (code) => {
			signal.removeEventListener('abort', onAbort);
			if (signal.aborted) return reject(abortError());
			if (code === 0) return resolve(output);
			reject(new InstallError(`${path.basename(command)} ${args[0] ?? ''} failed (exit ${String(code)})`, output));
		});
	});
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

