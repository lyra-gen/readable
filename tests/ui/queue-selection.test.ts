import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Job } from '../../src/core/types';
import {
	applyFilter,
	EMPTY_FILTER,
	isFiltering,
	KIND_FILTERS,
	matchesFilter,
	folderCount,
	normalizeFilter,
	type QueueFilter,
	rowAfterRemoval,
	rowMenuItems,
	Selection,
	STATE_FILTERS,
	stateLabel,
} from '../../src/ui/queue-selection';
import { queueCounts } from '../../src/ui/format';

const ROWS = ['a', 'b', 'c', 'd', 'e'];
const plain = { range: false, toggle: false };
const toggle = { range: false, toggle: true };
const range = { range: true, toggle: false };

function selected(sel: Selection, visible = ROWS): string[] {
	return sel.ids(visible);
}

void describe('queue selection: clicks', () => {
	void test('a plain click selects only that row and sets anchor and focus', () => {
		const sel = new Selection();
		sel.click('b', ROWS, plain);
		sel.click('d', ROWS, plain);
		assert.deepEqual(selected(sel), ['d']);
		assert.equal(sel.anchor, 'd');
		assert.equal(sel.focus, 'd');
		assert.equal(sel.size, 1);
	});

	void test('toggle adds and removes rows, moving the anchor each time', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, toggle);
		assert.deepEqual(selected(sel), ['a', 'c']);
		assert.equal(sel.anchor, 'c');
		sel.click('a', ROWS, toggle);
		assert.deepEqual(selected(sel), ['c']);
		assert.equal(sel.anchor, 'a');
		assert.equal(sel.focus, 'a');
	});

	void test('toggling the anchor off keeps it as the anchor for the next range', () => {
		const sel = new Selection();
		sel.click('b', ROWS, plain);
		sel.click('b', ROWS, toggle);
		assert.equal(sel.size, 0);
		assert.equal(sel.anchor, 'b');
		sel.click('d', ROWS, range);
		assert.deepEqual(selected(sel), ['b', 'c', 'd']);
	});

	void test('a range runs downwards from the anchor', () => {
		const sel = new Selection();
		sel.click('b', ROWS, plain);
		sel.click('d', ROWS, range);
		assert.deepEqual(selected(sel), ['b', 'c', 'd']);
		assert.equal(sel.anchor, 'b');
		assert.equal(sel.focus, 'd');
	});

	void test('a range runs upwards from the anchor', () => {
		const sel = new Selection();
		sel.click('d', ROWS, plain);
		sel.click('a', ROWS, range);
		assert.deepEqual(selected(sel), ['a', 'b', 'c', 'd']);
		assert.equal(sel.anchor, 'd');
		assert.equal(sel.focus, 'a');
	});

	void test('a second range replaces the first and keeps the anchor', () => {
		const sel = new Selection();
		sel.click('c', ROWS, plain);
		sel.click('e', ROWS, range);
		sel.click('b', ROWS, range);
		assert.deepEqual(selected(sel), ['b', 'c']);
		assert.equal(sel.anchor, 'c');
	});

	void test('a range replaces rows toggled in before it', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('e', ROWS, toggle);
		sel.click('c', ROWS, range);
		assert.deepEqual(selected(sel), ['c', 'd', 'e']);
	});

	void test('range with toggle adds the range to the selection', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, toggle);
		sel.click('e', ROWS, { range: true, toggle: true });
		assert.deepEqual(selected(sel), ['a', 'c', 'd', 'e']);
	});

	void test('a range with no anchor acts as a plain click', () => {
		const sel = new Selection();
		sel.click('c', ROWS, range);
		assert.deepEqual(selected(sel), ['c']);
		assert.equal(sel.anchor, 'c');
	});

	void test('a range whose anchor is hidden acts as a plain click', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		const visible = ['b', 'c', 'd'];
		sel.click('d', visible, range);
		assert.deepEqual(selected(sel, visible), ['d']);
		assert.equal(sel.anchor, 'd');
	});

	void test('the range follows display order, not click order', () => {
		const sel = new Selection();
		const order = ['e', 'a', 'd', 'b', 'c'];
		sel.click('a', order, plain);
		sel.click('b', order, range);
		assert.deepEqual(sel.ids(order), ['a', 'd', 'b']);
	});
});

