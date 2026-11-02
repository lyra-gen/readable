import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { laneOf } from '../../src/extract/kinds';
import type { Job } from '../../src/core/types';
import { blockingPipeline, job, queue, states, until } from '../support/queue';

/** A running queue over these jobs, each held at reading its file until `release()`. */
async function running(jobs: Job[]) {
	const pipeline = blockingPipeline();
	const harness = await queue(jobs, { paused: false, extra: pipeline.extra });
	return { ...harness, ...pipeline };
}

void describe('job lanes', () => {
	void test('recordings go to the media lane, everything else to documents', () => {
		for (const file of ['talk.mp3', 'notes/Call.M4A', 'clip.mov', 'a.b/film.webm', 'voice.ogg', 'x/book.m4b', 'mix.mka', 'clip.3g2']) assert.equal(laneOf(file), 'media', file);
		for (const file of ['a.pdf', 'scan.png', 'deck.pptx', 'notes.txt', 'no-extension', 'odd.xyz', 'mp3/readme']) assert.equal(laneOf(file), 'document', file);
	});

	void test('with one job at a time, a PDF and a recording start together', async () => {
		const { service } = await running([job('a.pdf', 'pending'), job('b.mp3', 'pending')]);
		assert.deepEqual(states(service), [
			['a.pdf', 'running'],
			['b.mp3', 'running'],
		]);
	});

	void test('two PDFs do not', async () => {
		const { service } = await running([job('a.pdf', 'pending'), job('b.pdf', 'pending')]);
		assert.deepEqual(states(service), [
			['a.pdf', 'running'],
			['b.pdf', 'pending'],
		]);
	});

	void test('a job waiting for its lane does not hold up one of the other lane behind it', async () => {
		const { service } = await running([job('a.pdf', 'pending'), job('b.pdf', 'pending'), job('c.wav', 'pending'), job('d.mp4', 'pending')]);
		assert.deepEqual(states(service), [
			['a.pdf', 'running'],
			['b.pdf', 'pending'],
			['c.wav', 'running'],
			['d.mp4', 'pending'],
		]);
	});

	void test('within a lane, jobs start in queue order', async () => {
		const { service, release } = await running([job('a.pdf', 'pending'), job('b.pdf', 'pending'), job('c.mp3', 'pending'), job('d.pdf', 'pending')]);
		const started: string[] = service
			.getSnapshot()
			.jobs.filter((j) => j.state === 'running')
			.map((j) => j.sourcePath);
		service.subscribe(() => {
			for (const j of service.getSnapshot().jobs) if (j.state === 'running' && !started.includes(j.sourcePath)) started.push(j.sourcePath);
		});
		release();
		await until(service, () => service.getSnapshot().jobs.every((j) => j.state === 'skipped'));
		assert.deepEqual(started, ['a.pdf', 'c.mp3', 'b.pdf', 'd.pdf']);
	});

	void test('the limit is per lane', async () => {
		const pipeline = blockingPipeline();
		const jobs = ['a.pdf', 'b.pdf', 'c.pdf', 'd.mp3', 'e.mp3', 'f.mp3'].map((p) => job(p, 'pending'));
		const { service } = await queue(jobs, { paused: false, extra: { ...pipeline.extra, concurrency: () => 2 } });
		assert.deepEqual(
			states(service).filter(([, state]) => state === 'running').map(([p]) => p),
			['a.pdf', 'b.pdf', 'd.mp3', 'e.mp3'],
		);
	});
});
