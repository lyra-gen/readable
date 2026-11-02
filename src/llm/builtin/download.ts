import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as https from 'https';
import type { IncomingMessage } from 'http';
import { abortError, throwIfAborted } from '../../core/errors';

/**
 * Streams a download to disk with a sha256 check, for files too large to
 * hold in memory (model weights). Follows redirects, which Hugging Face and
 * GitHub both use. The file lands at `dest` only after the hash matches.
 */
export async function downloadFile(
	url: string,
	dest: string,
	expected: { sha256: string; bytes?: number },
	onProgress: (done: number, total: number) => void,
	signal: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const partial = `${dest}.part`;
	const response = await open(url, signal, 0);
	const total = Number(response.headers['content-length'] ?? expected.bytes ?? 0);
	const hash = createHash('sha256');
	let done = 0;
	let lastReport = 0;
	await new Promise<void>((resolve, reject) => {
		const file = createWriteStream(partial);
		const onAbort = () => {
			response.destroy();
			file.destroy();
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		response.on('data', (chunk: Buffer) => {
			hash.update(chunk);
			done += chunk.length;
			// Once a second is plenty for a progress line
			const now = Date.now();
			if (now - lastReport > 1000) {
				lastReport = now;
				onProgress(done, total);
			}
		});
		response.on('error', (error) => {
			signal.removeEventListener('abort', onAbort);
			file.destroy();
			reject(error);
		});
		response.pipe(file);
		file.on('finish', () => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		});
		file.on('error', (error) => {
			signal.removeEventListener('abort', onAbort);
			reject(error);
		});
	});
	const actual = hash.digest('hex');
	if (actual !== expected.sha256) {
		await fs.rm(partial, { force: true });
		throw new Error(`The download was corrupted (sha256 ${actual.slice(0, 12)}…, expected ${expected.sha256.slice(0, 12)}…). Try again.`);
	}
	onProgress(done, total);
	await fs.rename(partial, dest);
}

const MAX_REDIRECTS = 5;

function open(url: string, signal: AbortSignal, hops: number): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { headers: { 'User-Agent': 'Readable' } }, (response) => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && location) {
				response.resume();
				if (hops >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
				resolve(open(new URL(location, url).toString(), signal, hops + 1));
				return;
			}
			if (status !== 200) {
				response.resume();
				return reject(new Error(`Download failed with HTTP ${status}`));
			}
			resolve(response);
		});
		request.on('error', reject);
		signal.addEventListener('abort', () => request.destroy(abortError()), { once: true });
	});
}
