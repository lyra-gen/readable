/**
 * A PDF interrupted partway resumes from its last finished page chunk instead
 * of page 1, and the note's text is the same as from an uninterrupted run.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import type { ManagedDocling } from '../../src/extract/docling/managed/manager';
import { extract, managedDocling } from '../support/extraction';

const FILE = 'pdf-long-en.pdf';
const checkpoints = (docling: ManagedDocling) => {
	try {
		return readdirSync(docling.paths.checkpoints);
	} catch {
		return [];
	}
};

void describe('resuming a PDF', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;

	before(async () => {
		({ docling, skip } = await managedDocling());
	});
	after(() => docling?.dispose());

	void test('picks up after the pages already read', { timeout: 10 * 60_000 }, async (t) => {
		if (skip) return t.skip(skip);
		const whole = await extract(docling, FILE);
		assert.equal(whole.result.status, 'extracted', whole.log.join('\n'));
		// Six copies of a two-page report, one heading each
		assert.equal(whole.markdown.match(/Quarterly report/g)?.length, 6, whole.markdown);

		const before = checkpoints(docling);
		const resumeKey = `resume-test-${Date.now()}`;
		const stop = new AbortController();
		await assert.rejects(
			// Stopped as reading starts: the cancel lands during the first chunk of ten, so the last two pages are left
			extract(docling, FILE, { resumeKey, signal: stop.signal, onPages: () => stop.abort() }),
			(error: Error) => error.name === 'AbortError',
		);
		assert.equal(checkpoints(docling).length, before.length + 1, 'the interrupted run left a checkpoint');

		const resumed = await extract(docling, FILE, { resumeKey });
		assert.equal(resumed.result.status, 'extracted', resumed.log.join('\n'));
		assert.ok(resumed.log.some((l) => /^info: Resuming: 10 of 12 pages read before$/.test(l)), resumed.log.join('\n'));
		assert.equal(resumed.markdown, whole.markdown);
		assert.deepEqual(checkpoints(docling), before, 'the checkpoint is removed once the text is used');
	});
});
