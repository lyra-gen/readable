import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { Job, JobStage, LogLevel, SkipReason } from '../core/types';
import { baseMime, kindEnabled, kindOf, KIND_LABEL } from '../extract/kinds';
import type { ExtractionPolicy, FileKind, PicturePolicy } from '../extract/kinds';
import { capText, formatSize } from '../extract/cap';
import type { ExtractorRegistry } from '../extract/registry';
import { hasText } from '../extract/types';
import type { ExtractResult } from '../extract/types';
import { errorMessage, isAbort } from '../core/errors';
import { LlmUnavailable } from '../llm/client';
import { enrich } from '../llm/enrich';
import type { EnrichTarget } from '../llm/enrich';
import { saveFigures } from '../notes/figures';
import { neutraliseHtml } from '../notes/format';
import type { FigureSettings } from '../notes/figures';
import type { InlineWriter } from '../notes/inline-writer';
import type { NoteWriter } from '../notes/writer';
import type { OutputMode } from '../settings/model';
import { detectType } from './detect';
import type { DetectedType } from './detect';
import { sha256 } from './hash';

/**
 * One job's run through the pipeline; the queue's worker calls runJob for each
 * job it starts. In order: skip ignored extensions, hash the bytes and skip when
 * this file's output already holds that hash (its note, its blocks below embeds,
 * or both, per the output mode), detect the type and check its kind is on,
 * extract with the engine the registry picks, cap the text at the note size
 * limit, save figures for the note that will hold the text (where they go is set
 * under figures), ask the model for summary, title and tags, then write below
 * each embed and/or into the file's own note. Model failures
 * are warnings and the note is written without AI content; a file with no text
 * fails rather than getting an empty note, so it can be retried or excluded.
 */

/** What the pipeline reads from the plugin: services and live settings. */
export interface PipelineConfig {
	app: App;
	extractors: ExtractorRegistry;
	writer: NoteWriter;
	inline: InlineWriter;
	outputMode: () => OutputMode;
	/** Pictures inside documents: attach, attach and describe, or leave out. */
	pictures: () => PicturePolicy;
	/** Where a document's figures go, and whether each document gets its own folder. */
	figures: () => FigureSettings;
	/** What to do with each kind of file. */
	policy: () => ExtractionPolicy;
	/** The model server and what to ask of it; null when nothing is enabled or no model is set. */
	llm: () => EnrichTarget | null;
	/** Longest extracted text a note keeps, in UTF-8 bytes; the rest is cut. */
	maxNoteBytes: () => number;
	/** Whether a note is Readable's own note for a source; it always embeds the source, so it is not a reference. */
	isOwnNote: (note: TFile, sourcePath: string) => boolean;
}

export interface PipelineDeps extends PipelineConfig {
	log: (job: Job, level: LogLevel, message: string) => void;
	progress: (job: Job, stage: JobStage, fraction?: number, detail?: string) => void;
}

const PROVIDER_HINT = 'Check the provider under Settings → Readable → AI';

export type JobOutcome =
	| { kind: 'done'; notePath: string; extractor: string; model?: string }
	| { kind: 'skipped'; reason: SkipReason }
	| { kind: 'cancelled' }
	| { kind: 'failed'; code: string; message: string };

type Extracted = Extract<ExtractResult, { status: 'extracted' }>;

/** What the model added to the note; empty when nothing was asked or it all failed. */
interface Enrichment {
	summary?: string;
	title?: string;
	tags: string[];
	model?: string;
}

