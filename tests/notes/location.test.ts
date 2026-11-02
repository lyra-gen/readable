import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNotePath } from '../../src/notes/location';
import { safeFileName, stemOf } from '../../src/notes/vault-paths';

const settings = { noteLocation: 'folder' as const, outputFolder: 'Readable', subfolderName: '_readable' };

void test('note names drop characters Obsidian cannot write', () => {
	// macOS stores a Finder "/" as ":" and allows backslashes; Obsidian refuses both in a new file
	assert.equal(resolveNotePath('Inbox/Invoice 2024:05.pdf', settings), 'Readable/Invoice 2024-05.md');
	assert.equal(resolveNotePath('Inbox/Q3\\report.pdf', settings), 'Readable/Q3-report.md');
	assert.equal(resolveNotePath('Inbox/What? "Why".pdf', settings), 'Readable/What- -Why-.md');
});

void test('ordinary names are untouched', () => {
	assert.equal(stemOf('Inbox/Report (final).v2.pdf'), 'Report (final).v2');
	assert.equal(resolveNotePath('Inbox/Report.pdf', { ...settings, noteLocation: 'beside' }), 'Inbox/Report.md');
	assert.equal(resolveNotePath('Inbox/Report.pdf', { ...settings, noteLocation: 'subfolder' }), 'Inbox/_readable/Report.md');
});

void test('a name made only of unsafe characters still gets a note', () => {
	assert.equal(safeFileName(':::'), '-');
	assert.equal(safeFileName('   '), 'untitled');
});
