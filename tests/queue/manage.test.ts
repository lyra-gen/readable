import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sortJobs } from '../../src/ui/format';
import { blockingPipeline, job, messages, queue, settle, states, until } from '../support/queue';
import type { Harness } from '../support/queue';

/** A queue that is running `a.txt`, held at reading the file until `release()`. */
async function runningOne(): Promise<Harness & ReturnType<typeof blockingPipeline> & { id: string }> {
	const pipeline = blockingPipeline();
	const a = job('a.txt', 'pending');
	const harness = await queue([a], { paused: false, extra: pipeline.extra });
	assert.deepEqual(states(harness.service), [['a.txt', 'running']]);
	return { ...harness, ...pipeline, id: a.id };
}

void describe('pausing a job', () => {
	void test('a waiting job pauses and resumes', async () => {
		const a = job('a.pdf', 'pending');
		const { service } = await queue([a]);
		service.pauseJobs([a.id]);
		assert.deepEqual(states(service), [['a.pdf', 'paused']]);
		service.resumeJobs([a.id]);
		assert.deepEqual(states(service), [['a.pdf', 'pending']]);
		assert.deepEqual(messages(service, a.id), ['Paused', 'Resumed']);
	});

	void test('the worker passes over a paused job', async () => {
		const a = job('a.pdf', 'paused');
		// Not paused as a whole: the worker would take a pending job straight away
		const { service } = await queue([a], { paused: false });
		assert.deepEqual(states(service), [['a.pdf', 'paused']]);
	});

	void test('a paused job stays paused across a reload, a running one waits again', async () => {
		const { service } = await queue([job('a.pdf', 'paused'), job('b.pdf', 'running')]);
		assert.deepEqual(states(service), [
			['a.pdf', 'paused'],
			['b.pdf', 'pending'],
		]);
	});

	void test('the sweep for files without a note leaves a paused job alone', async () => {
		const { service } = await queue([job('a.pdf', 'paused')]);
		service.enqueue(['a.pdf'], 'backfill');
		service.enqueue(['a.pdf'], 'auto-ingest');
		assert.deepEqual(states(service), [['a.pdf', 'paused']]);
	});

	for (const trigger of ['manual', 'context-menu'] as const) {
		void test(`adding a paused file by hand (${trigger}) resumes it`, async () => {
			const a = job('a.pdf', 'paused');
			const { service } = await queue([a]);
			service.enqueue(['a.pdf'], trigger);
			assert.deepEqual(states(service), [['a.pdf', 'pending']]);
			const [only] = service.getSnapshot().jobs;
			assert.equal(only?.id, a.id);
			assert.equal(only?.trigger, trigger);
			assert.equal(messages(service, a.id).at(-1), 'Resumed');
		});
	}

	void test('on load, a paused job wins over a newer failed one for the same file', async () => {
		const { service } = await queue([job('a.pdf', 'paused'), job('a.pdf', 'failed')]);
		assert.deepEqual(states(service), [['a.pdf', 'paused']]);
	});

	void test('Clear finished keeps paused jobs', async () => {
		const { service } = await queue([job('a.pdf', 'paused'), job('b.pdf', 'done')]);
		service.clearFinished();
		assert.deepEqual(states(service), [['a.pdf', 'paused']]);
	});
});

