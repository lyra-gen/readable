import { spawn } from 'child_process';
import { promises as fs } from 'fs';

/** Opens a folder in Finder, Explorer or the desktop's file manager, creating it first. */
export async function openFolder(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const [command, args] =
		process.platform === 'darwin' ? ['open', [dir]] : process.platform === 'win32' ? ['explorer.exe', [dir]] : ['xdg-open', [dir]];
	spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
