import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { figureDir, isFigureOf } from '../../src/notes/figures';

void describe('where a document\'s figures go', () => {
	void test('next to the note, grouped in a <document>-figures folder', () => {
		assert.equal(figureDir('docs/pdf/en', 'quarterly-report', true), 'docs/pdf/en/quarterly-report-figures');
	});

	void test('next to the note, flat', () => {
		assert.equal(figureDir('docs/pdf/en', 'quarterly-report', false), 'docs/pdf/en');
	});

	void test('a note in the vault root', () => {
		assert.equal(figureDir('', 'report', true), 'report-figures');
		assert.equal(figureDir('', 'report', false), '/');
	});

	void test('the folder earlier versions used, named just like the document', () => {
		assert.equal(figureDir('docs/pdf/en', 'report', true, ''), 'docs/pdf/en/report');
		assert.equal(figureDir('docs/pdf/en', 'report', false, ''), 'docs/pdf/en');
	});
});

void describe('which files are a document\'s figures', () => {
	void test('<document>-figure-<n> with any extension', () => {
		assert.equal(isFigureOf('report', 'report-figure-1.png'), true);
		assert.equal(isFigureOf('report', 'report-figure-12.jpeg'), true);
	});

	void test('not other files in the folder', () => {
		assert.equal(isFigureOf('report', 'report-figure-cover.png'), false);
		assert.equal(isFigureOf('report', 'notes.md'), false);
		assert.equal(isFigureOf('report', 'report-2-figure-1.png'), false);
	});
});
