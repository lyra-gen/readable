import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { LlmClient } from '../../src/llm/client';

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;

/** One server per test file; each test sets how it answers chat requests. */
let handler: Handler = () => undefined;
const seen: Record<string, unknown>[] = [];
let server: Server;
let base = '';

function reply(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function answer(content: string, finish = 'stop') {
	return { choices: [{ message: { content }, finish_reason: finish }] };
}

void describe('chat', () => {
	before(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			let raw = '';
			req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
			req.on('end', () => {
				const body = JSON.parse(raw || '{}') as Record<string, unknown>;
				seen.push(body);
				handler(body, res);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	// A fresh address per test: the client remembers servers that refused the option
	const client = (path: string) => new LlmClient(() => ({ baseUrl: `${base}/${path}`, apiKey: null }));

	void test('turns thinking off', async () => {
		seen.length = 0;
		handler = (_body, res) => reply(res, 200, answer('Краткое содержание.'));
		assert.equal(await client('a').chat([{ role: 'user', content: 'x' }], { model: 'google/gemma-4-e4b', maxTokens: 400 }), 'Краткое содержание.');
		assert.equal(seen[0]?.reasoning_effort, 'none');
		assert.equal(seen[0]?.max_tokens, 400);
	});

	void test('asks again without the option when the server refuses it, and remembers', async () => {
		seen.length = 0;
		handler = (body, res) =>
			body.reasoning_effort === undefined ? reply(res, 200, answer('ok')) : reply(res, 400, { error: { message: "Unrecognized request argument: 'reasoning_effort'" } });
		const c = client('b');
		assert.equal(await c.chat([{ role: 'user', content: 'x' }], { model: 'm' }), 'ok');
		assert.equal(await c.chat([{ role: 'user', content: 'x' }], { model: 'm' }), 'ok');
		assert.deepEqual(
			seen.map((b) => b.reasoning_effort),
			['none', undefined, undefined],
		);
	});

	void test('another 400 is not retried', async () => {
		seen.length = 0;
		handler = (_body, res) => reply(res, 400, { error: { message: 'Context length exceeded' } });
		await assert.rejects(client('c').chat([{ role: 'user', content: 'x' }], { model: 'm' }), /Context length exceeded/);
		assert.equal(seen.length, 1);
	});

	void test('a reply spent on thinking is an error, not an empty answer', async () => {
		handler = (_body, res) => reply(res, 200, answer('', 'length'));
		await assert.rejects(client('d').chat([{ role: 'user', content: 'x' }], { model: 'google/gemma-4-e4b' }), /ran out of room before answering, most likely while thinking/);
		handler = (_body, res) => reply(res, 200, answer('  '));
		await assert.rejects(client('e').chat([{ role: 'user', content: 'x' }], { model: 'm' }), /answered with nothing/);
	});
});
