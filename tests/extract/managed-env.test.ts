import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { managedEnv, managedPaths } from '../../src/extract/docling/managed/paths';

const paths = managedPaths('/tmp/readable-test');

function withEnv<T>(vars: Record<string, string>, run: () => T): T {
	const before = { ...process.env };
	Object.assign(process.env, vars);
	try {
		return run();
	} finally {
		for (const key of Object.keys(vars)) delete process.env[key];
		Object.assign(process.env, before);
	}
}

void describe('the environment of managed Python and uv', () => {
	void test('variables that could redirect downloads or imports do not pass through', () => {
		const env = withEnv(
			{
				UV_INDEX_URL: 'https://evil.test/simple',
				UV_PYTHON_DOWNLOADS_JSON_URL: 'https://evil.test/py.json',
				HF_ENDPOINT: 'https://evil.test',
				PYTHONPATH: '/evil',
				DOCLING_ARTIFACTS_PATH: '/evil/models',
				PIP_INDEX_URL: 'https://evil.test/simple',
			},
			() => managedEnv(paths),
		);
		for (const key of ['UV_INDEX_URL', 'UV_PYTHON_DOWNLOADS_JSON_URL', 'PYTHONPATH', 'DOCLING_ARTIFACTS_PATH', 'PIP_INDEX_URL']) {
			assert.equal(env[key], undefined, key);
		}
		assert.equal(env.HF_ENDPOINT, 'https://huggingface.co');
	});

	void test('what the OS and a proxy need is kept', () => {
		const env = withEnv({ HTTPS_PROXY: 'http://proxy.corp:3128', LC_ALL: 'C.UTF-8' }, () => managedEnv(paths));
		assert.equal(env.HTTPS_PROXY, 'http://proxy.corp:3128');
		assert.equal(env.LC_ALL, 'C.UTF-8');
		assert.equal(env.HOME, process.env.HOME);
		assert.ok(env.PATH?.startsWith(paths.bin));
	});

	void test('offline unless installing', () => {
		assert.equal(managedEnv(paths).HF_HUB_OFFLINE, '1');
		assert.equal(managedEnv(paths).TRANSFORMERS_OFFLINE, '1');
		assert.equal(managedEnv(paths, { online: true }).HF_HUB_OFFLINE, undefined);
		assert.equal(managedEnv(paths).READABLE_DOCLING_MODELS, paths.doclingModels);
	});
});
