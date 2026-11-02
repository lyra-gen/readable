import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { requestUrl } from 'obsidian';
import { abortError, throwIfAborted } from '../../core/errors';
import { downloadFile } from './download';
import type { LlamaPaths } from './paths';
import { LLAMA_BUILD, llamaAsset } from './release';
import type { CatalogModel } from './release';
import { writeWatchdog } from './server';

/**
 * Puts Readable's own model server on disk under app data: the llama.cpp
 * build for this platform, checked against its sha256 and unpacked whole into
 * `build/` with a BUILD marker, then catalog models, each in its own folder.
 * The server is downloaded again only when that marker names another build,
 * and ManagedLlama compares the build in install.json with LLAMA_BUILD to tell
 * an outdated install. Deleting is refused outside Readable's models folder,
 * so a model in the user's own folder is never touched.
 */

export type LlamaStep = 'server' | 'model' | 'cleanup';

export const LLAMA_STEP_LABELS: Record<LlamaStep, string> = {
	server: 'Downloading the model server',
	model: 'Downloading the model',
	cleanup: 'Finishing',
};

export type LlamaProgress = (step: LlamaStep, detail?: string) => void;

/** What install.json records: the server build. Models are tracked by their files. */
export interface LlamaManifest {
	build: string;
	installedAt: number;
}

export class LlamaInstallError extends Error {
	constructor(
		message: string,
		readonly detail = '',
	) {
		super(message);
		this.name = 'LlamaInstallError';
	}
}

export function expectedLlamaManifest(): Omit<LlamaManifest, 'installedAt'> {
	return { build: LLAMA_BUILD };
}

export async function readLlamaManifest(paths: LlamaPaths): Promise<LlamaManifest | null> {
	try {
		return JSON.parse(await fs.readFile(paths.manifest, 'utf8')) as LlamaManifest;
	} catch {
		return null;
	}
}

/**
 * Installs the server build into `paths.root`, then `model` when given (the
 * first install brings the recommended one). install.json is written once the
 * server is in; a model that fails to download leaves a working server.
 */
export async function installLlama(paths: LlamaPaths, progress: LlamaProgress, signal: AbortSignal, model?: CatalogModel): Promise<void> {
	await fs.mkdir(paths.models, { recursive: true });
	progress('server');
	if (!(await serverMatches(paths))) {
		await fs.rm(paths.manifest, { force: true });
		await installServer(paths, signal);
	}
	await writeWatchdog(paths.root);
	await fs.writeFile(paths.manifest, JSON.stringify({ ...expectedLlamaManifest(), installedAt: Date.now() }, null, 2), 'utf8');
	if (model) await downloadModel(paths, model, (detail) => progress('model', detail), signal);
	progress('cleanup');
	await fs.rm(paths.tmp, { recursive: true, force: true });
}

/** Where a catalog model lives: its own folder, so its vision part pairs with it alone. */
export function modelDir(paths: LlamaPaths, model: CatalogModel): string {
	return path.join(paths.models, model.id);
}

/**
 * Downloads a catalog model and its vision part with hash checks. Files
 * already complete are skipped, so a cancelled download resumes by file.
 */
export async function downloadModel(paths: LlamaPaths, model: CatalogModel, progress: (detail: string) => void, signal: AbortSignal): Promise<void> {
	const dir = modelDir(paths, model);
	await fs.mkdir(dir, { recursive: true });
	const files = [model.weights, model.projector];
	const total = files.reduce((sum, f) => sum + f.bytes, 0);
	let before = 0;
	for (const file of files) {
		const dest = path.join(dir, file.name);
		if (!(await sizeMatches(dest, file.bytes))) {
			throwIfAborted(signal);
			await downloadFile(file.url, dest, file, (done) => progress(percent(before + done, total)), signal);
		}
		before += file.bytes;
	}
}

