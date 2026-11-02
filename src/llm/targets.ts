import { serverTagsModel, serverVisionModel } from '../settings/model';
import type { ReadableSettings } from '../settings/model';
import type { LlmClient } from './client';
import type { EnrichTarget } from './enrich';
import { promptOr } from './prompts';
import { serverUrl } from './providers';

/**
 * Turns settings into what the AI features need at run time: an
 * EnrichTarget for summaries, titles and tags, and a VisionTarget that is
 * handed to the Docling sidecar, which calls the vision model itself. Each
 * is null when there is nothing to run. For Readable's own server, main.ts
 * passes the model it serves (the tags model setting is then ignored) and
 * builds the vision target itself, since that server's address exists only
 * while it runs.
 */

/** The model server, vision model and prompt, for picture descriptions. */
export type VisionTarget = { url: string; apiKey: string | null; model: string; prompt: string };

/**
 * The provider and the AI features to run on text; null when none is on or
 * no model is chosen. `builtinModel` is the model the built-in server
 * serves, used when settings name the built-in provider.
 */
export function enrichTargetFrom(s: ReadableSettings, client: LlmClient, builtinModel: string | null): EnrichTarget | null {
	const model = builtinModel ?? s.llmModel.trim();
	if (!model || !(s.summaries || s.tags || s.titles)) return null;
	if (builtinModel === null && !serverUrl(s)) return null;
	return {
		client,
		settings: {
			summaries: s.summaries,
			model,
			summaryLength: s.summaryLength,
			tags: s.tags,
			tagsModel: builtinModel ? '' : serverTagsModel(s),
			tagCount: s.tagCount,
			titles: s.titles,
			summaryPrompt: s.summaryPrompt,
			tagsPrompt: s.tagsPrompt,
		},
	};
}

/** The model server and vision model, for picture descriptions; null when no model reads pictures. */
export function visionTargetFrom(s: ReadableSettings, client: LlmClient, apiKey: string | null): VisionTarget | null {
	const model = serverVisionModel(s);
	if (!model || !serverUrl(s)) return null;
	return {
		url: client.baseUrl,
		apiKey,
		model,
		prompt: promptOr('describe', s.describePrompt),
	};
}