void describe('pausing a running job', () => {
	void test('stops it and leaves it paused, not cancelled', async () => {
		const { service, release, carriedOn, id } = await runningOne();
		service.pauseJobs([id]);
		assert.ok(service.isPausing(id));
		release();
		await until(service, () => messages(service, id).includes('Paused'));
		// Had it not been stopped, the pipeline would carry on and finish it some other way
		await settle();
		assert.ok(!carriedOn(), 'the pipeline stopped');
		assert.deepEqual(states(service), [['a.txt', 'paused']]);
		assert.equal(service.getSnapshot().jobs[0]?.finishedAt, undefined);
		assert.equal(messages(service, id).filter((m) => m === 'Paused').length, 1);
		assert.ok(!messages(service, id).includes('Cancelled'));
		assert.ok(!service.isPausing(id));
	});

	void test('the pause shows straight away, while it stops', async () => {
		const { service, changes, release, id } = await runningOne();
		const before = changes();
		service.pauseJobs([id]);
		assert.equal(changes() - before, 1);
		// A second Pause changes nothing
		service.pauseJobs([id]);
		assert.equal(changes() - before, 1);
		release();
	});

	void test('resumed before it has stopped, it waits again instead of ending paused', async () => {
		const { service, release, id } = await runningOne();
		service.pause();
		service.pauseJobs([id]);
		service.resumeJobs([id]);
		assert.ok(!service.isPausing(id));
		release();
		await until(service, () => service.getSnapshot().jobs[0]?.state !== 'running');
		assert.deepEqual(states(service), [['a.txt', 'pending']]);
		assert.ok(messages(service, id).includes('Resumed'));
		assert.ok(!messages(service, id).includes('Cancelled'));
		assert.ok(!messages(service, id).includes('Paused'));
	});

	void test('cancelled before it has stopped, it ends cancelled', async () => {
		const { service, release, id } = await runningOne();
		service.pauseJobs([id]);
		service.cancelJobs([id]);
		release();
		await until(service, () => service.getSnapshot().jobs[0]?.state !== 'running');
		assert.deepEqual(states(service), [['a.txt', 'cancelled']]);
		assert.equal(messages(service, id).at(-1), 'Cancelled');
	});

	void test('removed before it has stopped, it stays gone', async () => {
		const { service, release, id } = await runningOne();
		service.pauseJobs([id]);
		service.removeJobs([id]);
		assert.deepEqual(states(service), []);
		release();
		await settle();
		assert.deepEqual(states(service), []);
	});

	void test('Obsidian closing while it stops saves it paused, so a reload keeps it paused', async () => {
		const { service, savedNow, release, id } = await runningOne();
		service.pauseJobs([id]);
		service.dispose();
		release();
		assert.equal(savedNow()?.jobs.find((j) => j.id === id)?.state, 'paused');
	});
});

void describe('cancelling', () => {
	void test('a running job ends cancelled once it has stopped, with one change then', async () => {
		const { service, changes, release, id } = await runningOne();
		const before = changes();
		service.cancelJobs([id]);
		assert.deepEqual(states(service), [['a.txt', 'running']]);
		assert.equal(changes(), before);
		release();
		await until(service, () => service.getSnapshot().jobs[0]?.state !== 'running');
		assert.deepEqual(states(service), [['a.txt', 'cancelled']]);
		assert.equal(changes() - before, 1);
	});
});

void describe('the queue pause and a job pause', () => {
	void test('pausing and resuming the queue leaves paused jobs paused', async () => {
		const pipeline = blockingPipeline();
		const a = job('a.txt', 'paused');
		const b = job('b.txt', 'pending');
		const { service } = await queue([a, b], { extra: pipeline.extra });
		service.pause();
		assert.deepEqual(states(service), [
			['a.txt', 'paused'],
			['b.txt', 'pending'],
		]);
		service.resume();
		assert.deepEqual(states(service), [
			['a.txt', 'paused'],
			['b.txt', 'running'],
		]);
		pipeline.release();
	});
});

