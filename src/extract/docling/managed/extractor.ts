import { ENGINE_UNAVAILABLE } from '../../../core/types';
import { capText, readCapped } from '../../cap';
import type { TextCut } from '../../cap';
import type { ExtractInput, ExtractResult, Extractor } from '../../types';
import { abortError, errorMessage, isAbort, throwIfAborted } from '../../../core/errors';
import { kindOf } from '../../kinds';
import { doclingSupports } from '../formats';
import { mapConvertResponse } from '../response';
import type { ConvertResponse, ConvertStatus } from '../response';
import type { ManagedDocling, ManagedDoclingDeps } from './manager';
import { SidecarError, SidecarExited } from './sidecar';
import { convertWithTextutil, isLegacyOffice, legacyRoute } from './legacy-office';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Pages per convert call; progress and cancel happen between chunks. Ten read
 * about 40% faster per page than five (1.0 against 1.6 s per page on an M2 Max);
 * more threads or bigger model batches made no difference.
 */
const CHUNK_PAGES = 10;
/** Crashes in a row before the engine counts as unavailable and the queue pauses. */
const MAX_CRASHES = 2;
/** Seconds allowed per second of recording: Whisper needs about a twentieth; this leaves room for a busy machine. */
const RECORDING_ALLOWANCE = 0.5;
/** Times a convert is sent again after the sidecar was killed for another file's stall; past this it counts as a crash. */
const MAX_RESENDS = 3;
/** Checkpoints older than this belong to jobs that will not come back. */
const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

interface ConvertResult {
	status: ConvertStatus | 'cancelled';
	/** Inline only from an older sidecar; now the text is in the file at `markdown_path`. */
	markdown: string;
	markdown_path?: string;
	errors: ConvertResponse['errors'];
	pages: number | null;
	seconds: number;
}

/** attempt(): the sidecar was killed for another request, so this one is sent again. */
const RESEND = Symbol('resend');

/**
 * Converts through the sidecar. Cancel is passed on and takes effect at the
 * next page chunk; a timeout kills the sidecar, which is the only way to stop
 * a conversion mid-chunk. Crashes fail the job; repeated ones, or a sidecar
 * that cannot start, count as the engine being unavailable. Killing the
 * sidecar stops both of its lanes: the other file is sent again, not failed.
 * A PDF's finished chunks are kept in a checkpoint folder named after the
 * file's hash and the options that change the text, so a retry resumes. The
 * text comes back in a file, read no further than the note will keep.
 */
export class ManagedDoclingExtractor implements Extractor {
	readonly id = 'docling';
	private crashes = 0;
	/** The sidecar process last counted as a crash: one exit fails every open request, but is one crash. */
	private crashedGeneration = -1;
	/** Per sidecar lane: the sidecar generation and options the models were last loaded for. */
	private readonly warmKeys = new Map<'media' | 'document', string>();
	private pruned = false;

	constructor(
		private readonly managed: ManagedDocling,
		private readonly deps: ManagedDoclingDeps,
	) {}

	supports(mime: string): boolean {
		// Audio and video need the speech add-on (Whisper, ffmpeg)
		return doclingSupports(mime, this.managed.speechInstalled);
	}

	async extract(input: ExtractInput, signal: AbortSignal): Promise<ExtractResult> {
		if (!this.managed.ready) {
			const installing = this.managed.installState.kind === 'installing';
			return {
				status: 'failed',
				code: ENGINE_UNAVAILABLE,
				message: installing ? 'Docling is still installing.' : "Docling isn't installed. Install it in Readable's settings.",
			};
		}
		let source = this.deps.fullPath(input.path);
		let libreOffice: string | null = null;
		let converted: string | null = null;
		if (isLegacyOffice(input.mime, input.path)) {
			const route = await legacyRoute(input.mime, input.path, this.deps.findLibreOffice);
			if (route.via === 'none') return { status: 'failed', code: 'legacy-office', message: route.message };
			if (route.via === 'libreoffice') {
				libreOffice = route.command;
				input.log?.('info', `Old Office file; LibreOffice converts it (${route.command})`);
			} else {
				input.log?.('info', 'Old Word file; converting it with macOS textutil');
				const options = this.deps.options();
				if (options.figures || options.describePictures) input.log?.('warn', 'Pictures in old Word files need LibreOffice; this one is read without them');
				try {
					converted = await convertWithTextutil(source, path.join(this.managed.paths.tmp, `legacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`), signal);
				} catch (error) {
					if (isAbort(error) || signal.aborted) throw abortError();
					return { status: 'failed', code: 'legacy-office', message: `macOS couldn't read this Word file: ${errorMessage(error)}` };
				}
				source = converted;
			}
		}
		try {
			input.onProgress?.('extracting');
			await this.deps.prepare?.();
			void this.pruneCheckpoints();
			for (let resends = 0; ; resends++) {
				const result = await this.attempt(input, source, libreOffice, signal, resends < MAX_RESENDS);
				if (result !== RESEND) return result;
				throwIfAborted(signal);
				input.log?.('info', 'Docling restarted for another file; trying again');
			}
		} finally {
			if (converted) await fs.rm(path.dirname(converted), { recursive: true, force: true });
		}
	}

