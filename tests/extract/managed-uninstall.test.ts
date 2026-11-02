import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { uninstall } from '../../src/extract/docling/managed/installer';
import { managedPaths } from '../../src/extract/docling/managed/paths';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'readable-uninstall-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** An app-data folder as a real install leaves it: Docling, Readable's own AI with a model, and a vault's queue. */
function installed(): string {
	const root = path.join(scratch, `${Math.random().toString(36).slice(2)}-Readable`);
	const files = [
		'install.json',
		'docling_sidecar.py',
		'venv/bin/python',
		'bin/uv',
		'python/cpython-3.12/bin/python3',
		'models/docling/layout.safetensors',
		'models/xet/chunk',
		'uv-cache/x',
		'tmp/download.part',
		'checkpoints/abc/chunk1.md',
		'llama/install.json',
		'llama/build/llama-server',
		'llama/models/gemma-4-e4b/gemma-4-E4B-it-Q4_0.gguf',
		'vaults/vault-id/queue.json',
	];
	for (const file of files) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), 'x');
	}
	return root;
}

void describe('removing Docling', () => {
	void test("removes Docling's files and folders", async () => {
		const root = installed();
		await uninstall(managedPaths(root));
		for (const gone of ['install.json', 'docling_sidecar.py', 'venv', 'bin', 'python', 'models', 'uv-cache', 'tmp', 'checkpoints']) {
			assert.equal(existsSync(path.join(root, gone)), false, `${gone} should be gone`);
		}
	});

	void test("keeps Readable's own AI, its downloaded models and every vault's queue", async () => {
		const root = installed();
		await uninstall(managedPaths(root));
		for (const kept of ['llama/install.json', 'llama/build/llama-server', 'llama/models/gemma-4-e4b/gemma-4-E4B-it-Q4_0.gguf', 'vaults/vault-id/queue.json']) {
			assert.equal(existsSync(path.join(root, kept)), true, `${kept} should be kept`);
		}
	});

	void test('refuses a folder that is not Readable’s', async () => {
		const root = path.join(scratch, 'Documents');
		mkdirSync(root, { recursive: true });
		await assert.rejects(uninstall(managedPaths(root)), /Refusing/);
	});
});
