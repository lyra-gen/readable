import type { AudioPolicy, DocumentPolicy, ExtractionPolicy, ImagePolicy, PicturePolicy, TextPolicy, VideoPolicy } from '../extract/kinds';
import {
	AUDIO_POLICIES,
	DOCUMENT_POLICIES,
	IMAGE_POLICIES,
	parseExtensions,
	PICTURE_POLICIES,
	TEXT_POLICIES,
	VIDEO_POLICIES,
} from '../extract/kinds';
import { OCR_ENGINES, OCR_MODES, TABLE_MODES } from '../extract/docling/options';
import type { OcrEngine, OcrMode, TableMode } from '../extract/docling/options';
import { EXTRACT_FORMATS } from '../notes/format';
import type { ExtractFormat } from '../notes/format';
import { NOTE_LOCATIONS } from '../notes/location';
import type { NoteLocation } from '../notes/location';
import { SUMMARY_LENGTHS } from '../llm/summarise';
import type { SummaryLength } from '../llm/summarise';
import { AI_PROVIDERS, appProvider, providerForUrl, sameServer, usesServer } from '../llm/providers';
import type { AiProvider } from '../llm/providers';
import type { ModelInfo } from '../llm/models';

/**
 * The shape of Readable's settings, their defaults and their validation.
 * Each key has a check that returns the value to store or undefined.
 * normalizeSettings runs every check over data.json on load, keeps the
 * default for anything missing or invalid, drops unknown keys and migrates
 * older layouts (aiSource and llmBaseUrl before aiProvider, separate models
 * before Model scope); the settings tab stores through normalizeField too.
 * Also here are the readings of settings other modules share, such as which
 * model describes pictures and the extraction policy for the pipeline.
 */

/**
 * Where extracted text goes. `inline`: below each embed of the file in the
 * user's notes; files nothing embeds get a separate note. `both`: a separate
 * note and below each embed.
 */
