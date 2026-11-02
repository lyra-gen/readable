import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summaryStep } from '../../src/pipeline/run-job';

void describe('summarising steps', () => {
	void test('a short text is one call', () => {
		assert.equal(summaryStep(0, 1), 'summary');
		assert.equal(summaryStep(1, 1), 'summary');
	});

	void test('a long text: each part, then the combining call', () => {
		// summarise() reports (i, parts + 1) before part i, then (parts, parts + 1) before combining
		assert.equal(summaryStep(0, 8), 'part 1 of 7');
		assert.equal(summaryStep(6, 8), 'part 7 of 7');
		assert.equal(summaryStep(7, 8), 'combining parts');
	});
});
