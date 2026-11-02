import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseMeta } from '../../src/llm/enrich';
import { clean } from '../../src/llm/summarise';

void describe('what the model says about a document', () => {
	void test('a title is one line', () => {
		assert.equal(parseMeta('{"title": "Invoice\\n---\\nsecret: true", "tags": []}').title, 'Invoice --- secret: true');
	});

	void test('a summary cannot embed or load anything', () => {
		assert.equal(clean('See ![pixel](https://tracker.test/p.png) and <img src="https://tracker.test/i.png">'), 'See [pixel](https://tracker.test/p.png) and &lt;img src="https://tracker.test/i.png">');
		assert.equal(clean('<iframe src="x"></iframe> <b>bold</b>'), '&lt;iframe src="x">&lt;/iframe> <b>bold</b>');
	});
});