/** Runs the stages for one job. Never throws; every path becomes an outcome. */
export async function runJob(deps: PipelineDeps, job: Job, signal: AbortSignal): Promise<JobOutcome> {
	try {
		const file = deps.app.vault.getAbstractFileByPath(job.sourcePath);
		if (!(file instanceof TFile)) return { kind: 'failed', code: 'missing', message: 'File not found in vault' };
		const policy = deps.policy();
		if (policy.ignoreExtensions.includes(file.extension.toLowerCase())) {
			deps.log(job, 'info', `.${file.extension} is on the ignore list in settings`);
			return { kind: 'skipped', reason: 'ignored' };
		}

		deps.progress(job, 'hashing');
		const bytes = new Uint8Array(await deps.app.vault.readBinary(file));
		job.hash = await sha256(bytes);
		deps.log(job, 'info', `sha256:${job.hash.slice(0, 12)}…, ${bytes.byteLength} bytes`);
		if (bytes.byteLength === 0) {
			// Sniffing an empty file lands on plain text and "no text found", which hides the real cause
			const message = 'This file is empty (0 bytes). If it is still downloading or syncing, retry once it has finished.';
			deps.log(job, 'error', message);
			return { kind: 'failed', code: 'empty', message };
		}
		if (await alreadyProcessed(deps, job.hash, job.sourcePath)) {
			deps.log(job, 'info', 'A note for this content already exists');
			return { kind: 'skipped', reason: 'already-processed' };
		}
		if (signal.aborted) return { kind: 'cancelled' };

		const classified = await classify(deps, job, bytes, policy);
		if (!('type' in classified)) return classified;
		const { type } = classified;

		const extractor = deps.extractors.select(type.mime);
		if (!extractor) {
			deps.log(job, 'info', `No engine handles ${type.mime}.`);
			return { kind: 'skipped', reason: 'unsupported-type' };
		}
		deps.progress(job, 'extracting');
		deps.log(job, 'info', `Extracting with ${extractor.id}`);
		const maxBytes = deps.maxNoteBytes();
		const extracted = await extractor.extract(
			{
				bytes,
				mime: type.mime,
				path: job.sourcePath,
				onProgress: (stage, f, detail) => deps.progress(job, stage, f, detail),
				log: (level, message) => deps.log(job, level, message),
				maxBytes,
				resumeKey: job.hash,
			},
			signal,
		);
		if (signal.aborted) return { kind: 'cancelled' };
		if (extracted.status === 'unsupported') return { kind: 'skipped', reason: 'unsupported-type' };
		if (extracted.status === 'failed') {
			deps.log(job, 'error', extracted.message);
			return { kind: 'failed', code: extracted.code, message: extracted.message };
		}
		if (extracted.status === 'no-text' || !hasText(extracted.markdown)) {
			if (extracted.status === 'extracted') await extracted.cleanup?.();
			// A note saying "no text" reads as done; a failed job can be retried or set to not process
			const failed = noTextOutcome(type.mime, job.sourcePath);
			deps.log(job, 'error', failed.message);
			return failed;
		}
		deps.log(job, 'info', `Extracted ${extracted.markdown.length.toLocaleString()} characters`);
		const result = capResult(deps, job, extracted, maxBytes);

		if (signal.aborted) return { kind: 'cancelled' };
		job.referencedBy = referencingNotes(deps.app, file, deps.isOwnNote);
		deps.progress(job, 'writing');
		const mode = deps.outputMode();
		const hosts = mode === 'note' ? [] : deps.inline.hosts(job.sourcePath).map((h) => h.file.path);

		const pictures = deps.pictures();
		const markdown = await attachFigures(deps, job, result, hosts, pictures, policy);

		// Summary, tags, title: warnings when they fail, never a failed job; the note is written without them
		const enrichment = await enrichNote(deps, job, markdown, signal);
		if (enrichment === 'cancelled') return { kind: 'cancelled' };
		if (signal.aborted) return { kind: 'cancelled' };

		const notePath = await writeOutputs(deps, job, job.hash, mode, hosts, type, result, markdown, enrichment);
		if (notePath === undefined) return { kind: 'failed', code: 'no-output', message: 'Nothing was written' };
		// Stopped too late: the note is written, so the job is done rather than cancelled or paused with a note it does not point to
		deps.log(job, signal.aborted ? 'warn' : 'info', signal.aborted ? `Wrote ${notePath} before it could stop` : `Wrote ${notePath}`);
		return { kind: 'done', notePath, extractor: result.engine, model: enrichment.model };
	} catch (error) {
		if (isAbort(error) || signal.aborted) return { kind: 'cancelled' };
		const message = errorMessage(error);
		deps.log(job, 'error', message);
		return { kind: 'failed', code: 'unexpected', message };
	}
}

