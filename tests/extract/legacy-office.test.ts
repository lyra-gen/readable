import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { describeLegacySupport, findLibreOffice, isLegacyOffice, isLegacyWord, isSnap, legacyRoute, libreOfficeCandidates, missingMessage } from '../../src/extract/docling/managed/legacy-office';

void test('old binary Office files are recognised; their modern and HTML look-alikes are not', () => {
	for (const name of ['report.doc', 'letter.DOT', 'Budget.XLS', 'template.xlt', 'slides.ppt', 'theme.pot', 'show.pps']) {
		assert.ok(isLegacyOffice('application/x-cfb', `docs/${name}`), name);
	}
	assert.ok(isLegacyOffice('application/msword', 'docs/report'));
	assert.ok(!isLegacyOffice('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docs/report.docx'));
	// A .doc that is really a web page is read as HTML
	assert.ok(!isLegacyOffice('text/html', 'docs/report.doc'));
	// Outlook messages share the container format but are not Office documents
	assert.ok(!isLegacyOffice('application/x-cfb', 'mail/message.msg'));
});

void test('only Word files can go through textutil', () => {
	assert.ok(isLegacyWord('application/x-cfb', 'a.doc'));
	assert.ok(isLegacyWord('application/x-cfb', 'a.dot'));
	assert.ok(isLegacyWord('application/msword', 'a'));
	assert.ok(!isLegacyWord('application/x-cfb', 'a.xls'));
	assert.ok(!isLegacyWord('application/x-cfb', 'a.ppt'));
});

void test('LibreOffice is looked for where each system installs it', () => {
	assert.ok(libreOfficeCandidates('darwin', {}, '/Users/u').includes('/Applications/LibreOffice.app/Contents/MacOS/soffice'));
	assert.ok(libreOfficeCandidates('darwin', {}, '/Users/u').includes('/Users/u/Applications/LibreOffice.app/Contents/MacOS/soffice'));
	const win = libreOfficeCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' }, 'C:\\Users\\u');
	assert.deepEqual(win, ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']);
	assert.ok(libreOfficeCandidates('linux', {}, '/home/u').includes('/usr/bin/soffice'));
});

void test('a snap LibreOffice is passed over', async () => {
	assert.ok(await isSnap('/snap/bin/libreoffice', 'linux'));
	assert.ok(!(await isSnap('/usr/bin/soffice', 'darwin')));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readable-snap-'));
	try {
		const link = path.join(dir, 'libreoffice');
		await fs.symlink('/usr/bin/snap', link);
		assert.ok(await isSnap(link, 'linux'));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

void test('a soffice on PATH is found', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readable-lo-'));
	try {
		const soffice = path.join(dir, 'soffice');
		await fs.writeFile(soffice, '#!/bin/sh\n');
		await fs.chmod(soffice, 0o755);
		// linux, so none of this Mac's real install paths can win; /usr/bin/soffice must not exist for this to be exact
		const found = await findLibreOffice('linux', { PATH: dir });
		if (!(await fs.stat('/usr/bin/soffice').catch(() => null))) assert.equal(found, soffice);
		// Not executable: skipped
		await fs.chmod(soffice, 0o644);
		const again = await findLibreOffice('linux', { PATH: dir });
		assert.notEqual(again, soffice);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

void test('without LibreOffice a Mac reads .doc with textutil and explains .xls/.ppt', async () => {
	const libreOffice = await findLibreOffice();
	if (libreOffice || process.platform !== 'darwin') return; // the route depends on this machine
	assert.deepEqual(await legacyRoute('application/x-cfb', 'a.doc'), { via: 'textutil' });
	const xls = await legacyRoute('application/x-cfb', 'a.xls');
	assert.equal(xls.via, 'none');
});

void test('messages and settings text name what to install', () => {
	assert.match(missingMessage('darwin'), /\.xls, \.ppt/);
	assert.doesNotMatch(missingMessage('darwin'), /\.doc\b/);
	assert.match(missingMessage('win32'), /\.doc, \.xls, \.ppt/);
	assert.match(missingMessage('linux'), /not the snap/);
	assert.doesNotMatch(missingMessage('win32'), /snap/);
	assert.equal(describeLegacySupport('/x/soffice', 'linux'), 'Read with LibreOffice.');
	assert.match(describeLegacySupport(null, 'darwin'), /macOS/);
	assert.match(describeLegacySupport(null, 'win32'), /need LibreOffice/);
});
