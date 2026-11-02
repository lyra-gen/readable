/** The error every cancelled operation rejects with. */
export function abortError(): DOMException {
	return new DOMException('Aborted', 'AbortError');
}

export function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Settles with the request, or rejects with AbortError when the signal fires
 * and TimeoutError after `timeoutMs`. The request itself keeps running.
 */
export function raceRequest<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const cleanup = () => {
			window.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		const timer = window.setTimeout(() => {
			cleanup();
			reject(new DOMException('Timed out', 'TimeoutError'));
		}, timeoutMs);
		signal?.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
