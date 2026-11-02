/**
 * Killing the sidecar for one file's stall takes down the other lane too: the
 * other file is sent again, not failed. Over a fake sidecar, no Docling needed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { ManagedDoclingExtractor } from '../../src/extract/docling/managed/extractor';
import type { ManagedDocling, ManagedDoclingDeps } from '../../src/extract/docling/managed/manager';
import { SidecarExited } from '../../src/extract/docling/managed/sidecar';
import type { ExtractResult } from '../../src/extract/types';

interface Opts {
	onProgress?: (done: number, total: number, detail?: string, seconds?: number) => void;
	onStarted?: () => void;
	onId?: (id: number) => void;
}

/** What a convert does once taken up: hang until killed, succeed, or crash the sidecar. */
type Behaviour = 'hang' | 'succeed' | 'crash';

/** A sidecar that runs converts as `behave` says, per kind and per call of that kind. */
class FakeSidecar {
	generation = 1;
	private nextId = 1;
	private readonly open = new Map<number, (error: Error) => void>();
	readonly calls: Record<string, number> = {};

	constructor(private readonly behave: (kind: string, call: number) => Behaviour) {}

	start(): Promise<void> {
		return Promise.resolve();
	}

	request(method: string, params: { options: { kind: string } }, opts: Opts = {}): Promise<unknown> {
		const id = this.nextId++;
		opts.onId?.(id);
		if (method === 'warmup') return Promise.resolve(null);
		const kind = params.options.kind;
		this.calls[kind] = (this.calls[kind] ?? 0) + 1;
		const behaviour = this.behave(kind, this.calls[kind]);
		return new Promise((resolve, reject) => {
			this.open.set(id, reject);
			opts.onStarted?.();
			// A recording sends its length first, which gives it far longer than the stalled PDF
			if (kind === 'audio') opts.onProgress?.(0, 0, 'a 100-second recording', 100);
			if (behaviour === 'succeed') {
				this.open.delete(id);
				resolve({ status: 'success', markdown: 'Hello from the recording', errors: [], pages: null, seconds: 1 });
			}
			if (behaviour === 'crash') window.setTimeout(() => this.exit(undefined), 5);
		});
	}

	kill(forRequest?: number): void {
		this.exit(forRequest);
	}

	cancel(): void {}

	private exit(killedFor: number | undefined): void {
		const error = new SidecarExited('Docling stopped (SIGKILL)', '', killedFor);
		for (const reject of this.open.values()) reject(error);
		this.open.clear();
		this.generation++;
	}
}

/** `timeoutSec`: seconds without progress before a stall; 50 ms unless a test needs no stall. */
function extractor(sidecar: FakeSidecar, timeoutSec = 0.05): ManagedDoclingExtractor {
	const dir = mkdtempSync(path.join(tmpdir(), 'readable-resend-'));
	const managed = {
		ready: true,
		installState: { kind: 'installed' },
		speechInstalled: true,
		sidecar,
		paths: { checkpoints: path.join(dir, 'checkpoints'), tmp: path.join(dir, 'tmp') },
	} as unknown as ManagedDocling;
	const deps: ManagedDoclingDeps = {
		fullPath: (p) => p,
		options: () => ({
			figures: false,
			ocr: { mode: 'auto', languages: ['en'], engine: 'auto' },
			tableMode: 'accurate',
			timeoutSec,
			language: '',
			timestamps: true,
			vision: null,
			describePictures: false,
			describeImages: false,
		}),
		devLog: () => {},
	};
	return new ManagedDoclingExtractor(managed, deps);
}

async function run(docling: ManagedDoclingExtractor, file: string, mime: string): Promise<{ result: ExtractResult; log: string[] }> {
	const log: string[] = [];
	const result = await docling.extract(
		{ bytes: new Uint8Array(), mime, path: file, log: (level, message) => log.push(`${level}: ${message}`) },
		new AbortController().signal,
	);
	return { result, log };
}

const RESENT = 'info: Docling restarted for another file; trying again';

void describe('a sidecar killed for another file', () => {
	void test('the recording beside a stalled PDF is sent again and finishes; the PDF times out', async () => {
		const sidecar = new FakeSidecar((kind, call) => (kind === 'audio' && call > 1 ? 'succeed' : 'hang'));
		const docling = extractor(sidecar);
		const [pdf, recording] = await Promise.all([run(docling, 'a.pdf', 'application/pdf'), run(docling, 'b.mp3', 'audio/mpeg')]);
		assert.equal(pdf.result.status, 'failed');
		assert.equal(pdf.result.status === 'failed' && pdf.result.code, 'docling-timeout');
		assert.ok(!pdf.log.includes(RESENT));
		assert.equal(recording.result.status, 'extracted');
		assert.equal(recording.log.filter((line) => line === RESENT).length, 1);
		assert.equal(sidecar.calls.audio, 2);
	});

	void test('the kill does not count as a crash of the recording', async () => {
		// Sent again, the recording crashes the sidecar itself: its first crash, so not yet "engine unavailable"
		const sidecar = new FakeSidecar((kind, call) => (kind === 'audio' && call > 1 ? 'crash' : 'hang'));
		const docling = extractor(sidecar);
		const [, recording] = await Promise.all([run(docling, 'a.pdf', 'application/pdf'), run(docling, 'b.mp3', 'audio/mpeg')]);
		assert.equal(recording.result.status === 'failed' && recording.result.code, 'docling-crash');
		assert.equal(recording.log.filter((line) => line === RESENT).length, 1);
	});

	void test('one crash under two open requests counts once', async () => {
		// The recording crashes the sidecar while the PDF is being read: both fail, and neither pauses the queue
		const sidecar = new FakeSidecar((kind) => (kind === 'audio' ? 'crash' : 'hang'));
		const docling = extractor(sidecar, 5);
		const [pdf, recording] = await Promise.all([run(docling, 'a.pdf', 'application/pdf'), run(docling, 'b.mp3', 'audio/mpeg')]);
		assert.equal(pdf.result.status === 'failed' && pdf.result.code, 'docling-crash');
		assert.equal(recording.result.status === 'failed' && recording.result.code, 'docling-crash');
		assert.ok(!pdf.log.includes(RESENT) && !recording.log.includes(RESENT));
	});

	void test('crashes of two processes in a row make the engine unavailable', async () => {
		const sidecar = new FakeSidecar(() => 'crash');
		const docling = extractor(sidecar);
		const first = await run(docling, 'a.mp3', 'audio/mpeg');
		assert.equal(first.result.status === 'failed' && first.result.code, 'docling-crash');
		const second = await run(docling, 'b.mp3', 'audio/mpeg');
		assert.equal(second.result.status === 'failed' && second.result.code, 'engine-unavailable');
	});

	void test('a plain crash is not sent again', async () => {
		const sidecar = new FakeSidecar(() => 'crash');
		const { result, log } = await run(extractor(sidecar), 'b.mp3', 'audio/mpeg');
		assert.equal(result.status === 'failed' && result.code, 'docling-crash');
		assert.ok(!log.includes(RESENT));
		assert.equal(sidecar.calls.audio, 1);
	});
});
