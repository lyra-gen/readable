import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { LlmClient, LlmUnavailable } from '../../src/llm/client';
import { fetchModels, parseLmStudioModels, parseOllamaShow, reconcileModels } from '../../src/llm/models';
import { providerForUrl, serverUrl, takesKey } from '../../src/llm/providers';
import { enrichTargetFrom, visionTargetFrom } from '../../src/llm/targets';
import { DEFAULT_SETTINGS, extractionPolicy, normalizeSettings, serverTagsModel, serverVisionModel } from '../../src/settings/model';
import type { ReadableSettings } from '../../src/settings/model';

function settings(patch: Partial<ReadableSettings>): ReadableSettings {
	return { ...DEFAULT_SETTINGS, ...patch };
}

const client = new LlmClient(() => ({ baseUrl: 'http://localhost:1234', apiKey: null }));

void describe('settings saved before providers', () => {
	void test('a fresh install uses Readable’s own AI with one model', () => {
		const s = normalizeSettings({});
		assert.equal(s.aiProvider, 'own');
		assert.equal(s.modelScope, 'one');
	});

	void test('an AI app is matched to its provider by address', () => {
		assert.equal(normalizeSettings({ aiSource: 'app', llmBaseUrl: 'http://localhost:1234/v1' }).aiProvider, 'lmstudio');
		assert.equal(normalizeSettings({ aiSource: 'app', llmBaseUrl: 'http://127.0.0.1:11434' }).aiProvider, 'ollama');
		assert.equal(normalizeSettings({ aiSource: 'app', llmBaseUrl: 'localhost:8080' }).aiProvider, 'llamacpp');
	});

	void test('the usual address is stored empty, another one is kept', () => {
		assert.equal(normalizeSettings({ aiSource: 'app', llmBaseUrl: 'http://localhost:1234/v1' }).llmBaseUrl, '');
		const remote = normalizeSettings({ aiSource: 'app', llmBaseUrl: 'http://192.168.1.5:11434' });
		assert.equal(remote.aiProvider, 'custom');
		assert.equal(remote.llmBaseUrl, 'http://192.168.1.5:11434');
	});

	void test('an AI app with no address becomes Ollama, off stays off', () => {
		assert.equal(normalizeSettings({ aiSource: 'app', llmBaseUrl: '' }).aiProvider, 'ollama');
		assert.equal(normalizeSettings({ aiSource: 'off' }).aiProvider, 'off');
	});

	void test('settings from before aiSource: llmBaseUrl alone', () => {
		const builtin = normalizeSettings({ llmBaseUrl: 'builtin' });
		assert.equal(builtin.aiProvider, 'own');
		assert.equal(builtin.llmBaseUrl, '');
		assert.equal(normalizeSettings({ llmBaseUrl: 'http://localhost:11434' }).aiProvider, 'ollama');
	});

	void test('own AI keeps an old app address for later', () => {
		// The dev vault's settings: own AI, with an Ollama setup from before
		const s = normalizeSettings({ aiSource: 'own', llmBaseUrl: 'http://localhost:11434', llmModel: 'gpt-oss:20b', visionModel: 'gemma3:4b', tagsModel: '' });
		assert.equal(s.aiProvider, 'own');
		assert.equal(s.llmBaseUrl, 'http://localhost:11434');
		assert.equal(s.modelScope, 'perFeature');
	});

	void test('separate model choices keep a model per feature, matching ones share one', () => {
		assert.equal(normalizeSettings({ aiSource: 'app', llmModel: 'a', tagsModel: 'b' }).modelScope, 'perFeature');
		assert.equal(normalizeSettings({ aiSource: 'app', llmModel: 'a', visionModel: 'b' }).modelScope, 'perFeature');
		assert.equal(normalizeSettings({ aiSource: 'app', llmModel: 'a', visionModel: 'a' }).modelScope, 'one');
		assert.equal(normalizeSettings({ aiSource: 'app', llmModel: 'a', visionModel: '' }).modelScope, 'one');
	});

	void test('saved choices are kept as they are', () => {
		const s = normalizeSettings({ aiProvider: 'lmstudio', llmBaseUrl: 'http://localhost:1235', modelScope: 'one', tagsModel: 'b' });
		assert.equal(s.aiProvider, 'lmstudio');
		assert.equal(s.llmBaseUrl, 'http://localhost:1235');
		assert.equal(s.modelScope, 'one');
	});

	void test('the saved model list drops entries that are not models', () => {
		const s = normalizeSettings({ llmModels: [{ id: 'a', vision: true }, { id: 'b' }, { id: '' }, { vision: true }, 'c', null, { id: 'd', vision: 'yes' }] });
		assert.deepEqual(s.llmModels, [{ id: 'a', vision: true }, { id: 'b' }, { id: 'd' }]);
	});
});