void describe('queue selection: keyboard', () => {
	void test('with no focus, Down picks the first row and Up the last', () => {
		const down = new Selection();
		assert.equal(down.move(1, ROWS, false), 'a');
		assert.deepEqual(selected(down), ['a']);
		const up = new Selection();
		assert.equal(up.move(-1, ROWS, false), 'e');
		assert.deepEqual(selected(up), ['e']);
	});

	void test('moving selects the new focus row only and makes it the anchor', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, toggle);
		sel.move(1, ROWS, false);
		assert.deepEqual(selected(sel), ['d']);
		assert.equal(sel.anchor, 'd');
		assert.equal(sel.focus, 'd');
	});

	void test('moving stops at both ends', () => {
		const sel = new Selection();
		sel.click('e', ROWS, plain);
		assert.equal(sel.move(1, ROWS, false), 'e');
		sel.click('a', ROWS, plain);
		assert.equal(sel.move(-1, ROWS, false), 'a');
		assert.deepEqual(selected(sel), ['a']);
	});

	void test('extending selects anchor to focus and can shrink back past the anchor', () => {
		const sel = new Selection();
		sel.click('c', ROWS, plain);
		sel.move(1, ROWS, true);
		sel.move(1, ROWS, true);
		assert.deepEqual(selected(sel), ['c', 'd', 'e']);
		assert.equal(sel.move(1, ROWS, true), 'e');
		assert.deepEqual(selected(sel), ['c', 'd', 'e']);
		sel.move(-3, ROWS, true);
		assert.deepEqual(selected(sel), ['b', 'c']);
		assert.equal(sel.anchor, 'c');
		assert.equal(sel.focus, 'b');
	});

	void test('extending at the top keeps the range', () => {
		const sel = new Selection();
		sel.click('b', ROWS, plain);
		sel.move(-1, ROWS, true);
		assert.equal(sel.move(-1, ROWS, true), 'a');
		assert.deepEqual(selected(sel), ['a', 'b']);
	});

	void test('extending with no focus starts a range at the picked row', () => {
		const sel = new Selection();
		sel.move(-1, ROWS, true);
		assert.deepEqual(selected(sel), ['e']);
		sel.move(-1, ROWS, true);
		assert.deepEqual(selected(sel), ['d', 'e']);
		assert.equal(sel.anchor, 'e');
	});

	void test('moving through an empty list does nothing', () => {
		const sel = new Selection();
		assert.equal(sel.move(1, [], false), null);
		assert.equal(sel.size, 0);
	});

	void test('select all covers the visible rows only', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.selectAll(['b', 'c']);
		assert.deepEqual(selected(sel), ['b', 'c']);
		assert.equal(sel.anchor, 'b');
	});

	void test('clear empties the selection, anchor and focus', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, range);
		sel.clear();
		assert.equal(sel.size, 0);
		assert.equal(sel.anchor, null);
		assert.equal(sel.focus, null);
	});
});

void describe('queue selection: filtering and right-click', () => {
	void test('retain drops hidden rows and an anchor or focus that went with them', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('d', ROWS, range);
		sel.retain(['b', 'c', 'e']);
		assert.equal(sel.size, 2);
		assert.deepEqual(selected(sel), ['b', 'c']);
		assert.equal(sel.anchor, null);
		assert.equal(sel.focus, null);
		assert.equal(sel.has('a'), false);
	});

	void test('retain keeps an anchor and focus that are still shown', () => {
		const sel = new Selection();
		sel.click('b', ROWS, plain);
		sel.click('d', ROWS, range);
		sel.retain(['b', 'd']);
		assert.deepEqual(selected(sel), ['b', 'd']);
		assert.equal(sel.anchor, 'b');
		assert.equal(sel.focus, 'd');
	});

	void test('right-click on a selected row acts on the whole selection', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, range);
		assert.deepEqual(sel.contextTarget('b', ROWS), ['a', 'b', 'c']);
		assert.equal(sel.size, 3);
	});

	void test('right-click on another row makes it the selection', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, range);
		assert.deepEqual(sel.contextTarget('e'), ['e']);
		assert.deepEqual(selected(sel), ['e']);
		assert.equal(sel.anchor, 'e');
		assert.equal(sel.focus, 'e');
	});
});

