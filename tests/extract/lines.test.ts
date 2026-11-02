import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LineReader } from '../../src/extract/docling/managed/lines';

void describe('LineReader', () => {
	void test('lines split across chunks, several in one chunk', () => {
		const r = new LineReader();
		assert.deepEqual(r.push('{"a":'), []);
		assert.deepEqual(r.push('1}\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
		assert.deepEqual(r.push(':3}\n'), ['{"c":3}']);
		assert.deepEqual(r.push('\n'), ['']);
	});

	void test('a carriage return stays with the line for the caller to trim', () => {
		assert.deepEqual(new LineReader().push('x\r\ny\n'), ['x\r', 'y']);
	});

	void test('reset drops a partial line', () => {
		const r = new LineReader();
		r.push('half a li');
		r.reset();
		assert.deepEqual(r.push('ne\n'), ['ne']);
	});

	void test('a 100 MB line in 64 KB chunks takes linear time', () => {
		const chunk = 'x'.repeat(64 * 1024);
		const r = new LineReader();
		const started = Date.now();
		for (let i = 0; i < 1600; i++) assert.deepEqual(r.push(chunk), []);
		const [line] = r.push('end\n');
		const ms = Date.now() - started;
		assert.equal(line?.length, 1600 * 64 * 1024 + 3);
		// Appending to one string and searching it from the start each time took minutes here
		assert.ok(ms < 3000, `took ${ms} ms`);
	});
});
