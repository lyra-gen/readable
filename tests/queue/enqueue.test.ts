import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PersistentIngestService } from '../../src/queue/service';
import type { Job } from '../../src/core/types';
import { job, queue as harness } from '../support/queue';

/** A paused queue over these jobs: nothing runs, so only the queue's own rules act. */
const queue = async (jobs: Job[]): Promise<PersistentIngestService> => (await harness(jobs)).service;

const jobsFor = (service: PersistentIngestService, sourcePath: string) => service.getSnapshot().jobs.filter((j) => j.sourcePath === sourcePath);

void describe('one job per file', () => {
	void test('adding a file twice keeps one job', async () => {
		const service = await queue([]);
		service.enqueue(['a.pdf'], 'manual');
		service.enqueue(['a.pdf'], 'auto-ingest');
		assert.equal(jobsFor(service, 'a.pdf').length, 1);
	});

	void test('the sweep for files without a note leaves a cancelled or failed job alone', async () => {
		const service = await queue([job('cancelled.pdf', 'cancelled'), job('failed.pdf', 'failed')]);
		service.enqueue(['cancelled.pdf', 'failed.pdf'], 'backfill');
		assert.deepEqual(
			service.getSnapshot().jobs.map((j) => [j.sourcePath, j.state]),
			[
				['cancelled.pdf', 'cancelled'],
				['failed.pdf', 'failed'],
			],
		);
	});

	void test('adding a file by hand retries its failed job instead of adding another', async () => {
		const failed = job('a.pdf', 'failed');
		const service = await queue([failed]);
		service.enqueue(['a.pdf'], 'manual');
		const [only] = jobsFor(service, 'a.pdf');
		assert.equal(jobsFor(service, 'a.pdf').length, 1);
		assert.equal(only?.id, failed.id);
		assert.equal(only?.state, 'pending');
		assert.equal(only?.trigger, 'manual');
	});

	void test('a file whose note was made gets a new job when it changes', async () => {
		const service = await queue([job('a.pdf', 'done')]);
		service.enqueue(['a.pdf'], 'auto-ingest');
		assert.deepEqual(
			jobsFor(service, 'a.pdf').map((j) => j.state),
			['done', 'pending'],
		);
	});

	void test('duplicates from older versions are dropped on load, keeping the live job and the history', async () => {
		const service = await queue([
			job('a.pdf', 'done'),
			job('a.pdf', 'cancelled'),
			job('a.pdf', 'pending'),
			job('a.pdf', 'failed'),
			job('b.doc', 'failed'),
			job('b.doc', 'cancelled'),
		]);
		assert.deepEqual(
			jobsFor(service, 'a.pdf').map((j) => j.state),
			['done', 'pending'],
		);
		assert.deepEqual(
			jobsFor(service, 'b.doc').map((j) => j.state),
			['cancelled'],
		);
	});
});