export const OUTPUT_MODES = ['note', 'inline', 'both'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/**
 * Where a document's pictures go: `note`, the folder of the note that embeds
 * them (the default; Obsidian's own default attachment folder is the vault
 * root, which fills up); `attachments`, wherever Obsidian puts attachments
 * for that note (Settings › Files and links).
 */
export const FIGURE_LOCATIONS = ['note', 'attachments'] as const;
export type FigureLocation = (typeof FIGURE_LOCATIONS)[number];

/**
 * On a model server: `one` model for every feature (the default), or a model
 * `perFeature` (summaries, titles and tags, pictures), each chosen on its page.
 */
export const MODEL_SCOPES = ['one', 'perFeature'] as const;
export type ModelScope = (typeof MODEL_SCOPES)[number];

/** Minutes a built-in model stays loaded after the last request. */
export const KEEP_LOADED_CHOICES = [1, 5, 10, 30] as const;

/** Choices offered for Parallel jobs. */
export const CONCURRENCY_CHOICES = [1, 2, 3, 4] as const;
/** Choices offered for Largest note, in MB. */
export const LARGEST_NOTE_CHOICES = [1, 2, 5, 10, 25] as const;
/** Choices offered for how many topic tags. */
export const TAG_COUNTS = [3, 5, 8] as const;
/** Shortest Docling timeout accepted, in seconds. */
export const MIN_DOCLING_TIMEOUT_SEC = 10;

export interface ReadableSettings {
	outputMode: OutputMode;
	noteLocation: NoteLocation;
	outputFolder: string;
	subfolderName: string;
	/** How a separate note holds the extracted text; see ExtractFormat. */
	extractFormat: ExtractFormat;
	/** How the text under an embed is written. */
	inlineFormat: ExtractFormat;
	/** Pictures inside documents. */
	documentPictures: PicturePolicy;
	/** Where a document's pictures are saved; see FigureLocation. */
	figureLocation: FigureLocation;
	/** A folder per document, inside that location. */
	groupFigures: boolean;
	autoIngest: boolean;
	inboxFolder: string;
	/** Queue a watched file again when its content changes. */
	reprocessOnModify: boolean;
	showBadges: boolean;
	notifyOnDone: boolean;
	/** Queue rows move to their new place at once instead of sliding. The system's reduced-motion setting does the same. */
	reduceMotion: boolean;
	concurrency: number;
	doclingOcr: OcrMode;
	/** OCR languages as typed (BCP-47 tags, comma-separated); '' means the system languages plus English. */
	ocrLanguages: string;
	/** Managed mode only. */
	ocrEngine: OcrEngine;
	doclingTableMode: TableMode;
	/** Seconds a file may go without progress before Docling gives up on it. */
	doclingTimeout: number;
	documents: DocumentPolicy;
	images: ImagePolicy;
	audio: AudioPolicy;
	video: VideoPolicy;
	plainText: TextPolicy;
	/** Comma-separated extensions never processed, as typed. */
	ignoreExtensions: string;
	/** Whisper language code; '' detects. */
	speechLanguage: string;
	/** Keep time markers in transcripts. */
	speechTimestamps: boolean;
	/** Where AI features run; see AiProvider. */
	aiProvider: AiProvider;
	/** The server's address; '' means the app's usual one. Required for `custom`. */
	llmBaseUrl: string;
	/** Secret id in Obsidian's secret storage, for servers that need a key. */
	llmApiKey: string;
	/** The models the server listed at the last fetch, so pickers work while it is closed. */
	llmModels: ModelInfo[];
	modelScope: ModelScope;
	/** The model on a server: for everything, or for summaries when `modelScope` is `perFeature`. */
	llmModel: string;
	/** Write a summary into each note. */
	summaries: boolean;
	summaryLength: SummaryLength;
	/** Add topic tags from the content. */
	tags: boolean;
	/** Per feature only; '' means the summary model. */
	tagsModel: string;
	tagCount: number;
	/** Set `title` and an alias from the content. */
	titles: boolean;
	/** Per feature only: the model on the same server that describes pictures; '' for none. */
	visionModel: string;
	/** Readable's own AI: the model, by id ('' = the bundled one). Pictures fall back to the bundled one when it has no projector. */
	builtinModel: string;
	/** An extra folder of GGUF models; Readable's own is always scanned. */
	builtinModelsFolder: string;
	/** Minutes a model stays loaded after the last request. */
	builtinKeepLoaded: number;
	/** Most extracted text a note keeps, in MB; the rest is cut with a callout saying so. */
	largestNoteMb: number;
	/** Instructions for each AI feature; '' means the default in DEFAULT_PROMPTS. */
	summaryPrompt: string;
	tagsPrompt: string;
	describePrompt: string;
	devMode: boolean;
}

export const DEFAULT_SETTINGS: ReadableSettings = {
	outputMode: 'note',
	noteLocation: 'folder',
	outputFolder: 'Readable',
	subfolderName: '_readable',
	extractFormat: 'plain',
	inlineFormat: 'callout',
	documentPictures: 'attach',
	figureLocation: 'note',
	groupFigures: true,
	autoIngest: false,
	inboxFolder: 'Readable/Inbox',
	reprocessOnModify: true,
	showBadges: true,
	notifyOnDone: true,
	reduceMotion: false,
	concurrency: 1,
	doclingOcr: 'auto',
	ocrLanguages: '',
	ocrEngine: 'auto',
	doclingTableMode: 'accurate',
	doclingTimeout: 600,
	documents: 'read',
	images: 'text',
	audio: 'skip',
	video: 'skip',
	plainText: 'copy',
	ignoreExtensions: '',
	speechLanguage: '',
	speechTimestamps: true,
	aiProvider: 'own',
	llmBaseUrl: '',
	llmApiKey: '',
	llmModels: [],
	modelScope: 'one',
	llmModel: '',
	summaries: true,
	summaryLength: 'short',
	tags: false,
	tagsModel: '',
	tagCount: 5,
	titles: true,
	visionModel: '',
	builtinModel: '',
	builtinModelsFolder: '',
	builtinKeepLoaded: 10,
	largestNoteMb: 5,
	summaryPrompt: '',
	tagsPrompt: '',
	describePrompt: '',
	devMode: false,
};

export type SettingKey = keyof ReadableSettings;

/** Settings stored as numbers but shown in dropdowns as strings. */
export const NUMERIC_KEYS = new Set<SettingKey>(['concurrency', 'tagCount', 'builtinKeepLoaded', 'largestNoteMb']);

export function isSettingKey(k: string): k is SettingKey {
	return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k);
}

type Check<T> = (value: unknown) => T | undefined;

function oneOf<T extends string | number>(values: readonly T[]): Check<T> {
	return (value) => values.find((v) => v === value);
}

const isBool: Check<boolean> = (value) => (typeof value === 'boolean' ? value : undefined);
const isStr: Check<string> = (value) => (typeof value === 'string' ? value : undefined);

const modelList: Check<ModelInfo[]> = (value) => {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((m: unknown) => {
		const { id, vision } = (m ?? {}) as { id?: unknown; vision?: unknown };
		if (typeof id !== 'string' || !id) return [];
		return [typeof vision === 'boolean' ? { id, vision } : { id }];
	});
};

/** Numbers may arrive as strings from dropdowns or a hand-edited data.json. */
function numberOf<T extends number>(values: readonly T[]): Check<T> {
	const pick = oneOf(values);
	return (value) => pick(Number(value));
}

const timeout: Check<number> = (value) => {
	const seconds = Math.round(Number(value));
	return Number.isFinite(seconds) && seconds >= MIN_DOCLING_TIMEOUT_SEC ? seconds : undefined;
};