/** The failure for a file the engine found no text in, with the likely fix for its kind. */
export function noTextOutcome(mime: string, path: string): Extract<JobOutcome, { kind: 'failed' }> {
	const kind = kindOf(mime);
	const pdf = baseMime(mime) === 'application/pdf' || path.toLowerCase().endsWith('.pdf');
	let message = 'No text found in this file.';
	if (kind === 'image') message = 'No text found in this picture. Set Images to Read text and describe to get a description.';
	else if (pdf) message = 'No text found. If this is a scan, set OCR to Every page under Extraction → Documents.';
	else if (kind === 'audio' || kind === 'video') message = 'No speech found in this file.';
	return { kind: 'failed', code: 'no-text', message };
}

/**
 * Keeps the text within the note size limit, for engines that did not cut it
 * themselves, and ends a cut text with a callout saying so. A note of hundreds
 * of MB (a big spreadsheet as a Markdown table) crashes Obsidian.
 */
function capResult(deps: PipelineDeps, job: Job, result: Extract<ExtractResult, { status: 'extracted' }>, maxBytes: number): Extracted {
	const { text, cut } = result.cut ? { text: result.markdown, cut: result.cut } : capText(result.markdown, maxBytes);
	if (!cut) return result;
	const kept = formatSize(cut.keptBytes);
	const total = formatSize(cut.totalBytes);
	deps.log(job, 'warn', `Kept the first ${kept} of ${total} of text. Raise Largest note in settings to keep more.`);
	const notice = `> [!warning] Text cut\n> Readable kept the first ${kept} of ${total}. The rest is in the source file; raise Largest note in Readable's settings to keep more.`;
	return { ...result, markdown: `${text}\n\n${notice}`, cut };
}

/** File type and kind, or a skip when the type is unknown or its kind is turned off. */
async function classify(
	deps: PipelineDeps,
	job: Job,
	bytes: Uint8Array,
	policy: ExtractionPolicy,
): Promise<{ type: DetectedType; kind: FileKind } | JobOutcome> {
	const type = await detectType(bytes, job.sourcePath);
	if (!type) {
		deps.log(job, 'info', 'Could not determine the file type.');
		return { kind: 'skipped', reason: 'unsupported-type' };
	}
	deps.log(job, 'info', `Detected ${type.mime}`);
	const kind = kindOf(type.mime);
	if (!kindEnabled(policy, kind)) {
		deps.log(job, 'info', `${KIND_LABEL[kind]} are set to Skip in settings. Retry after turning them on.`);
		return { kind: 'skipped', reason: 'disabled' };
	}
	if (kind === 'image' && policy.images === 'describe' && !policy.visionModel) {
		deps.log(job, 'info', 'No model that reads pictures is set; reading text only');
	}
	return { type, kind };
}

/** Saves the pictures the extractor found and links them from the markdown; always runs the extractor's cleanup. */
async function attachFigures(
	deps: PipelineDeps,
	job: Job,
	result: Extracted,
	hosts: string[],
	pictures: PicturePolicy,
	policy: ExtractionPolicy,
): Promise<string> {
	let markdown = result.markdown;
	try {
		if (markdown) {
			if (pictures === 'describe' && !policy.visionModel) {
				deps.log(job, 'info', 'No model that reads pictures is set; saving pictures only');
			}
			// Figures go with the note that will hold the text; with pictures off, every image link is the document's own and stays text
			const figuresDir = pictures === 'skip' ? null : (result.figuresDir ?? null);
			const figures = await saveFigures(deps.app, markdown, job.sourcePath, hosts[0] ?? deps.writer.pathFor(job.sourcePath), deps.figures(), figuresDir);
			markdown = neutraliseHtml(figures.markdown);
			if (figures.count > 0) deps.log(job, 'info', `Saved ${figures.count} figure(s)`);
		}
	} finally {
		await result.cleanup?.();
	}
	return markdown;
}