/** Deletes a model's files: a catalog model's folder, or a single file and its unshared vision part. */
export async function deleteModelFiles(paths: LlamaPaths, modelPath: string, projector: string | null): Promise<void> {
	const inside = (p: string) => path.resolve(p).startsWith(path.resolve(paths.models) + path.sep);
	if (!inside(modelPath)) throw new LlamaInstallError("Only models in Readable's own folder can be deleted here.");
	const dir = path.dirname(modelPath);
	if (path.resolve(dir) !== path.resolve(paths.models)) {
		await fs.rm(dir, { recursive: true, force: true });
		return;
	}
	await fs.rm(modelPath, { force: true });
	// A projector beside models loose in the top folder may serve another one; keep it unless no model is left
	if (projector && inside(projector)) {
		const left = (await fs.readdir(dir)).filter((f) => /\.gguf$/i.test(f) && !/^mmproj/i.test(f));
		if (left.length === 0) await fs.rm(projector, { force: true });
	}
}

/** Deletes the whole folder. The caller stops the server first. */
export async function uninstallLlama(paths: LlamaPaths): Promise<void> {
	if (path.basename(paths.root) !== 'llama') throw new LlamaInstallError(`Refusing to delete ${paths.root}`);
	await fs.rm(paths.root, { recursive: true, force: true });
}

function percent(done: number, total: number): string {
	const mb = (n: number) => `${Math.round(n / 1_048_576)} MB`;
	return total > 0 ? `${Math.round((done / total) * 100)}% of ${mb(total)}` : mb(done);
}

async function sizeMatches(file: string, bytes: number): Promise<boolean> {
	try {
		return (await fs.stat(file)).size === bytes;
	} catch {
		return false;
	}
}

/** The build folder is the right llama.cpp build when its marker says so. */
async function serverMatches(paths: LlamaPaths): Promise<boolean> {
	try {
		await fs.access(paths.server);
		return (await fs.readFile(path.join(paths.build, 'BUILD'), 'utf8')).trim() === LLAMA_BUILD;
	} catch {
		return false;
	}
}

/** The build is small (10–25 MB), so it goes through requestUrl like uv; models stream to disk. */
async function installServer(paths: LlamaPaths, signal: AbortSignal): Promise<void> {
	const asset = llamaAsset();
	if (!asset) throw new LlamaInstallError(`The built-in model server has no build for this system (${process.platform} ${process.arch}).`);
	let bytes: ArrayBuffer;
	try {
		bytes = (await requestUrl({ url: asset.url, method: 'GET' })).arrayBuffer;
	} catch (error) {
		throw new LlamaInstallError("Couldn't download the model server. Check your internet connection.", String(error));
	}
	throwIfAborted(signal);
	const actual = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
	if (actual !== asset.sha256) throw new LlamaInstallError('The model server download was corrupted. Try again.', `sha256 ${actual}`);

	await fs.rm(paths.tmp, { recursive: true, force: true });
	const unpacked = path.join(paths.tmp, 'llama');
	await fs.mkdir(unpacked, { recursive: true });
	const archive = path.join(paths.tmp, asset.file);
	await fs.writeFile(archive, new Uint8Array(bytes));
	await run('tar', ['-xf', archive, '-C', unpacked], signal);

	// The binary and its libraries sit together; keep that folder whole as build/
	const binary = await findFile(unpacked, path.basename(paths.server));
	if (!binary) throw new LlamaInstallError('The model server download had an unexpected layout.');
	await fs.rm(paths.build, { recursive: true, force: true });
	await fs.rename(path.dirname(binary), paths.build);
	await fs.chmod(paths.server, 0o755).catch(() => undefined);
	await fs.writeFile(path.join(paths.build, 'BUILD'), LLAMA_BUILD, 'utf8');
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

function run(command: string, args: string[], signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true });
		let output = '';
		child.stdout.on('data', (c: Buffer) => (output = (output + c.toString()).slice(-2000)));
		child.stderr.on('data', (c: Buffer) => (output = (output + c.toString()).slice(-2000)));
		const onAbort = () => child.kill('SIGKILL');
		signal.addEventListener('abort', onAbort, { once: true });
		child.on('error', (error) => reject(new LlamaInstallError(`Couldn't run ${command}: ${error.message}`)));
		child.on('close', (code) => {
			signal.removeEventListener('abort', onAbort);
			if (signal.aborted) return reject(abortError());
			if (code === 0) return resolve();
			reject(new LlamaInstallError(`${command} failed (exit ${String(code)})`, output));
		});
	});
}
