/**
 * The parts of Obsidian's API the code under test imports, for running it in
 * plain Node. Aliased to `obsidian` by scripts/test.mjs.
 */

interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

export async function requestUrl(param: RequestUrlParam) {
	// Plain Node has no requestUrl; this stand-in provides it with Node's own fetch
	const res = await fetch(param.url, { method: param.method ?? 'GET', headers: param.headers, body: param.body, redirect: 'follow' });
	if (param.throw !== false && !res.ok) throw new Error(`HTTP ${res.status}`);
	const arrayBuffer = await res.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);
	return {
		status: res.status,
		arrayBuffer,
		text,
		headers: headersOf(res.headers),
		get json(): unknown {
			return JSON.parse(text) as unknown;
		},
	};
}

export function normalizePath(path: string): string {
	// As Obsidian does: the root is '/', never ''
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';
}

export class FileSystemAdapter {}

/** Only for `instanceof` checks in code the tests import; tests never build vault files. */
export class TFile {}
export class TFolder {}

/** Icons are DOM-only; code under test only names them. */
export function setIcon(): void {}

export class Notice {
	hide(): void {}
	setMessage(): this {
		return this;
	}
}

function headersOf(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => (out[key] = value));
	return out;
}
