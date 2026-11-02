import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { frontmatterLines, parseFrontmatterKeys, splitFrontmatter, yamlScalar } from '../../src/notes/frontmatter';
import { isOwnedNote, mergeNote, END, START } from '../../src/notes/owned';

void describe('frontmatter values', () => {
	void test('plain text stays bare, structural characters are quoted', () => {
		assert.equal(yamlScalar('Quarterly report'), 'Quarterly report');
		assert.equal(yamlScalar('Report: Q3'), '"Report: Q3"');
	});

	void test('a newline cannot end the frontmatter early', () => {
		const title = 'Invoice\n---\nsecret: true';
		assert.equal(yamlScalar(title), '"Invoice\\n---\\nsecret: true"');
		const lines = frontmatterLines({ title, aliases: [title], source: 'a.pdf', hash: 'sha256:ab' });
		const note = `---\n${lines.join('\n')}\n---\n\nbody`;
		assert.equal(splitFrontmatter(note).frontmatter?.split('\n').length, 4);
		assert.deepEqual(parseFrontmatterKeys(note), { source: 'a.pdf', hash: 'sha256:ab' });
	});

	void test('other control characters are escaped too', () => {
		assert.equal(yamlScalar('a\tb\r\u0000'), '"a\\tb\\r\\x00"');
	});
});

void describe('rewriting a note', () => {
	const rendered = { frontmatterLines: ['source: a.pdf', 'hash: sha256:ab'], body: 'new' };

	void test('replaces only the owned region', () => {
		const current = `---\nsource: a.pdf\nmine: yes\n---\nabove\n${START}\nold\n${END}\nbelow\n`;
		assert.equal(mergeNote(current, rendered), `---\nsource: a.pdf\nhash: sha256:ab\nmine: yes\n---\nabove\n${START}\nnew\n${END}\nbelow\n`);
		assert.equal(isOwnedNote(current), true);
	});

	void test('refuses a note without the markers, so someone else’s text is never replaced', () => {
		const theirs = '---\nsource: a.pdf\nhash: sha256:ab\n---\nTheir own notes about the file.\n';
		assert.equal(mergeNote(theirs, rendered), null);
		assert.equal(isOwnedNote(theirs), false);
	});
});