let n = 0;
function job(sourcePath: string, state: string): Job {
	return { id: `j${++n}`, sourcePath, state: state as Job['state'], createdAt: n, attempts: 0, trigger: 'manual' };
}

const JOBS = [
	job('Inbox/Report 2024.pdf', 'running'),
	job('Inbox/photo.JPG', 'pending'),
	job('Meetings/standup.m4a', 'paused'),
	job('Meetings/notes.txt', 'done'),
	job('Video/demo.mov', 'failed'),
	job('Inbox/README', 'skipped'),
	job('Inbox/archive.zzz', 'cancelled'),
];
const names = (jobs: readonly Job[]) => jobs.map((j) => j.sourcePath.split('/').pop());
const filter = (f: Partial<QueueFilter>): QueueFilter => ({ ...EMPTY_FILTER, ...f });

void describe('queue filters', () => {
	void test('the empty filter shows everything', () => {
		assert.equal(isFiltering(EMPTY_FILTER), false);
		assert.equal(isFiltering(filter({ text: '   ' })), false);
		assert.equal(applyFilter(JOBS, EMPTY_FILTER).length, JOBS.length);
	});

	void test('states are OR-ed, including paused', () => {
		const f = filter({ states: ['paused', 'done'] });
		assert.equal(isFiltering(f), true);
		assert.deepEqual(names(applyFilter(JOBS, f)), ['standup.m4a', 'notes.txt']);
	});

	void test('kinds come from the extension, any case', () => {
		assert.deepEqual(names(applyFilter(JOBS, filter({ kinds: ['image', 'video'] }))), ['photo.JPG', 'demo.mov']);
		assert.deepEqual(names(applyFilter(JOBS, filter({ kinds: ['document'] }))), ['Report 2024.pdf']);
	});

	void test('a file with no known extension matches only when no kind is chosen', () => {
		const readme = JOBS[5] as Job;
		const unknown = JOBS[6] as Job;
		for (const kind of KIND_FILTERS) {
			assert.equal(matchesFilter(readme, filter({ kinds: [kind.value] })), false);
			assert.equal(matchesFilter(unknown, filter({ kinds: [kind.value] })), false);
		}
		assert.equal(matchesFilter(readme, EMPTY_FILTER), true);
	});

	void test('a dot in a folder name is not an extension', () => {
		assert.equal(matchesFilter(job('v1.pdf/README', 'done'), filter({ kinds: ['document'] })), false);
	});

	void test('text matches part of the file name, any case, trimmed', () => {
		assert.deepEqual(names(applyFilter(JOBS, filter({ text: '  REPORT ' }))), ['Report 2024.pdf']);
		// Folder names are not searched
		assert.deepEqual(names(applyFilter(JOBS, filter({ text: 'inbox' }))), []);
	});

	void test('groups are AND-ed', () => {
		const f = filter({ states: ['running', 'pending', 'done'], kinds: ['image', 'text'], text: 'o' });
		assert.deepEqual(names(applyFilter(JOBS, f)), ['photo.JPG', 'notes.txt']);
		assert.deepEqual(names(applyFilter(JOBS, { ...f, text: 'photo' })), ['photo.JPG']);
		assert.deepEqual(names(applyFilter(JOBS, { ...f, states: ['failed'] })), []);
	});

	void test('every state and kind has a label', () => {
		assert.deepEqual(
			STATE_FILTERS.map((s) => s.value),
			['running', 'pending', 'paused', 'done', 'failed', 'cancelled', 'skipped', 'excluded'],
		);
		assert.equal(STATE_FILTERS.find((s) => s.value === 'pending')?.label, 'Waiting');
		assert.deepEqual(
			KIND_FILTERS.map((k) => k.label),
			['Documents', 'Pictures', 'Recordings', 'Videos', 'Text'],
		);
	});
});

