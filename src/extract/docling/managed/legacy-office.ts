import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Old binary Office files (.doc, .xls, .ppt). Docling opens them only by
 * having LibreOffice convert them first, and LibreOffice is too big to
 * install for the user, so Readable uses one that is already there. On a Mac
 * a .doc can also go through textutil, which ships with macOS, when there is
 * no LibreOffice; textutil keeps text and tables but drops pictures. Without
 * either, the job fails with a message saying what to install. A snap
 * LibreOffice is passed over: its sandbox cannot read the temporary files
 * Docling hands it.
 */

export const LIBREOFFICE_DOWNLOAD_URL = 'https://www.libreoffice.org/download/download-libreoffice/';

const LEGACY_MIMES = ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'];
const LEGACY_EXT = /\.(doc|dot|xls|xlt|ppt|pot|pps)$/i;
/** textutil reads Word 97–2004 documents, not the spreadsheet or slide formats. */
const WORD_EXT = /\.(doc|dot)$/i;

export function isLegacyOffice(mime: string, filePath: string): boolean {
	if (LEGACY_MIMES.includes(mime)) return true;
	return mime === 'application/x-cfb' && LEGACY_EXT.test(filePath);
}

export function isLegacyWord(mime: string, filePath: string): boolean {
	return mime === 'application/msword' || (mime === 'application/x-cfb' && WORD_EXT.test(filePath));
}

/** macOS's own converter; the full path, so nothing on PATH can stand in for it. */
export const TEXTUTIL = '/usr/bin/textutil';

export function textutilAvailable(platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'darwin';
}

/** Where LibreOffice installs itself on each system, most likely first. PATH is searched after these. */
export function libreOfficeCandidates(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): string[] {
	switch (platform) {
		case 'darwin':
			return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(home, 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')];
		case 'win32': {
			const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')];
			return [...new Set(roots.filter((r): r is string => !!r).map((r) => path.win32.join(r, 'LibreOffice', 'program', 'soffice.exe')))];
		}
		default:
			return [
				'/usr/bin/soffice',
				'/usr/bin/libreoffice',
				'/usr/local/bin/soffice',
				'/usr/local/bin/libreoffice',
				'/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
				path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.libreoffice.LibreOffice'),
			];
	}
}

function pathCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
	const names = platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice'];
	const lib = platform === 'win32' ? path.win32 : path.posix;
	return dirs.flatMap((dir) => names.map((name) => lib.join(dir, name)));
}

/** /opt/libreoffice7.6/program/soffice and the like, from the tarball installs on Linux. */
async function optCandidates(platform: NodeJS.Platform): Promise<string[]> {
	if (platform === 'win32' || platform === 'darwin') return [];
	const entries = await fs.readdir('/opt').catch(() => [] as string[]);
	return entries
		.filter((name) => /^libreoffice/i.test(name))
		.sort()
		.reverse()
		.map((name) => path.posix.join('/opt', name, 'program', 'soffice'));
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return false;
		if (platform !== 'win32') await fs.access(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The first LibreOffice found, or null. Cheap enough to run before each old Office file. */
export async function findLibreOffice(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const candidates = [...libreOfficeCandidates(platform, env), ...(await optCandidates(platform)), ...pathCandidates(platform, env)];
	for (const candidate of candidates) {
		if ((await isExecutable(candidate, platform)) && !(await isSnap(candidate, platform))) return candidate;
	}
	return null;
}

/** A snap command is a link to /usr/bin/snap (or lives under /snap); confined, it cannot see /tmp or hidden folders. */
export async function isSnap(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	if (platform !== 'linux') return false;
	// realpath needs the target to exist; readlink still says where a link points when it cannot be followed
	const real = await fs.realpath(file).catch(() => fs.readlink(file).then((target) => path.posix.resolve(path.posix.dirname(file), target)).catch(() => file));
	return real === '/usr/bin/snap' || file.startsWith('/snap/') || real.startsWith('/snap/');
}

/** How an old Office file can be read on this computer right now. */
export type LegacyRoute = { via: 'libreoffice'; command: string } | { via: 'textutil' } | { via: 'none'; message: string };

export async function legacyRoute(
	mime: string,
	filePath: string,
	find: () => Promise<string | null> = () => findLibreOffice(),
	platform: NodeJS.Platform = process.platform,
): Promise<LegacyRoute> {
	const command = await find();
	if (command) return { via: 'libreoffice', command };
	if (textutilAvailable(platform) && isLegacyWord(mime, filePath)) return { via: 'textutil' };
	return { via: 'none', message: missingMessage(platform) };
}

export function missingMessage(platform: NodeJS.Platform = process.platform): string {
	if (textutilAvailable(platform)) return 'Old Excel and PowerPoint files (.xls, .ppt) need LibreOffice. Install it from libreoffice.org, or save this one as .xlsx or .pptx.';
	// The snap is skipped, so someone who has only that is told which install works
	const from = platform === 'linux' ? 'libreoffice.org or your package manager (not the snap)' : 'libreoffice.org';
	return `Old Office files (.doc, .xls, .ppt) need LibreOffice. Install it from ${from}, or save this one as .docx, .xlsx or .pptx.`;
}

/** Settings: what happens to old Office files on this computer, in one sentence. */
export function describeLegacySupport(libreOffice: string | null, platform: NodeJS.Platform = process.platform): string {
	if (libreOffice) return 'Read with LibreOffice.';
	if (textutilAvailable(platform)) return '.doc files are read with macOS but without pictures; .xls and .ppt need LibreOffice.';
	return '.doc, .xls and .ppt files need LibreOffice.';
}

const TEXTUTIL_TIMEOUT_MS = 120_000;

/**
 * Converts a .doc to .docx in `dir` with textutil and returns the new file's
 * path. The name keeps the original's, so Docling sees the same title.
 */
export async function convertWithTextutil(source: string, dir: string, signal: AbortSignal): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const target = path.join(dir, `${path.basename(source).replace(/\.[^.]+$/, '')}.docx`);
	await new Promise<void>((resolve, reject) => {
		// -format doc: a .dot template is the same format, but textutil goes by the extension
		execFile(TEXTUTIL, ['-format', 'doc', '-convert', 'docx', '-output', target, source], { timeout: TEXTUTIL_TIMEOUT_MS, signal }, (error, _stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolve();
		});
	});
	return target;
}
