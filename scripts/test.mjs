/**
 * Runs the tests under tests/ with Node's built-in runner. Each *.test.ts is
 * bundled by esbuild (as main.js is), with `obsidian` replaced by
 * tests/support/obsidian.ts, then run one file at a time.
 *
 *   npm test                 every test
 *   npm test -- extraction   only test files whose path contains "extraction"
 *   npm test -- models       the model evaluation, which plain `npm test` leaves out
 */
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, '.test-build');
const filters = process.argv.slice(2);

function findTests(dir) {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) return findTests(full);
		return name.endsWith('.test.ts') ? [full] : [];
	});
}

// The model evaluation is slow and needs models; it runs only when named, e.g. `npm test -- models`
const tests = findTests(path.join(root, 'tests')).filter((f) =>
	filters.length === 0 ? !f.includes(`${path.sep}models${path.sep}`) : filters.some((x) => f.includes(x)),
);
if (tests.length === 0) {
	console.error(`No tests match ${filters.join(', ')}`);
	process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
	entryPoints: tests,
	outdir: outDir,
	outbase: root,
	outExtension: { '.js': '.mjs' },
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: 'inline',
	loader: { '.py': 'text' },
	alias: { obsidian: path.join(root, 'tests', 'support', 'obsidian.ts') },
	// Code written for Obsidian's window: timers and the like live on globalThis in Node
	banner: { js: "globalThis.window ??= globalThis; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	logLevel: 'warning',
});

const built = tests.map((f) => path.join(outDir, path.relative(root, f)).replace(/\.ts$/, '.mjs'));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...built], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
