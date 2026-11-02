/**
 * A recording sent while PDFs are being read starts at once on the sidecar's
 * media lane instead of waiting for them. Needs the managed install and
 * the speech add-on on this machine.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ManagedDocling } from '../../src/extract/docling/managed/manager';
import { extract, managedDocling } from '../support/extraction';
import type { Extracted } from '../support/extraction';

void describe('recordings beside documents', () => {
	let docling: ManagedDocling;
	let skip: string | false = false;

	before(async () => {
		({ docling, skipSpeech: skip } = await managedDocling());
	});
	after(() => docling?.dispose());

	void test('a recording does not wait for the PDFs being read', { timeout: 10 * 60_000 }, async (t) => {
		if (skip) return t.skip(skip);
		const finished: string[] = [];
		const run = (file: string) =>
			extract(docling, file).then((out) => {
				finished.push(file);
				return out;
			});
		// Once the first PDF's pages are being read, a second PDF queues behind it on the document lane, and a recording is sent
		let others: Promise<Extracted[]> | null = null;
		const long = await extract(docling, 'pdf-long-en.pdf', {
			onPages: () => {
				others ??= Promise.all([run('pdf-scan-en.pdf'), run('audio-en.mp3')]);
			},
		});
		assert.ok(others, 'the PDF reported pages');
		const [scan, audio] = await (others as Promise<Extracted[]>);
		for (const out of [long, scan, audio]) assert.equal(out?.result.status, 'extracted', out?.log.join('\n'));
		assert.ok(!audio?.log.some((l) => /^info: Waited \d+ s for Docling$/.test(l)), audio?.log.join('\n'));
		// One lane would have read both PDFs before the recording
		assert.deepEqual(finished, ['audio-en.mp3', 'pdf-scan-en.pdf']);
	});
});
