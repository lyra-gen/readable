/**
 * How well each local model summarises, titles and tags the demo documents
 * (tests/fixtures/demo: a fictional company's board report, a note too short
 * to summarise) and reads the text in a screenshot, through Readable's own
 * enrichment code on the built-in server.
 *
 * Opt-in and slow: `npm test -- models`. Models are every .gguf in
 * Readable's models folder plus the folders in READABLE_TEST_MODELS
 * (comma-separated). Needs the built-in server installed. A report of every
 * answer is written to .test-build/models-report.md.
 *
 * The checks catch missing facts, digits not in the source and cut-off
 * summaries. They cannot catch a wrong number written as a word or two facts
 * merged into a false one: read the report for those.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import facts from '../fixtures/demo/facts.json';
import { scanModels } from '../../src/llm/builtin/catalog';
import type { LocalModel } from '../../src/llm/builtin/catalog';
import { llamaPaths } from '../../src/llm/builtin/paths';
import { LlamaServer } from '../../src/llm/builtin/server';
import { LlmClient } from '../../src/llm/client';
import { enrich } from '../../src/llm/enrich';
import { DEFAULT_PROMPTS } from '../../src/llm/prompts';
import { FIXTURES, normalize } from '../support/extraction';

const DOCS = path.join(process.cwd(), 'tests', 'fixtures', 'demo');
/** enrich() skips summaries below this many characters (MIN_SUMMARY_CHARS in src/llm/enrich.ts). */
const MIN_SUMMARY_CHARS = 1000;
const TIMEOUT_MS = 10 * 60_000;
const TAG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface Row {
	model: string;
	item: string;
	seconds: number;
	ok: boolean;
	notes: string[];
	output: string;
}
const rows: Row[] = [];

