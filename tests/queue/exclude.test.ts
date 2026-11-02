import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blockingPipeline, job, messages, queue, settle, states, until } from '../support/queue';

void describe("don't process", () => {
	void test('a file without a job gets an excluded one; one with a job is excluded in place', async () => {
		const failed = job('b.doc', 'failed');
		const { service, changes } = await queue([failed]);
		service.excludePaths(['a.pdf', 'b.doc', 'a.pdf']);
		assert.deepEqual(states(service), [
			['b.doc', 'excluded'],
			['a.pdf', 'excluded'],
		]);
		assert.equal(service.getSnapshot().jobs.length, 2, 'one job per file');
		assert.equal(changes(), 1, 'one change for the batch');
		assert.equal(service.getSnapshot().jobs[0]?.error, undefined, 'the old failure is cleared');
	});

	void test('nothing queues an excluded file on its own', async () => {
		const a = job('a.pdf', 'excluded');
		const { service, changes } = await queue([a]);
		service.enqueue(['a.pdf'], 'backfill');
		service.enqueue(['a.pdf'], 'auto-ingest');
		assert.deepEqual(states(service), [['a.pdf', 'excluded']]);
		assert.equal(changes(), 0);
	});

	void test('adding the file by hand, or Process again, puts it back in line', async () => {
		for (const trigger of ['manual', 'context-menu'] as const) {
			const a = job('a.pdf', 'excluded');
			const { service } = await queue([a]);
			service.enqueue(['a.pdf'], trigger);
			assert.deepEqual(states(service), [['a.pdf', 'pending']]);
			assert.equal(messages(service, a.id).at(-1), 'Process again');
		}
		const b = job('b.pdf', 'excluded');
		const { service } = await queue([b]);
		service.includeJobs([b.id]);
		assert.deepEqual(states(service), [['b.pdf', 'pending']]);
	});

	void test('it survives a reload, Clear finished and the history cleanup', async () => {
		const { service } = await queue([job('a.pdf', 'excluded'), job('b.pdf', 'done'), job('c.pdf', 'cancelled')]);
		assert.deepEqual(states(service)[0], ['a.pdf', 'excluded']);
		service.clearFinished();
		assert.deepEqual(states(service), [['a.pdf', 'excluded']]);
	});

	void test('an excluded job wins over older failures when duplicates are cleaned up', async () => {
		const { service } = await queue([job('a.pdf', 'excluded'), job('a.pdf', 'failed')]);
		assert.deepEqual(states(service), [['a.pdf', 'excluded']]);
	});

	void test('a running job stops and ends excluded, not cancelled', async () => {
		const pipeline = blockingPipeline();
		const a = job('a.txt', 'pending');
		const { service } = await queue([a], { paused: false, extra: pipeline.extra });
		assert.deepEqual(states(service), [['a.txt', 'running']]);
		service.excludeJobs([a.id]);
		pipeline.release();
		await until(service, () => service.getSnapshot().jobs[0]?.state !== 'running');
		await settle();
		assert.ok(!pipeline.carriedOn(), 'the pipeline stopped');
		assert.deepEqual(states(service), [['a.txt', 'excluded']]);
		assert.ok(!messages(service, a.id).includes('Cancelled'));
	});

	void test('jobs follow a renamed file, so it stays excluded', async () => {
		const { service } = await queue([job('inbox/a.pdf', 'excluded')]);
		service.renamePath('inbox/a.pdf', 'inbox/old/a.pdf');
		assert.deepEqual(states(service), [['inbox/old/a.pdf', 'excluded']]);
		service.enqueue(['inbox/old/a.pdf'], 'backfill');
		assert.deepEqual(states(service), [['inbox/old/a.pdf', 'excluded']]);
	});
});
