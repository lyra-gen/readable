import { errorMessage, isAbort } from '../core/errors';
import type { LogLevel } from '../core/types';
import type { LlmClient } from './client';
import { clean, summarise } from './summarise';
import { promptOr } from './prompts';
import type { SummaryLength } from './summarise';

/**
 * Everything the text model adds to a note: summary, tags, title. One
 * place for the prompts, so a new file and an existing note get the same
 * treatment: the pipeline calls it for each file it ingests, enrichNotes for
 * notes already in the vault. Text too short for a feature skips it, and a
 * feature that fails is logged as a warning while the others go on; only a
 * cancel throws. Title and tags come from one call answering JSON, which is
 * repaired when a small model breaks it.
 */

export interface EnrichSettings {
	summaries: boolean;
	/** Default text model; tags use tagsModel when set. */
	model: string;
	summaryLength: SummaryLength;
	tags: boolean;
	/** '' means `model`. */
	tagsModel: string;
	tagCount: number;
	titles: boolean;
	/** '' means the defaults in DEFAULT_PROMPTS. */
	summaryPrompt: string;
	tagsPrompt: string;
}

/** The model server and what to ask of it. */
export type EnrichTarget = { client: LlmClient; settings: EnrichSettings };

export interface Enrichment {
	summary?: string;
	tags?: string[];
	title?: string;
	/** The first model that produced content, for the frontmatter. */
	model?: string;
}

export interface EnrichOptions {
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
	/** Called as each feature starts: 'summary', then 'title and tags'. */
	onStep?: (step: string) => void;
	log?: (level: Exclude<LogLevel, 'error'>, message: string, error?: unknown) => void;
}

/** Below this, a summary would only repeat the text (a photo description, a short memo). */
const MIN_SUMMARY_CHARS = 1000;
/** Title and tags need a little text to go on, but far less than a summary. */
const MIN_META_CHARS = 200;

/** Runs the enabled features; a failure in one is logged and the others continue. */
export async function enrich(client: LlmClient, text: string, settings: EnrichSettings, options: EnrichOptions = {}): Promise<Enrichment> {
	const out: Enrichment = {};
	const body = text.trim();
	const model = settings.model.trim();
	if (!model) return out;

	if (settings.summaries) {
		if (body.length < MIN_SUMMARY_CHARS) options.log?.('info', 'Too short to summarise');
		else {
			options.onStep?.('summary');
			try {
				out.summary = await summarise(client, body, {
					model,
					signal: options.signal,
					onProgress: options.onProgress,
					length: settings.summaryLength,
					instructions: settings.summaryPrompt,
				});
				out.model = model;
			} catch (error) {
				if (isAbort(error)) throw error;
				options.log?.('warn', `No summary: ${errorMessage(error)}`, error);
			}
		}
	}

	const wantMeta = (settings.tags || settings.titles) && body.length >= MIN_META_CHARS;
	if (wantMeta) {
		options.onStep?.('title and tags');
		const metaModel = settings.tags && settings.tagsModel.trim() ? settings.tagsModel.trim() : model;
		try {
			const meta = await titleAndTags(client, body, metaModel, settings.tagCount, promptOr('tags', settings.tagsPrompt), options.signal);
			if (settings.titles && meta.title) out.title = meta.title;
			if (settings.tags && meta.tags.length > 0) out.tags = meta.tags.slice(0, settings.tagCount);
			out.model ??= metaModel;
		} catch (error) {
			if (isAbort(error)) throw error;
			options.log?.('warn', `No title or tags: ${errorMessage(error)}`, error);
		}
	}
	return out;
}

/** One call for both, as JSON; the model sees the start and end of long text. */
async function titleAndTags(client: LlmClient, body: string, model: string, tagCount: number, instructions: string, signal?: AbortSignal): Promise<{ title: string; tags: string[] }> {
	const sample = body.length > 8000 ? `${body.slice(0, 6000)}\n…\n${body.slice(-2000)}` : body;
	const reply = await client.chat(
		[
			{
				role: 'system',
				content:
					'You label documents for a personal notes system. Answer with JSON only, no prose, no code fence: {"title": "...", "tags": ["...", "..."]}. Tags are lower-case, words joined with hyphens, no spaces, no # sign.',
			},
			{ role: 'user', content: `Give a title and ${tagCount} tags for this document.\n\n${sample}\n\n${instructions}` },
		],
		{ model, maxTokens: 300, temperature: 0.1, signal },
	);
	return parseMeta(reply);
}

export function parseMeta(reply: string): { title: string; tags: string[] } {
	// Models wrap the JSON in a code fence or stop before the closing brace; cut to the braces and try the obvious repairs
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	const raw = start === -1 ? '{}' : reply.slice(start, end > start ? end + 1 : undefined).trim();
	let parsed: { title?: unknown; tags?: unknown } = {};
	for (const candidate of [raw, `${raw}}`, `${raw}]}`, `${raw}"]}`]) {
		try {
			parsed = JSON.parse(candidate) as { title?: unknown; tags?: unknown };
			break;
		} catch {
			// try the next repair
		}
	}
	// One line: a newline in a title would end the frontmatter early
	const title = typeof parsed.title === 'string' ? clean(parsed.title).replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 120) : '';
	const tags = Array.isArray(parsed.tags) ? parsed.tags.map(normalizeTag).filter((t): t is string => t !== null) : [];
	return { title, tags: [...new Set(tags)] };
}

/** "Machine Learning" → "machine-learning"; drops anything that is not a usable Obsidian tag. */
function normalizeTag(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const tag = raw
		.trim()
		.replace(/^#/, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_/-]/gu, '')
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	if (!tag || /^\d+$/.test(tag) || tag.length > 40) return null;
	return tag;
}