void describe('saved filter state', () => {
	void test('a saved filter reads back as it was', () => {
		const f: QueueFilter = { states: ['paused', 'failed'], kinds: ['audio'], text: 'standup' };
		assert.deepEqual(normalizeFilter(JSON.parse(JSON.stringify(f))), f);
	});

	void test('junk reads back as the empty filter', () => {
		for (const junk of [undefined, null, 42, 'running', [], true]) {
			assert.deepEqual(normalizeFilter(junk), EMPTY_FILTER);
		}
		assert.deepEqual(normalizeFilter({ states: 'running', kinds: { a: 1 }, text: 7 }), EMPTY_FILTER);
	});

	void test('unknown and repeated values are dropped', () => {
		assert.deepEqual(normalizeFilter({ states: ['running', 'exploded', 3, 'running', null], kinds: ['image', 'pdf', 'image'], text: 'x', extra: 1 }), {
			states: ['running'],
			kinds: ['image'],
			text: 'x',
		});
	});

	void test('the view state round-trips a filter, text with spaces and all', () => {
		const f: QueueFilter = { states: ['pending'], kinds: ['document', 'text'], text: '  annual report ' };
		const saved = JSON.parse(JSON.stringify({ filter: f })) as { filter: unknown };
		assert.deepEqual(normalizeFilter(saved.filter), f);
	});

	void test('the result never shares arrays with the empty filter', () => {
		const f = normalizeFilter(null);
		f.states.push('done');
		assert.deepEqual(EMPTY_FILTER.states, []);
	});
});

void describe('queue selection: hidden rows', () => {
	void test('a hidden focus row moves to the first row down, the last up', () => {
		const sel = new Selection();
		sel.click('c', ROWS, plain);
		assert.equal(sel.move(1, ['a', 'b', 'd'], false), 'a');
		sel.click('c', ROWS, plain);
		assert.equal(sel.move(-1, ['a', 'b', 'd'], false), 'd');
	});

	void test('extending from a hidden anchor starts the range at the focus row', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('c', ROWS, range);
		sel.move(1, ['b', 'c', 'd'], true);
		assert.equal(sel.anchor, 'c');
		assert.deepEqual(selected(sel, ['b', 'c', 'd']), ['c', 'd']);
	});

	void test('extending when anchor and focus are both hidden starts at the picked row', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.move(1, ['b', 'c'], true);
		assert.equal(sel.anchor, 'b');
		assert.deepEqual(selected(sel, ['b', 'c']), ['b']);
	});

	void test('select all with nothing shown selects nothing and keeps anchor and focus', () => {
		const sel = new Selection();
		sel.click('c', ROWS, plain);
		sel.selectAll([]);
		assert.equal(sel.size, 0);
		assert.equal(sel.anchor, 'c');
		assert.equal(sel.focus, 'c');
	});

	void test('select all keeps a focus row that is shown', () => {
		const sel = new Selection();
		sel.click('c', ROWS, plain);
		sel.selectAll(ROWS);
		assert.equal(sel.size, ROWS.length);
		assert.equal(sel.focus, 'c');
		assert.equal(sel.anchor, 'c');
	});

	void test('right-click after a filter acts on the shown rows only', () => {
		const sel = new Selection();
		sel.click('a', ROWS, plain);
		sel.click('d', ROWS, range);
		const shown = ['b', 'c', 'e'];
		sel.retain(shown);
		assert.deepEqual(sel.contextTarget('b', shown), ['b', 'c']);
	});

	void test('Enter opens the focus row, else the first selected shown row', () => {
		const sel = new Selection();
		sel.click('b', ROWS, plain);
		sel.click('d', ROWS, toggle);
		assert.equal(sel.primary(ROWS), 'd');
		sel.retain(['a', 'b', 'c']);
		assert.equal(sel.primary(['a', 'b', 'c']), 'b');
		sel.clear();
		assert.equal(sel.primary(ROWS), null);
	});
});

void describe('queue selection: after a removal', () => {
	void test('the row below the removed ones takes their place', () => {
		assert.equal(rowAfterRemoval(ROWS, ['b', 'c']), 'd');
		assert.equal(rowAfterRemoval(ROWS, ['b', 'd']), 'e');
	});

	void test('removing the last rows goes to the one above', () => {
		assert.equal(rowAfterRemoval(ROWS, ['d', 'e']), 'c');
	});

	void test('nothing is left, or nothing shown was removed', () => {
		assert.equal(rowAfterRemoval(ROWS, ROWS), null);
		assert.equal(rowAfterRemoval(ROWS, ['x']), null);
	});
});

