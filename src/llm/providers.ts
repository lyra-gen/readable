import { openAiBaseUrl } from './client';

/**
 * Where AI features run. `own` is Readable's own model server; the apps are
 * model servers on this computer (or another) speaking the OpenAI chat API,
 * each on its usual address; `custom` is any other such server at an
 * address the user types; `off` turns AI features off.
 */

export interface AppProvider {
	id: string;
	name: string;
	/** Where the app listens by default; the user can override it. */
	url: string;
	/** The app can be set to require an API key. */
	takesKey: boolean;
}

export const APP_PROVIDERS = [
	{ id: 'ollama', name: 'Ollama', url: 'http://localhost:11434', takesKey: false },
	{ id: 'lmstudio', name: 'LM Studio', url: 'http://localhost:1234', takesKey: true },
	{ id: 'llamacpp', name: 'llama.cpp', url: 'http://localhost:8080', takesKey: true },
	{ id: 'jan', name: 'Jan', url: 'http://localhost:1337', takesKey: true },
	{ id: 'vllm', name: 'vLLM', url: 'http://localhost:8000', takesKey: true },
	{ id: 'gpt4all', name: 'GPT4All', url: 'http://localhost:4891', takesKey: false },
] as const satisfies readonly AppProvider[];

export type AppProviderId = (typeof APP_PROVIDERS)[number]['id'];

export type AiProvider = 'own' | AppProviderId | 'custom' | 'off';
export const AI_PROVIDERS: readonly AiProvider[] = ['own', ...APP_PROVIDERS.map((p) => p.id), 'custom', 'off'];

/** The app for `id`; undefined for own, custom and off. */
export function appProvider(id: string): AppProvider | undefined {
	return APP_PROVIDERS.find((p) => p.id === id);
}

/** An app or another server: features run on a model server Readable does not manage. */
export function usesServer(id: AiProvider): boolean {
	return id === 'custom' || appProvider(id) !== undefined;
}

/** An API key can apply: the app supports one, or it is an unknown server. */
export function takesKey(id: AiProvider): boolean {
	return id === 'custom' || (appProvider(id)?.takesKey ?? false);
}

/** The display name, e.g. "LM Studio"; "the server" for custom. */
export function providerName(id: AiProvider): string {
	return appProvider(id)?.name ?? 'the server';
}

/** The server address in use: the typed one, else the app's usual one; '' for own, off and custom without one. */
export function serverUrl(s: { aiProvider: AiProvider; llmBaseUrl: string }): string {
	if (!usesServer(s.aiProvider)) return '';
	return s.llmBaseUrl.trim() || appProvider(s.aiProvider)?.url || '';
}

/** Two addresses reach the same server: same scheme, host and port; localhost and 127.0.0.1 are one host. */
export function sameServer(a: string, b: string): boolean {
	const norm = (url: string) => openAiBaseUrl(url).toLowerCase().replace('://127.0.0.1', '://localhost');
	return norm(a) === norm(b);
}

/** The app whose usual address `url` is, if any. */
export function providerForUrl(url: string): AppProviderId | undefined {
	if (!url.trim()) return undefined;
	return APP_PROVIDERS.find((p) => sameServer(p.url, url))?.id;
}

/** The server's root, without `/v1`, for app-specific routes such as Ollama's `/api/show`. */
export function serverRoot(url: string): string {
	return openAiBaseUrl(url).replace(/\/v1$/i, '');
}
