import * as path from 'path';
import { appDataRoot } from '../../../storage/app-data';

/**
 * Where managed Docling lives: the per-user app-data folder, never the vault,
 * so sync never copies ~1.6 GB of Python and models.
 */
export interface ManagedPaths {
	root: string;
	/** The uv binary Readable downloaded. */
	uv: string;
	venv: string;
	/** The venv's interpreter; runs the sidecar. */
	python: string;
	sidecar: string;
	/** Written last; its presence means the install finished. */
	manifest: string;
	/** HF_HOME: the Whisper model and anything else fetched through Hugging Face. */
	models: string;
	/** Docling's layout, table and classifier models, downloaded at install and read from here, never over the network. */
	doclingModels: string;
	/** UV_PYTHON_INSTALL_DIR: the Python uv downloads. */
	pythons: string;
	/** UV_CACHE_DIR; deleted after install. */
	uvCache: string;
	/** Scratch space for downloads. */
	tmp: string;
	/** A folder per interrupted PDF: its finished page chunks, so the next attempt resumes. */
	checkpoints: string;
	/** `bin/`: uv, and ffmpeg once the speech add-on is installed. Put on PATH for the sidecar. */
	bin: string;
}

export function managedPaths(root = appDataRoot()): ManagedPaths {
	const win = process.platform === 'win32';
	const venv = path.join(root, 'venv');
	return {
		root,
		bin: path.join(root, 'bin'),
		uv: path.join(root, 'bin', win ? 'uv.exe' : 'uv'),
		venv,
		python: win ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'),
		sidecar: path.join(root, 'docling_sidecar.py'),
		manifest: path.join(root, 'install.json'),
		models: path.join(root, 'models'),
		doclingModels: path.join(root, 'models', 'docling'),
		pythons: path.join(root, 'python'),
		uvCache: path.join(root, 'uv-cache'),
		tmp: path.join(root, 'tmp'),
		checkpoints: path.join(root, 'checkpoints'),
	};
}

/**
 * Variables a child may inherit: what the OS, the shell and a proxy need.
 * Nothing else passes, so a `UV_INDEX_URL`, `HF_ENDPOINT` or `PYTHONPATH`
 * set in the user's environment cannot steer where packages, Python or
 * models come from, or what the sidecar imports.
 */
const INHERITED = new Set(
	[
		'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
		'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY',
		// Windows
		'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
		'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
		// Proxies and their certificates: corporate networks need them to download anything
		'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
	].map((k) => k.toUpperCase()),
);
const INHERITED_PREFIXES = ['LC_'];

export interface EnvOptions {
	/** Let Python reach the network for models: only while installing. Otherwise every model must already be on disk. */
	online?: boolean;
}

/**
 * The environment for every managed Python and uv process: everything points
 * into Readable's folder, and the user's own Python setup cannot leak in.
 */
export function managedEnv(paths: ManagedPaths, options: EnvOptions = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		const upper = key.toUpperCase();
		if (INHERITED.has(upper) || INHERITED_PREFIXES.some((p) => upper.startsWith(p))) env[key] = value;
	}
	const sep = process.platform === 'win32' ? ';' : ':';
	const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
	return {
		...env,
		[pathKey]: [paths.bin, env[pathKey] ?? ''].filter(Boolean).join(sep),
		PYTHONNOUSERSITE: '1',
		PYTHONUNBUFFERED: '1',
		PYTHONIOENCODING: 'utf-8',
		HF_HOME: paths.models,
		HF_ENDPOINT: 'https://huggingface.co',
		HF_HUB_DISABLE_TELEMETRY: '1',
		...(options.online ? {} : { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }),
		READABLE_DOCLING_MODELS: paths.doclingModels,
		UV_PYTHON_INSTALL_DIR: paths.pythons,
		UV_CACHE_DIR: paths.uvCache,
		UV_NO_CONFIG: '1',
	};
}