void describe('providers', () => {
	void test('the address: the typed one, else the app’s usual one', () => {
		assert.equal(serverUrl(settings({ aiProvider: 'lmstudio' })), 'http://localhost:1234');
		assert.equal(serverUrl(settings({ aiProvider: 'lmstudio', llmBaseUrl: ' http://localhost:1240 ' })), 'http://localhost:1240');
		assert.equal(serverUrl(settings({ aiProvider: 'custom' })), '');
		assert.equal(serverUrl(settings({ aiProvider: 'own', llmBaseUrl: 'http://localhost:11434' })), '');
		assert.equal(serverUrl(settings({ aiProvider: 'off' })), '');
	});

	void test('which providers take an API key', () => {
		assert.equal(takesKey('ollama'), false);
		assert.equal(takesKey('lmstudio'), true);
		assert.equal(takesKey('custom'), true);
		assert.equal(takesKey('own'), false);
	});

	void test('an address that is no app’s usual one matches none', () => {
		assert.equal(providerForUrl('http://localhost:9999'), undefined);
		assert.equal(providerForUrl(''), undefined);
	});
});

void describe('model scope', () => {
	const models = [{ id: 'gpt-oss-120b', vision: false }, { id: 'gemma-4-e4b', vision: true }, { id: 'local-model' }];

	void test('one model describes pictures unless the server says it cannot', () => {
		assert.equal(serverVisionModel(settings({ llmModel: 'gemma-4-e4b', llmModels: models })), 'gemma-4-e4b');
		assert.equal(serverVisionModel(settings({ llmModel: 'gpt-oss-120b', llmModels: models })), '');
		assert.equal(serverVisionModel(settings({ llmModel: 'local-model', llmModels: models })), 'local-model');
		assert.equal(serverVisionModel(settings({ llmModel: 'typed', llmModels: models })), 'typed');
	});

	void test('a model per feature uses each feature’s choice', () => {
		const s = settings({ modelScope: 'perFeature', llmModel: 'gpt-oss-120b', visionModel: 'gemma-4-e4b', tagsModel: 'small', llmModels: models });
		assert.equal(serverVisionModel(s), 'gemma-4-e4b');
		assert.equal(serverTagsModel(s), 'small');
		assert.equal(serverVisionModel({ ...s, visionModel: '' }), '');
	});

	void test('one model ignores the hidden per-feature choices', () => {
		const s = settings({ modelScope: 'one', llmModel: 'a', visionModel: 'b', tagsModel: 'c' });
		assert.equal(serverTagsModel(s), '');
		assert.equal(serverVisionModel(s), 'a');
	});
});

void describe('targets', () => {
	void test('own AI runs without an app address', () => {
		// Before providers, an empty llmBaseUrl turned AI content off for own AI as well
		const target = enrichTargetFrom(settings({ aiProvider: 'own', llmBaseUrl: '' }), client, 'gemma-4-e4b');
		assert.equal(target?.settings.model, 'gemma-4-e4b');
	});

	void test('a server needs a model; its usual address is enough', () => {
		assert.equal(enrichTargetFrom(settings({ aiProvider: 'lmstudio', llmModel: '' }), client, null), null);
		assert.equal(enrichTargetFrom(settings({ aiProvider: 'lmstudio', llmModel: 'm' }), client, null)?.settings.model, 'm');
		assert.equal(enrichTargetFrom(settings({ aiProvider: 'custom', llmModel: 'm' }), client, null), null);
	});

	void test('tags use their own model only per feature', () => {
		const one = enrichTargetFrom(settings({ aiProvider: 'ollama', llmModel: 'm', tagsModel: 't' }), client, null);
		assert.equal(one?.settings.tagsModel, '');
		const perFeature = enrichTargetFrom(settings({ aiProvider: 'ollama', modelScope: 'perFeature', llmModel: 'm', tagsModel: 't' }), client, null);
		assert.equal(perFeature?.settings.tagsModel, 't');
	});

	void test('pictures: none when the one model cannot read them', () => {
		const llmModels = [{ id: 'gpt-oss-120b', vision: false }];
		assert.equal(visionTargetFrom(settings({ aiProvider: 'lmstudio', llmModel: 'gpt-oss-120b', llmModels }), client, null), null);
		assert.equal(visionTargetFrom(settings({ aiProvider: 'lmstudio', llmModel: 'gemma' }), client, null)?.model, 'gemma');
	});

	void test('the extraction policy names the model that describes pictures', () => {
		assert.equal(extractionPolicy(settings({ aiProvider: 'own' })).visionModel, 'own');
		assert.equal(extractionPolicy(settings({ aiProvider: 'off', llmModel: 'm' })).visionModel, '');
		assert.equal(extractionPolicy(settings({ aiProvider: 'ollama', llmModel: 'm' })).visionModel, 'm');
	});
});

