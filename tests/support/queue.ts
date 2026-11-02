/**
 * A queue service over a stub store, for the queue suites. Nothing touches
 * disk; saves and notifications are counted so tests can check them.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { TFile } from 'obsidian';
import { PersistentIngestService } from '../../src/queue/service';
import type { ServiceDeps } from '../../src/queue/service';
import type { Job, JobState, LogEntry, QueueSnapshot } from '../../src/core/types';

let created = 0;
/** A job for `sourcePath`; each one is newer than the last. */
export function job(sourcePath: string, state: JobState): Job {
	return { id: `job-${++created}`, sourcePath, state, createdAt: created, attempts: 1, trigger: 'auto-ingest' };
}

export interface Harness {
	service: PersistentIngestService;
	/** 'changed' events and saves since the queue was loaded. */
	changes: () => number;
	saves: () => number;
	/** What dispose() wrote, if it has run. */
	savedNow: () => QueueSnapshot | undefined;
}

/**
 * A queue over these jobs. Paused as a whole by default, so nothing runs and
 * only the queue's own rules act; `extra` supplies a pipeline for tests that
 * run a job (see blockingPipeline).
 */
export async function queue(jobs: Job[], options: { paused?: boolean; extra?: object } = {}): Promise<Harness> {
	let saves = 0;
	let changes = 0;
	let savedNow: QueueSnapshot | undefined;
	const store = {
		load: () => Promise.resolve({ version: 1 as const, paused: options.paused ?? true, jobs }),
		loadLogs: () => Promise.resolve(new Map<string, LogEntry[]>()),
		save: () => void saves++,
		saveNow: (state: QueueSnapshot) => {
			// A copy: the service keeps changing its jobs after
			savedNow = { ...state, jobs: state.jobs.map((j) => ({ ...j })) };
			return Promise.resolve();
		},
		appendLog: () => undefined,
		rewriteLogs: () => Promise.resolve(),
	};
	const service = new PersistentIngestService({ store, concurrency: () => 1, ...options.extra } as unknown as ServiceDeps);
	await service.init();
	saves = 0;
	service.subscribe((event) => {
		if (event.type === 'changed') changes++;
	});
	return { service, changes: () => changes, saves: () => saves, savedNow: () => savedNow };
}

/**
 * A pipeline that holds every job at reading its file until `release()`,
 * the point where a stop is noticed. A job that is not stopped carries on
 * to pick an engine, which `carriedOn` reports, and ends skipped.
 */
export function blockingPipeline(): { extra: object; release: () => void; carriedOn: () => boolean } {
	let release = () => {};
	const reading = new Promise<void>((resolve) => (release = resolve));
	let carriedOn = false;
	const extra = {
		app: {
			vault: {
				getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path, extension: path.split('.').pop() ?? '' }),
				readBinary: () => reading.then(() => new TextEncoder().encode('plain text').buffer),
			},
		},
		policy: () => ({ ignoreExtensions: [] }),
		outputMode: () => 'note',
		writer: { hasNoteFor: () => Promise.resolve(false) },
		inline: { hosts: () => [], isCurrent: () => Promise.resolve(false) },
		extractors: {
			select: () => {
				carriedOn = true;
				return undefined;
			},
		},
	};
	return { extra, release: () => release(), carriedOn: () => carriedOn };
}

/** Resolves on the first change after which `done` holds. */
export function until(service: PersistentIngestService, done: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		const stop = service.subscribe(() => {
			if (!done()) return;
			stop();
			resolve();
		});
	});
}

/** Lets pending timers and I/O run, so a pipeline that was not stopped would get on. */
export const settle = (): Promise<void> => delay(20);

export const states = (service: PersistentIngestService): [string, JobState][] =>
	service.getSnapshot().jobs.map((j) => [j.sourcePath, j.state]);

export const messages = (service: PersistentIngestService, id: string): string[] => service.getLog(id).map((e) => e.message);
