import { hasText } from '../types';
import type { ExtractResult } from '../types';

/** Docling's conversion status; the sidecar replies with docling-serve's field names. */
export type ConvertStatus = 'success' | 'partial_success' | 'failure' | 'skipped';

/** The sidecar's convert reply, in docling-serve's shape. */
export interface ConvertResponse {
	document?: { filename?: string; md_content?: string | null };
	status: ConvertStatus;
	errors?: { component_type?: string; module_name?: string; error_message?: string }[];
	processing_time?: number;
}

/** Docling's per-file status → ExtractResult, plus warnings for the job log. */
export function mapConvertResponse(response: ConvertResponse): { result: ExtractResult; warnings: string[] } {
	const messages = (response.errors ?? [])
		.map((e) => [e.module_name, e.error_message].filter(Boolean).join(': '))
		.filter((m) => m.length > 0);
	const firstError = response.errors?.find((e) => e.error_message)?.error_message;
	const markdown = (response.document?.md_content ?? '').trim();

	switch (response.status) {
		case 'success':
		case 'partial_success': {
			const warnings = response.status === 'partial_success' ? messages : [];
			if (hasText(markdown)) {
				return { result: { status: 'extracted', markdown, engine: 'docling' }, warnings };
			}
			if (response.status === 'partial_success' && firstError) {
				return { result: { status: 'failed', code: 'docling', message: firstError }, warnings };
			}
			return { result: { status: 'no-text', engine: 'docling' }, warnings };
		}
		case 'skipped':
			return { result: { status: 'unsupported' }, warnings: messages };
		case 'failure':
			return {
				result: { status: 'failed', code: 'docling', message: firstError ?? 'Docling could not convert the file' },
				warnings: messages.slice(1),
			};
		default:
			return {
				result: { status: 'failed', code: 'docling', message: `Unknown Docling status: ${String(response.status)}` },
				warnings: [],
			};
	}
}