void describe('model lists', () => {
	void test('Ollama capabilities', () => {
		assert.deepEqual(parseOllamaShow({ capabilities: ['completion', 'vision'] }), { vision: true, embedding: false });
		assert.deepEqual(parseOllamaShow({ capabilities: ['completion', 'tools'] }), { vision: false, embedding: false });
		assert.deepEqual(parseOllamaShow({ capabilities: ['embedding'] }), { vision: false, embedding: true });
		assert.equal(parseOllamaShow({ details: {} }), null);
	});

	void test('LM Studio v1 list', () => {
		// As LM Studio answered on 2026-10-29
		const caps = parseLmStudioModels({
			models: [
				{ type: 'llm', key: 'gpt-oss-120b', capabilities: { vision: false, trained_for_tool_use: true } },
				{ type: 'llm', key: 'google/gemma-3-4b', capabilities: { vision: true } },
				{ type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5' },
			],
		});
		assert.deepEqual(caps.get('gpt-oss-120b'), { embedding: false, vision: false });
		assert.deepEqual(caps.get('google/gemma-3-4b'), { embedding: false, vision: true });
		assert.deepEqual(caps.get('text-embedding-nomic-embed-text-v1.5'), { embedding: true });
	});

	void test('LM Studio v0 list', () => {
		const caps = parseLmStudioModels({
			data: [
				{ id: 'gpt-oss-120b', type: 'llm' },
				{ id: 'google/gemma-3-4b', type: 'vlm' },
				{ id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings' },
			],
		});
		assert.deepEqual(caps.get('gpt-oss-120b'), { embedding: false, vision: false });
		assert.deepEqual(caps.get('google/gemma-3-4b'), { embedding: false, vision: true });
		assert.deepEqual(caps.get('text-embedding-nomic-embed-text-v1.5'), { embedding: true });
	});

	const listed = [{ id: 'a' }, { id: 'b', vision: true }];

	void test('a fetch keeps a typed model and fills an empty one', () => {
		const typed = { llmModel: 'typed', tagsModel: 'x', visionModel: 'y' };
		assert.deepEqual(reconcileModels(typed, listed, false), typed);
		assert.equal(reconcileModels({ llmModel: '', tagsModel: '', visionModel: '' }, listed, false).llmModel, 'a');
		assert.equal(reconcileModels({ llmModel: '', tagsModel: '', visionModel: '' }, listed, false).visionModel, '');
	});

	void test('another server replaces choices its list lacks', () => {
		assert.deepEqual(reconcileModels({ llmModel: 'old', tagsModel: 'old', visionModel: 'old' }, listed, true), { llmModel: 'a', tagsModel: '', visionModel: 'b' });
		assert.deepEqual(reconcileModels({ llmModel: 'b', tagsModel: 'a', visionModel: 'b' }, listed, true), { llmModel: 'b', tagsModel: 'a', visionModel: 'b' });
	});

	void test('an empty list changes nothing', () => {
		const current = { llmModel: 'old', tagsModel: '', visionModel: 'old' };
		assert.deepEqual(reconcileModels(current, [], true), current);
	});
});

void describe('fetching models', () => {
	let server: Server;
	let url = '';
	const seen: { path: string; auth?: string }[] = [];

	before(async () => {
		server = createServer((req, res) => {
			seen.push({ path: req.url ?? '', auth: req.headers.authorization });
			const reply = (body: unknown) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			if (req.url === '/v1/models') return reply({ data: [{ id: 'gpt-oss-120b' }, { id: 'google/gemma-3-4b' }, { id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'nomic-embed' }] });
			if (req.url === '/api/v1/models') {
				return reply({
					models: [
						{ type: 'llm', key: 'gpt-oss-120b', capabilities: { vision: false } },
						{ type: 'llm', key: 'google/gemma-3-4b', capabilities: { vision: true } },
						{ type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5' },
					],
				});
			}
			if (req.url === '/api/show') {
				let body = '';
				req.on('data', (chunk: Buffer) => (body += chunk.toString()));
				req.on('end', () => {
					const name = (JSON.parse(body) as { name: string }).name;
					reply({ capabilities: name === 'google/gemma-3-4b' ? ['completion', 'vision'] : name === 'gpt-oss-120b' ? ['completion'] : ['embedding'] });
				});
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	void test('LM Studio: chat models, marked, embeddings left out, the key sent', async () => {
		seen.length = 0;
		const models = await fetchModels('lmstudio', url, 'secret');
		assert.deepEqual(models, [{ id: 'gpt-oss-120b', vision: false }, { id: 'google/gemma-3-4b', vision: true }]);
		assert.ok(seen.every((r) => r.auth === 'Bearer secret'));
	});

	void test('Ollama: capabilities from /api/show, even when the address ends in /v1', async () => {
		const models = await fetchModels('ollama', `${url}/v1`, null);
		assert.deepEqual(models, [{ id: 'gpt-oss-120b', vision: false }, { id: 'google/gemma-3-4b', vision: true }]);
	});

	void test('another server: unmarked, embeddings left out by name', async () => {
		assert.deepEqual(await fetchModels('custom', url, null), [{ id: 'gpt-oss-120b' }, { id: 'google/gemma-3-4b' }]);
	});

	void test('a server that is not running', async () => {
		await assert.rejects(fetchModels('lmstudio', 'http://127.0.0.1:9', null), LlmUnavailable);
	});
});