const paths = llamaPaths();
const extra = (process.env.READABLE_TEST_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const models: LocalModel[] = await scanModels([paths.models, ...extra]);
const serverMissing = !existsSync(paths.server);

for (const model of models) {
	void describe(`demo documents with ${model.id}`, () => {
		let server: LlamaServer;
		let client: LlmClient;

		before(async () => {
			if (serverMissing) return;
			server = new LlamaServer(paths, { onStderr: () => undefined, onStateChange: () => undefined, idleMs: () => TIMEOUT_MS, startTimeoutMs: TIMEOUT_MS });
			const url = await server.start(model);
			// The server only answers requests carrying its per-run key, as in Readable
			client = new LlmClient(() => ({ baseUrl: url, apiKey: server.apiKey }));
		});
		after(() => server?.dispose());

		for (const [file, expect] of Object.entries(facts.documents)) {
			void test(file, { timeout: TIMEOUT_MS }, async (t) => {
				if (serverMissing) return t.skip("the built-in server isn't installed");
				const source = readFileSync(path.join(DOCS, file), 'utf8');
				const started = Date.now();
				const warnings: string[] = [];
				const out = await enrich(client, source, {
					summaries: true,
					model: model.id,
					summaryLength: 'short',
					tags: true,
					tagsModel: '',
					tagCount: 5,
					titles: true,
					summaryPrompt: '',
					tagsPrompt: '',
				}, { log: (level, message) => level === 'warn' && warnings.push(message) });
				const row: Row = { model: model.id, item: file, seconds: (Date.now() - started) / 1000, ok: false, notes: [], output: `Title: ${out.title ?? '—'}\nTags: ${(out.tags ?? []).join(', ')}\n\n${out.summary ?? '(no summary)'}` };
				rows.push(row);
				row.notes.push(...warnings);
				const check = (cond: boolean, note: string) => {
					if (!cond) row.notes.push(note);
				};

				if (source.length >= MIN_SUMMARY_CHARS) {
					const summary = out.summary ?? '';
					check(summary.length > 0, 'no summary');
					const hits = expect.facts.filter((f) => f.split('|').some((alt) => normalize(summary).includes(normalize(alt))));
					check(hits.length >= expect.minFacts, `facts ${hits.length}/${expect.facts.length}, need ${expect.minFacts}`);
					// A summary cut off by the reply limit ends mid-sentence
					check(/[.!?)"]\s*$/.test(summary), 'summary cut off mid-sentence');
					const invented = inventedNumbers(summary, source);
					check(invented.length === 0, `numbers not in the source: ${invented.join(', ')}`);
				} else {
					check(out.summary === undefined, 'summarised a text below the minimum');
				}
				check(Boolean(out.title), 'no title');
				check((out.tags ?? []).length > 0, 'no tags');
				const badTags = (out.tags ?? []).filter((tag) => !TAG.test(tag));
				check(badTags.length === 0, `tags not lowercase and hyphenated: ${badTags.join(', ')}`);

				row.ok = row.notes.length === 0;
				t.diagnostic(`${row.seconds.toFixed(1)} s`);
				assert.ok(row.ok, `${row.notes.join('; ')}\n${row.output}`);
			});
		}

		for (const [file, expect] of Object.entries(facts.images)) {
			void test(file, { timeout: TIMEOUT_MS }, async (t) => {
				if (serverMissing) return t.skip("the built-in server isn't installed");
				if (!model.projector) return t.skip('no vision projector beside this model');
				const started = Date.now();
				const text = await describeImage(server, model, path.join(FIXTURES, file));
				const hits = expect.facts.filter((f) => f.split('|').some((alt) => normalize(text).includes(normalize(alt))));
				const row: Row = { model: model.id, item: file, seconds: (Date.now() - started) / 1000, ok: hits.length >= expect.minFacts, notes: [], output: text };
				if (!row.ok) row.notes.push(`facts from the picture ${hits.length}/${expect.facts.length}, need ${expect.minFacts}`);
				rows.push(row);
				t.diagnostic(`${row.seconds.toFixed(1)} s`);
				assert.ok(row.ok, `${row.notes.join('; ')}\n${text}`);
			});
		}
	});
}

void test('report', () => {
	const lines = ['# Demo documents by model', ''];
	const byModel = [...new Set(rows.map((r) => r.model))];
	lines.push('| Model | Passed | Seconds |', '|---|---|---|');
	for (const m of byModel) {
		const mine = rows.filter((r) => r.model === m);
		lines.push(`| ${m} | ${mine.filter((r) => r.ok).length}/${mine.length} | ${mine.reduce((s, r) => s + r.seconds, 0).toFixed(0)} |`);
	}
	for (const r of rows) lines.push('', `## ${r.model} · ${r.item} · ${r.ok ? 'ok' : 'FAIL'} · ${r.seconds.toFixed(1)} s`, ...r.notes.map((n) => `- ${n}`), '', r.output);
	const file = path.join(process.cwd(), '.test-build', 'models-report.md');
	writeFileSync(file, `${lines.join('\n')}\n`);
	process.stdout.write(`\nModels report: ${file}\n${lines.slice(2, 4 + byModel.length).join('\n')}\n`);
});

/** One picture description, as the sidecar asks for it. */
async function describeImage(server: LlamaServer, model: LocalModel, file: string): Promise<string> {
	const url = await server.start(model);
	const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
	const data = readFileSync(file).toString('base64');
	const res = await fetch(`${url}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.apiKey ?? ''}` },
		body: JSON.stringify({
			model: model.id,
			max_tokens: 200,
			temperature: 0.2,
			messages: [{ role: 'user', content: [{ type: 'text', text: DEFAULT_PROMPTS.describe }, { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }] }],
		}),
	});
	const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return body.choices?.[0]?.message?.content ?? '';
}

/**
 * Numbers in the summary that the source does not contain in any scale (a
 * summary may write 4,800,000 as 4.8 million). Small counts are allowed, since
 * the source may spell them out.
 */
function inventedNumbers(summary: string, source: string): string[] {
	const known = new Set<string>();
	for (const n of numbersIn(source)) {
		for (const scale of [1, 1e3, 1e6, 1e9, 1e-3, 1e-6, 1e-9]) known.add(key(n * scale));
	}
	return numbersIn(summary)
		.filter((n) => n > 12 && !known.has(key(n)))
		.map(String);
}

/** Numbers as written in English: 1,940 is one thousand nine hundred and forty, 4.8 a decimal. */
function numbersIn(text: string): number[] {
	return (text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((m) => Number(m.replace(/,/g, '')));
}

function key(n: number): string {
	return String(Math.round(n * 1000) / 1000);
}