/** Summary, title and tags from the model, when one is set and there is text to read. */
async function enrichNote(
	deps: PipelineDeps,
	job: Job,
	markdown: string,
	signal: AbortSignal,
): Promise<Enrichment | 'cancelled'> {
	const llm = deps.llm();
	if (!llm) return { tags: [] };
	deps.progress(job, 'summarising');
	deps.log(job, 'info', `Asking ${llm.settings.model}`);
	const started = Date.now();
	let parts = 0;
	try {
		const added = await enrich(llm.client, markdown, llm.settings, {
			signal,
			onProgress: (done, total) => {
				// Parts, then one call that combines them; a short text is one call
				if (done === 0 && total > 2) deps.log(job, 'info', `Summarising in ${total - 1} parts`);
				parts = Math.max(parts, total - 1);
				deps.progress(job, 'summarising', total > 0 ? done / total : undefined, summaryStep(done, total));
			},
			onStep: (step) => deps.progress(job, 'summarising', undefined, step),
			log: (level, message, error) => {
				deps.log(job, level, message);
				if (error instanceof LlmUnavailable) deps.log(job, 'warn', PROVIDER_HINT);
			},
		});
		const enrichment: Enrichment = {
			summary: added.summary,
			title: added.title,
			tags: added.tags ?? [],
			model: added.model,
		};
		const { summary, title, tags } = enrichment;
		const got = [summary && (parts > 1 ? `summary (${parts} parts)` : 'summary'), title && 'title', tags.length > 0 && `${tags.length} tags`].filter(Boolean);
		if (got.length > 0) deps.log(job, 'info', `Added ${got.join(', ')} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
		return enrichment;
	} catch (error) {
		// enrich() logs its own failures; anything else still leaves the note written without AI content
		if (isAbort(error) || signal.aborted) return 'cancelled';
		deps.log(job, 'warn', `No AI content: ${errorMessage(error)}`);
		if (error instanceof LlmUnavailable) deps.log(job, 'warn', PROVIDER_HINT);
		return { tags: [] };
	}
}

/** The summarising step for the row: "part 3 of 7", then "combining parts"; one call for a short text. */
export function summaryStep(done: number, total: number): string {
	if (total <= 1) return 'summary';
	return done < total - 1 ? `part ${done + 1} of ${total - 1}` : 'combining parts';
}

/** Writes the text below each embed and/or into its own note, per the output mode; returns the path to show. */
async function writeOutputs(
	deps: PipelineDeps,
	job: Job,
	hash: string,
	mode: OutputMode,
	hosts: string[],
	type: DetectedType,
	result: Extracted,
	markdown: string,
	enrichment: Enrichment,
): Promise<string | undefined> {
	let notePath: string | undefined;
	if (hosts.length > 0) {
		const touched = await deps.inline.write({ sourcePath: job.sourcePath, hash, markdown });
		deps.log(job, 'info', `Added below the embed in ${hosts.length} note(s)`);
		notePath = touched[0] ?? hosts[0];
	}
	const wantsNote = mode === 'note' || mode === 'both' || (mode === 'inline' && hosts.length === 0);
	if (wantsNote) {
		if (mode === 'inline') deps.log(job, 'info', 'No note embeds this file; writing a separate note');
		notePath = await deps.writer.write({
			sourcePath: job.sourcePath,
			hash,
			type: type.ext,
			extractor: result.engine,
			tags: [type.ext, ...enrichment.tags],
			markdown,
			summary: enrichment.summary,
			title: enrichment.title,
			model: enrichment.model,
			pages: result.pages,
			referencedBy: job.referencedBy,
		});
	}
	return notePath;
}

/** Output for this content exists already, per the current output mode. */
async function alreadyProcessed(deps: PipelineConfig, hash: string, sourcePath: string): Promise<boolean> {
	const mode = deps.outputMode();
	const noteCurrent = () => deps.writer.hasNoteFor(sourcePath, hash);
	const inlineCurrent = () => deps.inline.isCurrent(sourcePath, hash);
	const embedded = deps.inline.hosts(sourcePath).length > 0;
	switch (mode) {
		case 'note':
			return noteCurrent();
		case 'both':
			return (await noteCurrent()) && (!embedded || (await inlineCurrent()));
		case 'inline':
			return embedded ? inlineCurrent() : noteCurrent();
	}
}

/** Notes linking to the file, other than Readable's own notes for it (they always embed it). */
function referencingNotes(app: App, file: TFile, isOwnNote: PipelineConfig['isOwnNote']): string[] | undefined {
	const resolved = app.metadataCache.resolvedLinks;
	const out: string[] = [];
	for (const [notePath, links] of Object.entries(resolved)) {
		if (!(file.path in links)) continue;
		const note = app.vault.getAbstractFileByPath(notePath);
		if (note instanceof TFile && isOwnNote(note, file.path)) continue;
		out.push(notePath.replace(/\.md$/, ''));
	}
	return out.length > 0 ? out : undefined;
}