void describe('run next', () => {
	void test('moves the chosen jobs to the front of the line in their order, resuming paused ones', async () => {
		const jobs = [job('a.pdf', 'pending'), job('b.pdf', 'pending'), job('c.pdf', 'paused'), job('d.pdf', 'pending'), job('e.pdf', 'done')];
		const [, , c, d] = jobs;
		const { service } = await queue(jobs);
		service.runNext([d!.id, c!.id]);
		assert.deepEqual(
			sortJobs(service.getSnapshot().jobs).map((j) => [j.sourcePath, j.state]),
			[
				['c.pdf', 'pending'],
				['d.pdf', 'pending'],
				['a.pdf', 'pending'],
				['b.pdf', 'pending'],
				['e.pdf', 'done'],
			],
		);
	});

	void test('goes after the running job, not ahead of it', async () => {
		const pipeline = blockingPipeline();
		const jobs = [job('r.txt', 'pending'), job('a.txt', 'pending'), job('b.txt', 'pending')];
		const { service } = await queue(jobs, { paused: false, extra: pipeline.extra });
		service.runNext([jobs[2]!.id]);
		const order = [
			['r.txt', 'running'],
			['b.txt', 'pending'],
			['a.txt', 'pending'],
		];
		assert.deepEqual(states(service), order);
		assert.deepEqual(
			sortJobs(service.getSnapshot().jobs).map((j) => [j.sourcePath, j.state]),
			order,
		);
		pipeline.release();
	});

	void test('the worker starts the chosen job first', async () => {
		const pipeline = blockingPipeline();
		const jobs = [job('a.txt', 'pending'), job('b.txt', 'pending'), job('c.txt', 'pending')];
		const { service } = await queue(jobs, { extra: pipeline.extra });
		service.runNext([jobs[2]!.id]);
		service.resume();
		assert.deepEqual(states(service), [
			['c.txt', 'running'],
			['a.txt', 'pending'],
			['b.txt', 'pending'],
		]);
		pipeline.release();
	});

	void test('choosing every waiting job keeps their order', async () => {
		const jobs = [job('a.pdf', 'pending'), job('d.pdf', 'done'), job('b.pdf', 'paused')];
		const { service } = await queue(jobs);
		service.runNext([jobs[2]!.id, jobs[0]!.id]);
		assert.deepEqual(
			sortJobs(service.getSnapshot().jobs).map((j) => [j.sourcePath, j.state]),
			[
				['a.pdf', 'pending'],
				['b.pdf', 'pending'],
				['d.pdf', 'done'],
			],
		);
	});

	void test('leaves finished jobs where they are', async () => {
		const jobs = [job('a.pdf', 'pending'), job('b.pdf', 'failed')];
		const { service, changes } = await queue(jobs);
		service.runNext([jobs[1]!.id]);
		assert.deepEqual(states(service), [
			['a.pdf', 'pending'],
			['b.pdf', 'failed'],
		]);
		assert.equal(changes(), 0);
	});
});

void describe('acting on a selection', () => {
	void test('each bulk call saves and notifies once', async () => {
		const jobs = [job('a.pdf', 'pending'), job('b.pdf', 'pending'), job('c.pdf', 'failed'), job('d.pdf', 'cancelled'), job('e.pdf', 'done')];
		const ids = jobs.map((j) => j.id);
		const { service, changes, saves } = await queue(jobs);
		const calls: [string, () => void][] = [
			['pause', () => service.pauseJobs(ids)],
			['resume', () => service.resumeJobs(ids)],
			['run next', () => service.runNext(ids.slice(1))],
			['retry', () => service.retryJobs(ids)],
			['remove', () => service.removeJobs(ids)],
		];
		for (const [name, call] of calls) {
			const [before, savedBefore] = [changes(), saves()];
			call();
			assert.equal(changes() - before, 1, `${name} notifies once`);
			assert.equal(saves() - savedBefore, 1, `${name} saves once`);
		}
		assert.deepEqual(states(service), []);
	});

	void test('only the jobs a call applies to change', async () => {
		const jobs = [job('a.pdf', 'pending'), job('b.pdf', 'failed'), job('c.pdf', 'done')];
		const ids = jobs.map((j) => j.id);
		const { service } = await queue(jobs);
		service.pauseJobs(ids);
		assert.deepEqual(states(service), [
			['a.pdf', 'paused'],
			['b.pdf', 'failed'],
			['c.pdf', 'done'],
		]);
		service.retryJobs(ids);
		assert.deepEqual(states(service), [
			['a.pdf', 'paused'],
			['b.pdf', 'pending'],
			['c.pdf', 'done'],
		]);
	});

	void test('retry passes over skips a retry would only repeat', async () => {
		const upToDate = { ...job('a.pdf', 'skipped'), skipReason: 'already-processed' as const };
		const disabled = { ...job('b.pdf', 'skipped'), skipReason: 'disabled' as const };
		const { service } = await queue([upToDate, disabled]);
		service.retryJobs([upToDate.id, disabled.id]);
		assert.deepEqual(states(service), [
			['a.pdf', 'skipped'],
			['b.pdf', 'pending'],
		]);
	});

	void test('a call that changes nothing does not notify', async () => {
		const jobs = [job('a.pdf', 'done')];
		const { service, changes, saves } = await queue(jobs);
		const doneId = jobs[0]!.id;
		service.pauseJobs([doneId, 'missing']);
		service.resumeJobs([doneId]);
		service.retryJobs([doneId]);
		service.runNext([doneId]);
		service.cancelJobs([doneId, 'missing']);
		service.removeJobs(['missing']);
		assert.equal(changes(), 0);
		assert.equal(saves(), 0);
	});
});
