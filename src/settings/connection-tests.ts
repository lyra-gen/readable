import type { LlmClient } from '../llm/client';
import { Notice } from 'obsidian';
import { notify } from '../ui/notices';

/** "Test connection" for the model server: lists models and says whether the chosen one is there. */
export async function testLlmConnection(client: LlmClient, model: string): Promise<void> {
	let models: string[];
	try {
		models = await client.listModels();
	} catch (error) {
		const why = error instanceof Error ? error.message : '';
		notify(`${why || `Couldn't reach the model server at ${client.baseUrl}`}. Is it running?`);
		return;
	}
	const name = model.trim();
	const listed = models.length > 0 ? `: ${models.slice(0, 6).join(', ')}${models.length > 6 ? '…' : ''}` : '';
	if (!name) {
		notify(models.length > 0 ? `Server reachable. Models${listed}. Enter one under Model.` : 'Server reachable, but it lists no models.');
		return;
	}
	const found = models.some((m) => m === name || m === `${name}:latest` || m.replace(/:latest$/, '') === name);
	if (found) notify(`Server reachable; ${name} is available.`);
	else notify(`Server reachable, but ${name} is not among its models${listed}.`);
}

/**
 * "Try it": one short prompt to the model the features use, timed. For the
 * built-in server this also loads the model ahead of the first note.
 * Without a chosen model on an external server, falls back to listing models.
 */
export async function tryModel(client: LlmClient, model: string, label: string): Promise<void> {
	if (!model.trim() && !label) return testLlmConnection(client, model);
	const notice = new Notice(`Asking ${label || model}…`, 0);
	const started = Date.now();
	try {
		const reply = await client.chat([{ role: 'user', content: 'Reply with the single word: ready' }], { model, maxTokens: 8, temperature: 0, timeoutMs: 180_000 });
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		notify(reply ? `${label || model} answered in ${seconds} s.` : `${label || model} answered with nothing in ${seconds} s.`);
	} catch (error) {
		notify(`${label || model} did not answer: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		notice.hide();
	}
}
