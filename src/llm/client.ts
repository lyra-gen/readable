import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { isAbort, raceRequest } from '../core/errors';

/**
 * A local model server speaking the OpenAI chat API: Ollama, LM Studio,
 * llama-server and the like. Only the two calls Readable needs. The
 * connection is read afresh for every request, so a settings change applies
 * at once; Readable's own server goes through the same client, its
 * `ensure` starting llama-server with the model a request names. Failures
 * that mean the server itself cannot be used throw LlmUnavailable, which the
 * pipeline and settings turn into a hint about the provider; any other error
 * is about one reply.
 */

export interface LlmConnection {
	/** e.g. `http://localhost:11434`; `/v1` is added when missing. */
	baseUrl: string;
	apiKey: string | null;
	/** When set, runs before each request with its model ('' for a listing) and gives the live base URL (the built-in server starts here). */
	ensure?: (model: string) => Promise<string>;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	model: string;
	/** Hard cap on the reply. */
	maxTokens?: number;
	temperature?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** The server could not be used: unreachable, refused the key, or the model is unknown to it. */
export class LlmUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LlmUnavailable';
	}
}

const DEFAULT_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Servers that refused `reasoning_effort`, by base URL: it is sent once, then
 * left out for them.
 */
const refusesReasoningEffort = new Set<string>();

export class LlmClient {
	constructor(private readonly connection: () => LlmConnection) {}

	get baseUrl(): string {
		return openAiBaseUrl(this.connection().baseUrl);
	}

	/** Model ids the server offers (`GET /v1/models`). */
	async listModels(signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<string[]> {
		const res = await this.send('GET', '/models', undefined, timeoutMs, signal, '');
		const body = parseJson(res) as { data?: { id?: unknown }[] };
		return (body.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter((id) => id.length > 0);
	}

	/**
	 * One chat completion; returns the assistant text. Thinking is turned off:
	 * every reply here is capped, and a thinking model (Gemma 4 in LM Studio
	 * thinks by default) spends the cap on thinking and answers with nothing.
	 */
	async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
		const request = {
			model: options.model,
			messages,
			stream: false,
			temperature: options.temperature ?? 0.2,
			...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
		};
		const server = this.baseUrl;
		const post = (withEffort: boolean) =>
			this.send('POST', '/chat/completions', withEffort ? { ...request, reasoning_effort: 'none' } : request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal, options.model);
		let res: RequestUrlResponse;
		if (refusesReasoningEffort.has(server)) res = await post(false);
		else {
			try {
				res = await post(true);
			} catch (error) {
				// A server that does not know the option says so with a 400 naming it; ask again without
				if (!(error instanceof Error) || !/HTTP 400/.test(error.message) || !/reasoning/i.test(error.message)) throw error;
				refusesReasoningEffort.add(server);
				res = await post(false);
			}
		}
		const body = parseJson(res) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; error?: { message?: string } };
		const choice = body.choices?.[0];
		const content = choice?.message?.content;
		if (typeof content !== 'string') throw new Error(body.error?.message ?? 'The model returned no text');
		const text = content.trim();
		if (!text) {
			throw new Error(
				choice?.finish_reason === 'length'
					? `${options.model} ran out of room before answering, most likely while thinking. Turn its thinking off in the AI app, or choose another model`
					: `${options.model} answered with nothing`,
			);
		}
		return text;
	}

	private async send(
		method: 'GET' | 'POST',
		route: string,
		body: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		model = '',
	): Promise<RequestUrlResponse> {
		const connection = this.connection();
		let { apiKey } = connection;
		let base = this.baseUrl;
		if (connection.ensure) {
			try {
				base = openAiBaseUrl(await connection.ensure(model));
			} catch (error) {
				if (isAbort(error)) throw error;
				throw new LlmUnavailable(error instanceof Error ? error.message : String(error));
			}
			// The built-in server makes a new key each time it starts; read it now that it runs
			apiKey = this.connection().apiKey;
		}
		const url = `${base}${route}`;
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		// requestUrl has no abort; a timer and the signal race it, and the response is dropped if they win
		let res: RequestUrlResponse;
		try {
			res = await raceRequest(
				requestUrl({ url, method, headers, body: body === undefined ? undefined : JSON.stringify(body), throw: false }),
				signal,
				timeoutMs,
			);
		} catch (error) {
			if (isAbort(error)) throw error;
			if (error instanceof DOMException && error.name === 'TimeoutError') {
				throw new LlmUnavailable(`The model did not answer within ${Math.round(timeoutMs / 1000)} s`);
			}
			throw new LlmUnavailable(`Couldn't reach the model server at ${this.baseUrl}`);
		}
		if (res.status === 401 || res.status === 403) throw new LlmUnavailable('The model server rejected the API key');
		if (res.status === 404 && method === 'POST') throw new LlmUnavailable(modelMissing(res));
		if (res.status >= 400) throw new Error(`Model server returned HTTP ${res.status}: ${errorText(res)}`);
		return res;
	}
}

function modelMissing(res: RequestUrlResponse): string {
	const text = errorText(res);
	return /model/i.test(text) ? `Model not found on the server: ${text}` : `Model server returned HTTP 404: ${text}`;
}

function errorText(res: RequestUrlResponse): string {
	try {
		const body = JSON.parse(res.text) as { error?: { message?: string } | string };
		if (typeof body.error === 'string') return body.error;
		if (body.error?.message) return body.error.message;
	} catch {
		// not JSON
	}
	return res.text.slice(0, 200);
}

function parseJson(res: RequestUrlResponse): unknown {
	try {
		return JSON.parse(res.text) as unknown;
	} catch {
		throw new Error('The model server did not return JSON');
	}
}

/** `localhost:11434` → `http://localhost:11434/v1`; a trailing `/v1` is kept once. */
export function openAiBaseUrl(raw: string): string {
	let url = raw.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
	if (!/\/v1$/i.test(url)) url = `${url}/v1`;
	return url;
}
