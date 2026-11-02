import { Notice } from 'obsidian';
import type { LogEntry } from '../core/types';

/** In-memory developer log. Records and shows [dev] notices only while developer mode is on. */
const LIMIT = 500;
const DEV_NOTICE_MS = 2500;
const entries: LogEntry[] = [];
let enabled: () => boolean = () => false;

export function configureDevLog(isEnabled: () => boolean): void {
	enabled = isEnabled;
}

export function getDevLog(): readonly LogEntry[] {
	return entries;
}

export function clearDevLog(): void {
	entries.length = 0;
}

/** Records a line in the developer log without a notice, e.g. sidecar output. */
export function devLog(message: string, level: LogEntry['level'] = 'info'): void {
	if (!enabled()) return;
	entries.push({ ts: Date.now(), level, message });
	if (entries.length > LIMIT) entries.shift();
}

export function devNotice(surface: string, detail?: string): void {
	if (!enabled()) return;
	const message = detail ? `${surface}: ${detail}` : surface;
	devLog(message);
	new Notice(`[dev] ${message}`, DEV_NOTICE_MS);
}
