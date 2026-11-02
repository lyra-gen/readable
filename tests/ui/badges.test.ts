import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { latestJobs, markFor } from '../../src/ui/badges';
import type { Job, JobState } from '../../src/core/types';

let created = 0;
function job(state: JobState, extra: Partial<Job> = {}): Job {
	return { id: `j${++created}`, sourcePath: 'docs/a.pdf', state, createdAt: created, attempts: 1, trigger: 'auto-ingest', ...extra };
}

void describe('explorer marks', () => {
	void test('each queue state has its own mark', () => {
		assert.equal(markFor(job('pending'), false)?.icon, 'clock');
		assert.equal(markFor(job('running'), false)?.icon, 'loader');
		assert.equal(markFor(job('paused'), false)?.icon, 'pause');
		assert.equal(markFor(job('cancelled'), false)?.icon, 'circle-slash');
		assert.equal(markFor(job('excluded'), true)?.icon, 'circle-off', "Don't process wins over an old tick");
	});

	void test('a failure is red and says why', () => {
		const mark = markFor(job('failed', { error: 'Docling made no progress for 600 s' }), false);
		assert.deepEqual(mark, { icon: 'x', label: 'Failed: Docling made no progress for 600 s', cls: 'is-failed' });
	});

	void test('a tick comes from the note, or a finished job', () => {
		assert.equal(markFor(undefined, true)?.icon, 'check');
		assert.equal(markFor(job('done'), false)?.icon, 'check');
		assert.equal(markFor(undefined, false), null);
	});

	void test('the queue wins over an old tick while it says something the note cannot', () => {
		// Changed after ingesting, and the re-run failed
		assert.equal(markFor(job('failed'), true)?.icon, 'x');
		assert.equal(markFor(job('running'), true)?.icon, 'loader');
	});

	void test('skips explain themselves; a skip because a note exists is just a tick', () => {
		assert.equal(markFor(job('skipped', { skipReason: 'unsupported-type' }), false)?.label, 'Skipped: not a file Readable reads');
		assert.equal(markFor(job('skipped', { skipReason: 'already-processed' }), true)?.icon, 'check');
		assert.equal(markFor(job('skipped', { skipReason: 'already-processed' }), false), null);
	});

	void test('the newest job per file counts', () => {
		const old = job('failed');
		const fresh = job('pending');
		const other = job('done', { sourcePath: 'docs/b.pdf' });
		const latest = latestJobs([fresh, old, other]);
		assert.equal(latest.get('docs/a.pdf'), fresh);
		assert.equal(latest.get('docs/b.pdf'), other);
	});
});
