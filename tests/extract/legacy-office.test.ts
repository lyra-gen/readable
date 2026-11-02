import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLegacyOffice } from '../../src/extract/docling/managed/extractor';

void test('old binary Office files are recognised; their modern and HTML look-alikes are not', () => {
	assert.ok(isLegacyOffice('application/x-cfb', 'docs/report.doc'));
	assert.ok(isLegacyOffice('application/x-cfb', 'docs/Budget.XLS'));
	assert.ok(isLegacyOffice('application/x-cfb', 'docs/slides.ppt'));
	assert.ok(isLegacyOffice('application/msword', 'docs/report'));
	assert.ok(!isLegacyOffice('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docs/report.docx'));
	// A .doc that is really a web page is read as HTML
	assert.ok(!isLegacyOffice('text/html', 'docs/report.doc'));
	// Outlook messages share the container format but are not Office documents
	assert.ok(!isLegacyOffice('application/x-cfb', 'mail/message.msg'));
});
