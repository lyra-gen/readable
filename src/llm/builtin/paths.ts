import * as path from 'path';
import { appDataRoot } from '../../storage/app-data';

/** Where the built-in model server lives: `llama/` under app data, beside managed Docling. */
export interface LlamaPaths {
	root: string;
	/** The unpacked llama.cpp build; `server` is inside it. */
	build: string;
	server: string;
	models: string;
	/** Written last; its presence means the install finished. */
	manifest: string;
	tmp: string;
}

export function llamaPaths(root = path.join(appDataRoot(), 'llama')): LlamaPaths {
	const build = path.join(root, 'build');
	return {
		root,
		build,
		server: path.join(build, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
		models: path.join(root, 'models'),
		manifest: path.join(root, 'install.json'),
		tmp: path.join(root, 'tmp'),
	};
}