	/**
	 * One send to the sidecar; RESEND when it was killed for another request and `canResend`.
	 * `source` is the file Docling reads: the input, or its textutil conversion. `libreOffice`: the
	 * soffice Docling converts an old Office file with.
	 */
	private async attempt(input: ExtractInput, source: string, libreOffice: string | null, signal: AbortSignal, canResend: boolean): Promise<ExtractResult | typeof RESEND> {
		/** Killed deliberately, for a request other than `own`: this one did nothing wrong. */
		const killedForAnother = (error: unknown, own: number | null) =>
			canResend && error instanceof SidecarExited && error.killedFor !== undefined && error.killedFor !== own;
		const options = this.deps.options();
		const sidecar = this.managed.sidecar;
		const kind = kindOf(input.mime);
		const lane = kind === 'audio' || kind === 'video' ? 'media' : 'document';
		const describing = options.describePictures && options.vision && kind === 'document';
		// What changes the text; the vision server's address and key do not
		const textOptions = {
			kind,
			ocr: options.ocr,
			table_mode: options.tableMode,
			chunk_pages: CHUNK_PAGES,
			language: options.language,
			timestamps: options.timestamps,
			describe_pictures: options.describePictures,
			describe_image: options.describeImages,
		};
		const vision = options.vision ? { model: options.vision.model, prompt: options.vision.prompt } : null;
		// A resumable job keeps its finished chunks, and its figures, in a folder named after the content and the options
		const checkpointKey = JSON.stringify({ ...textOptions, figures: options.figures, vision });
		const checkpointDir = input.resumeKey ? path.join(this.managed.paths.checkpoints, sha256(`${input.resumeKey}\n${checkpointKey}`).slice(0, 32)) : null;
		const scratch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		// Figures land under app data; the pipeline moves them into the vault, then cleanup() removes them
		const imagesDir = !options.figures ? null : checkpointDir ? path.join(checkpointDir, 'figures') : path.join(this.managed.paths.tmp, `figures-${scratch}`);
		// The text comes back in this file, not over the pipe: a big document would be one huge stdout line
		const outputPath = path.join(this.managed.paths.tmp, `convert-${scratch}.md`);
		const convertOptions = {
			...textOptions,
			...(options.vision ? { vision: { url: options.vision.url, api_key: options.vision.apiKey, model: options.vision.model, prompt: options.vision.prompt } } : {}),
			...(imagesDir ? { images_dir: imagesDir } : {}),
			...(checkpointDir ? { checkpoint_dir: checkpointDir } : {}),
			...(libreOffice ? { libreoffice: libreOffice } : {}),
		};
		/** Once the result is final; an interrupted convert keeps its checkpoint to resume from. */
		const cleanup = async () => {
			if (checkpointDir) await fs.rm(checkpointDir, { recursive: true, force: true });
			else if (imagesDir) await fs.rm(imagesDir, { recursive: true, force: true });
		};
		/** After an interruption: only scratch figures go; a checkpoint stays for the next attempt. */
		const discardScratch = async () => {
			if (!checkpointDir && imagesDir) await fs.rm(imagesDir, { recursive: true, force: true });
		};
		const removeOutput = () => fs.rm(outputPath, { force: true });
		// Start and load the models first, so that does not count against the file's timeout
		let generation = -1;
		try {
			await sidecar.start();
			generation = sidecar.generation;
			// Same inputs the sidecar keys its converter on, so a different converter is warmed when they change
			const warmKey =
				lane === 'media'
					? `${sidecar.generation}:${options.language}`
					: `${sidecar.generation}:${JSON.stringify(options.ocr)}:${options.tableMode}:${options.figures}:${describing ? `${options.vision?.url}|${options.vision?.model}|${options.vision?.prompt}` : ''}`;
			if (this.warmKeys.get(lane) !== warmKey) {
				input.log?.('info', 'Loading Docling');
				await sidecar.request('warmup', { options: convertOptions }, { signal });
				this.warmKeys.set(lane, warmKey);
			}
		} catch (error) {
			if (isAbort(error)) throw error;
			if (killedForAnother(error, null)) return RESEND;
			// The sidecar is fine but these options cannot be served (e.g. no engine for the OCR language)
			if (error instanceof SidecarError) return { status: 'failed', code: 'docling', message: error.message };
			const tail = error instanceof SidecarExited ? error.stderrTail : '';
			if (tail) input.log?.('error', tail);
			const message = errorMessage(error);
			return { status: 'failed', code: ENGINE_UNAVAILABLE, message: `${message}. Try reinstalling Docling.` };
		}
		throwIfAborted(signal);
		let requestId: number | null = null;
		let loggedQuarter = 0;
		let firstProgress = true;
		let timedOut = false;
		// The timeout counts time without progress: a 200-page PDF keeps going while its pages advance.
		// A recording reports nothing until it is done, so it gets time in proportion to its length instead.
		let timer: number | null = null;
		let allowedSec = options.timeoutSec;
		const arm = () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timedOut = true;
				sidecar.kill(requestId ?? undefined);
			}, allowedSec * 1000);
		};
		// Each sidecar lane reads one file at a time: until it takes this one up, the job is waiting, and the timeout has not started
		const sent = Date.now();
		input.onProgress?.('extracting', undefined, 'waiting for Docling');
		const onStarted = () => {
			const waited = Math.round((Date.now() - sent) / 1000);
			if (waited >= 2) input.log?.('info', `Waited ${waited} s for Docling`);
			input.onProgress?.('extracting', undefined, '');
			arm();
		};

		let result: ConvertResult;
		try {
			await fs.mkdir(this.managed.paths.tmp, { recursive: true });
			result = await sidecar.request<ConvertResult>(
				'convert',
				{
					path: source,
					output_path: outputPath,
					options: convertOptions,
				},
				{
					signal,
					onStarted,
					onId: (id) => (requestId = id),
					onProgress: (done, total, detail, seconds) => {
						if (seconds) allowedSec = Math.max(options.timeoutSec, Math.ceil(seconds * RECORDING_ALLOWANCE));
						arm();
						// Pages come in chunks of ten; the log gets the start and each quarter, the bar every chunk
						if (firstProgress && total > 0) {
							input.log?.('info', done > 0 ? `Resuming: ${done} of ${total} pages read before` : `Reading ${total} pages`);
							loggedQuarter = Math.floor((done / total) * 4);
						}
						firstProgress = false;
						const quarter = total > 0 ? Math.floor((done / total) * 4) : 0;
						if (quarter > loggedQuarter && done < total) {
							loggedQuarter = quarter;
							input.log?.('info', `Read ${done} of ${total} pages`);
						}
						if (detail && (kind === 'audio' || kind === 'video')) input.log?.('info', `Transcribing ${detail}`);
						input.onProgress?.('extracting', total > 0 ? done / total : undefined, total > 0 ? `page ${done} of ${total}` : detail);
					},
				},
			);
		} catch (error) {
			await discardScratch();
			await removeOutput();
			if (isAbort(error)) {
				if (requestId !== null) sidecar.cancel(requestId);
				throw error;
			}
			if (timedOut) {
				return { status: 'failed', code: 'docling-timeout', message: `Docling made no progress for ${allowedSec} s` };
			}
			// A PDF resumes from its checkpoint; a recording starts again
			if (killedForAnother(error, requestId)) return RESEND;
			if (error instanceof SidecarExited) {
				if (error.stderrTail) input.log?.('error', error.stderrTail);
				if (generation !== this.crashedGeneration) {
					this.crashedGeneration = generation;
					this.crashes++;
				}
				if (this.crashes >= MAX_CRASHES) {
					this.crashes = 0;
					return { status: 'failed', code: ENGINE_UNAVAILABLE, message: `${error.message}. Try reinstalling Docling.` };
				}
				return { status: 'failed', code: 'docling-crash', message: error.message };
			}
			if (error instanceof SidecarError) return { status: 'failed', code: 'docling', message: error.message };
			throw error;
		} finally {
			if (timer !== null) window.clearTimeout(timer);
		}

		this.crashes = 0;
		let markdown: string;
		let cut: TextCut | undefined;
		try {
			// Read off the main thread, and no more than the note will keep; the file is ours either way
			const max = input.maxBytes ?? Infinity;
			({ text: markdown, cut } = result.markdown_path ? await readCapped(result.markdown_path, max) : capText(result.markdown, max));
		} catch (error) {
			await discardScratch();
			return { status: 'failed', code: 'docling', message: `Couldn't read Docling's output: ${errorMessage(error)}` };
		} finally {
			await removeOutput();
		}
		if (result.status === 'cancelled') {
			await discardScratch();
			throw abortError();
		}
		const { result: mapped, warnings } = mapConvertResponse({
			status: result.status,
			errors: result.errors,
			document: { md_content: markdown },
		});
		for (const warning of warnings) input.log?.('warn', warning);
		input.log?.('info', `Docling took ${result.seconds.toFixed(1)} s${result.pages ? ` for ${result.pages} pages` : ''}`);
		if (mapped.status !== 'extracted') {
			await cleanup();
			return mapped;
		}
		return { ...mapped, cleanup, ...(imagesDir ? { figuresDir: imagesDir } : {}), ...(cut ? { cut } : {}) };
	}

	/** Checkpoints of jobs that never came back (removed, or the file deleted); once per session. */
	private async pruneCheckpoints(): Promise<void> {
		if (this.pruned) return;
		this.pruned = true;
		const root = this.managed.paths.checkpoints;
		const entries = await fs.readdir(root).catch(() => [] as string[]);
		for (const name of entries) {
			const dir = path.join(root, name);
			const stat = await fs.stat(dir).catch(() => null);
			if (stat && Date.now() - stat.mtimeMs > CHECKPOINT_MAX_AGE_MS) await fs.rm(dir, { recursive: true, force: true });
		}
	}
}