const CHECKS: { [K in SettingKey]: Check<ReadableSettings[K]> } = {
	outputMode: oneOf(OUTPUT_MODES),
	noteLocation: oneOf(NOTE_LOCATIONS),
	outputFolder: isStr,
	subfolderName: isStr,
	extractFormat: oneOf(EXTRACT_FORMATS),
	inlineFormat: oneOf(EXTRACT_FORMATS),
	documentPictures: oneOf(PICTURE_POLICIES),
	figureLocation: oneOf(FIGURE_LOCATIONS),
	groupFigures: isBool,
	autoIngest: isBool,
	inboxFolder: isStr,
	reprocessOnModify: isBool,
	showBadges: isBool,
	notifyOnDone: isBool,
	reduceMotion: isBool,
	concurrency: numberOf(CONCURRENCY_CHOICES),
	largestNoteMb: numberOf(LARGEST_NOTE_CHOICES),
	doclingOcr: oneOf(OCR_MODES),
	ocrLanguages: isStr,
	ocrEngine: oneOf(OCR_ENGINES),
	doclingTableMode: oneOf(TABLE_MODES),
	doclingTimeout: timeout,
	documents: oneOf(DOCUMENT_POLICIES),
	images: oneOf(IMAGE_POLICIES),
	audio: oneOf(AUDIO_POLICIES),
	video: oneOf(VIDEO_POLICIES),
	plainText: oneOf(TEXT_POLICIES),
	ignoreExtensions: isStr,
	speechLanguage: isStr,
	speechTimestamps: isBool,
	aiProvider: oneOf(AI_PROVIDERS),
	llmBaseUrl: isStr,
	llmApiKey: isStr,
	llmModels: modelList,
	modelScope: oneOf(MODEL_SCOPES),
	llmModel: isStr,
	summaries: isBool,
	summaryLength: oneOf(SUMMARY_LENGTHS),
	tags: isBool,
	tagsModel: isStr,
	tagCount: numberOf(TAG_COUNTS),
	titles: isBool,
	visionModel: isStr,
	builtinModel: isStr,
	builtinModelsFolder: isStr,
	builtinKeepLoaded: numberOf(KEEP_LOADED_CHOICES),
	summaryPrompt: isStr,
	tagsPrompt: isStr,
	describePrompt: isStr,
	devMode: isBool,
};

/** The value to store for `key`, or undefined when it is not valid. */
export function normalizeField<K extends SettingKey>(key: K, value: unknown): ReadableSettings[K] | undefined {
	return CHECKS[key](value);
}

/** Stored data may predate a setting or come from a hand-edited data.json; unknown keys are dropped. */
export function normalizeSettings(raw: unknown): ReadableSettings {
	const settings: ReadableSettings = { ...DEFAULT_SETTINGS };
	if (typeof raw !== 'object' || raw === null) return settings;
	const stored = raw as Record<string, unknown>;
	const copy = <K extends SettingKey>(key: K) => {
		const value = normalizeField(key, stored[key]);
		if (value !== undefined) settings[key] = value;
	};
	for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) copy(key);
	if (stored.aiProvider === undefined) settings.aiProvider = legacyProvider(stored);
	if (settings.llmBaseUrl === 'builtin') settings.llmBaseUrl = '';
	// The app's usual address is stored as '', so the field shows it as the placeholder
	const app = appProvider(settings.aiProvider);
	if (app && settings.llmBaseUrl && sameServer(settings.llmBaseUrl, app.url)) settings.llmBaseUrl = '';
	// Before Model scope every feature had its own model; keep separate choices separate
	if (stored.modelScope === undefined) {
		const separate = settings.tagsModel !== '' || (settings.visionModel !== '' && settings.visionModel !== settings.llmModel);
		settings.modelScope = separate ? 'perFeature' : 'one';
	}
	return settings;
}

/**
 * The provider for settings saved before `aiProvider`: `aiSource` (own, app
 * or off) with the app's address in `llmBaseUrl`, and before that
 * `llmBaseUrl` alone ('builtin', '' or an address).
 */
function legacyProvider(stored: Record<string, unknown>): AiProvider {
	const url = typeof stored.llmBaseUrl === 'string' ? stored.llmBaseUrl.trim() : '';
	const source = stored.aiSource ?? (url === '' || url === 'builtin' ? 'own' : 'app');
	if (source === 'off') return 'off';
	if (source !== 'app') return 'own';
	if (url === '' || url === 'builtin') return 'ollama';
	return providerForUrl(url) ?? 'custom';
}

/** On a model server, the model that describes pictures; '' for none, so pictures are read for text only. */
export function serverVisionModel(s: ReadableSettings): string {
	if (s.modelScope === 'perFeature') return s.visionModel.trim();
	// One model for everything: unless the server says it cannot read pictures
	const model = s.llmModel.trim();
	return s.llmModels.find((m) => m.id === model)?.vision === false ? '' : model;
}

/** On a model server, the model for titles and tags; '' means the main model. */
export function serverTagsModel(s: ReadableSettings): string {
	return s.modelScope === 'perFeature' ? s.tagsModel.trim() : '';
}

/** The per-kind choices as one object, for the pipeline and the watcher. */
export function extractionPolicy(s: ReadableSettings): ExtractionPolicy {
	return {
		documents: s.documents,
		images: s.images,
		audio: s.audio,
		video: s.video,
		plainText: s.plainText,
		ignoreExtensions: parseExtensions(s.ignoreExtensions),
		ocr: s.doclingOcr,
		// Readable's own server picks a model that reads pictures itself
		visionModel: s.aiProvider === 'own' ? 'own' : usesServer(s.aiProvider) ? serverVisionModel(s) : '',
	};
}
