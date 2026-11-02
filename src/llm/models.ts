import { requestUrl } from 'obsidian';
import { raceRequest } from '../core/errors';
import { LlmClient } from './client';
import { serverRoot } from './providers';
import type { AiProvider } from './providers';

/**
 * The models a server offers, for the settings pickers: "Fetch models" lists
 * them and the list is saved, so the pickers work while the app is closed.
 * The OpenAI listing says nothing about pictures, so Ollama and LM Studio are
 * asked through their own routes which models read them and which only embed.
 * Embedding models are left out; a model the server did not describe is judged
 * by "embed" in its name.
 */

export interface ModelInfo {
	id: string;
	/** Reads pictures. Ollama and LM Studio say; for other servers it is unknown. */
	vision?: boolean;
}

/** What an app reports about one model. */
interface Capabilities {
	vision?: boolean;
	/** An embedding model, which cannot chat. */
	embedding: boolean;
}

const FETCH_MS = 4000;

/** The chat models at `url`, marked when they read pictures; throws LlmUnavailable when the server cannot be used. */
export async function fetchModels(provider: AiProvider, url: string, apiKey: string | null): Promise<ModelInfo[]> {
	const client = new LlmClient(() => ({ baseUrl: url, apiKey }));
	const ids = await client.listModels(undefined, FETCH_MS);
	const caps =
		provider === 'ollama' ? await ollamaCapabilities(url, ids) : provider === 'lmstudio' ? await lmStudioCapabilities(url, apiKey) : new Map<string, Capabilities>();
	return ids.flatMap((id) => {
		const c = caps.get(id);
		if (c?.embedding || (!c && /embed/i.test(id))) return [];
		return [c?.vision === undefined ? { id } : { id, vision: c.vision }];
	});
}

/** Ollama's `/api/show` per model. Best effort: a model that fails is left unmarked. */
async function ollamaCapabilities(url: string, ids: string[]): Promise<Map<string, Capabilities>> {
	const root = serverRoot(url);
	const found = await Promise.all(
		ids.map(async (id) => {
			try {
				const res = await raceRequest(requestUrl({ url: `${root}/api/show`, method: 'POST', body: JSON.stringify({ name: id }), throw: false }), undefined, FETCH_MS);
				const caps = parseOllamaShow(JSON.parse(res.text) as unknown);
				return caps ? ([id, caps] as const) : null;
			} catch {
				return null;
			}
		}),
	);
	return new Map(found.filter((e): e is readonly [string, Capabilities] => e !== null));
}

/** LM Studio's own model list: `/api/v1/models`, or `/api/v0/models` on older versions. */
async function lmStudioCapabilities(url: string, apiKey: string | null): Promise<Map<string, Capabilities>> {
	const root = serverRoot(url);
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	for (const route of ['/api/v1/models', '/api/v0/models']) {
		try {
			const res = await raceRequest(requestUrl({ url: `${root}${route}`, headers, throw: false }), undefined, FETCH_MS);
			if (res.status !== 200) continue;
			const caps = parseLmStudioModels(JSON.parse(res.text) as unknown);
			if (caps.size > 0) return caps;
		} catch {
			// try the older route
		}
	}
	return new Map();
}

/** `{capabilities: ["completion", "vision"]}`; null when the reply has no capabilities. */
export function parseOllamaShow(body: unknown): Capabilities | null {
	const caps = (body as { capabilities?: unknown } | null)?.capabilities;
	if (!Array.isArray(caps)) return null;
	return { vision: caps.includes('vision'), embedding: caps.includes('embedding') && !caps.includes('completion') };
}

/**
 * LM Studio's model list. v1: `{models: [{key, type: "llm"|"embedding", capabilities: {vision}}]}`;
 * v0: `{data: [{id, type: "llm"|"vlm"|"embeddings"}]}`.
 */
export function parseLmStudioModels(body: unknown): Map<string, Capabilities> {
	const out = new Map<string, Capabilities>();
	const b = body as { models?: unknown; data?: unknown } | null;
	if (Array.isArray(b?.models)) {
		for (const m of b.models as { key?: unknown; type?: unknown; capabilities?: { vision?: unknown } }[]) {
			if (typeof m?.key !== 'string') continue;
			const vision = m.capabilities?.vision;
			out.set(m.key, { embedding: m.type === 'embedding', ...(typeof vision === 'boolean' ? { vision } : {}) });
		}
	} else if (Array.isArray(b?.data)) {
		for (const m of b.data as { id?: unknown; type?: unknown }[]) {
			if (typeof m?.id !== 'string') continue;
			out.set(m.id, { embedding: m.type === 'embeddings', ...(m.type === 'vlm' || m.type === 'llm' ? { vision: m.type === 'vlm' } : {}) });
		}
	}
	return out;
}

export interface ModelChoice {
	llmModel: string;
	tagsModel: string;
	visionModel: string;
}

/**
 * The model choices after a fetch. A choice the list lacks is kept: the
 * user may have typed a model the server loads on demand. Only an empty
 * main model is filled in. With `fresh` (a different server was chosen) the
 * old choices mean nothing there, so each is replaced by one from the list:
 * the first model, and the first that reads pictures.
 */
export function reconcileModels(current: ModelChoice, models: ModelInfo[], fresh: boolean): ModelChoice {
	const first = models[0];
	if (!first) return current;
	const listed = (id: string) => models.some((m) => m.id === id);
	if (!fresh) return { ...current, llmModel: current.llmModel || first.id };
	return {
		llmModel: listed(current.llmModel) ? current.llmModel : first.id,
		tagsModel: listed(current.tagsModel) ? current.tagsModel : '',
		visionModel: listed(current.visionModel) ? current.visionModel : (models.find((m) => m.vision)?.id ?? ''),
	};
}