void describe('row text', () => {
	void test('tags use the filter menu words', () => {
		assert.equal(stateLabel(job('a.pdf', 'pending')), 'waiting');
		assert.equal(stateLabel(job('a.pdf', 'paused')), 'paused');
		assert.equal(stateLabel(job('a.pdf', 'running')), 'running');
		assert.equal(stateLabel(job('a.pdf', 'running'), true), 'pausing');
		assert.equal(stateLabel({ ...job('a.pdf', 'skipped'), skipReason: 'already-processed' }), 'up to date');
	});

	void test('the folder counts paused jobs as not finished', () => {
		const jobs = [job('a', 'done'), job('b', 'failed'), job('c', 'paused'), job('d', 'pending'), job('e', 'running')];
		assert.equal(folderCount(jobs, 5, false), '2/5');
		assert.deepEqual(queueCounts(jobs), { queued: 2, paused: 1, finished: 2, total: 5 });
	});

	void test('while filtering the folder says how many are shown', () => {
		const jobs = [job('a', 'done'), job('b', 'failed'), job('c', 'paused')];
		assert.equal(folderCount(jobs, 1, true), '1 of 3');
	});
});

void describe('row menu', () => {
	const notPausing = () => false;
	const menu = (jobs: Job[], pausing: (id: string) => boolean = notPausing) =>
		rowMenuItems(jobs, pausing).map((group) => group.map((item) => item.label));

	void test('a mixed selection counts only the jobs each action applies to', () => {
		const jobs = [job('r', 'running'), job('p', 'pending'), job('z', 'paused'), job('f', 'failed'), job('d', 'done')];
		assert.deepEqual(menu(jobs), [['Pause 2 files', 'Resume', 'Run 2 files next', 'Retry', 'Cancel', "Don't process 5 files"], ['Remove 5 files from queue']]);
		const items = rowMenuItems(jobs, notPausing).flat();
		assert.deepEqual(items.find((i) => i.action === 'pause')?.ids, [jobs[0]!.id, jobs[1]!.id]);
		assert.deepEqual(items.find((i) => i.action === 'remove')?.ids, jobs.map((j) => j.id));
	});

	void test('one done job opens its note and its log first', () => {
		assert.deepEqual(menu([job('d', 'done')]), [['Open note', 'View log'], ["Don't process"], ['Remove from queue']]);
	});

	void test('one running job can be paused, cancelled or removed', () => {
		assert.deepEqual(menu([job('r', 'running')]), [['View log'], ['Pause', 'Cancel', "Don't process"], ['Remove from queue']]);
	});

	void test('a running job still stopping from a pause offers Resume instead of Pause', () => {
		assert.deepEqual(menu([job('r', 'running')], () => true), [['View log'], ['Resume', 'Cancel', "Don't process"], ['Remove from queue']]);
	});

	void test('Retry leaves out skips a retry would only repeat', () => {
		const upToDate = { ...job('u', 'skipped'), skipReason: 'already-processed' as const };
		const off = { ...job('o', 'skipped'), skipReason: 'disabled' as const };
		assert.deepEqual(menu([upToDate]), [['View log'], ["Don't process"], ['Remove from queue']]);
		assert.deepEqual(menu([upToDate, off, job('c', 'cancelled')]), [['Retry 2 files', "Don't process 3 files"], ['Remove 3 files from queue']]);
	});

	void test('a file not to process offers Process again, and only that', () => {
		assert.deepEqual(menu([job('x', 'excluded')]), [['View log'], ['Process again'], ['Remove from queue']]);
		assert.deepEqual(menu([job('x', 'excluded'), job('y', 'excluded'), job('f', 'failed')]), [
			['Retry', "Don't process", 'Process 2 files again'],
			['Remove 3 files from queue'],
		]);
	});

	void test('nothing selected, no menu', () => {
		assert.deepEqual(menu([]), []);
	});
});
