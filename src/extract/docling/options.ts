export const TABLE_MODES = ['accurate', 'fast'] as const;
export type TableMode = (typeof TABLE_MODES)[number];

/**
 * When pages go through OCR. `auto`: only pages without a text layer (scans,
 * photos). `all`: every page, which replaces a bad text layer. `off`: never.
 */
export const OCR_MODES = ['auto', 'all', 'off'] as const;
export type OcrMode = (typeof OCR_MODES)[number];

/** Which OCR engine reads the pages. `auto` is Docling's order: Apple Vision on a Mac, then RapidOCR. */
export const OCR_ENGINES = ['auto', 'ocrmac', 'rapidocr'] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];

export interface OcrOptions {
	mode: OcrMode;
	/** BCP-47 tags in order of preference, e.g. `['en', 'ru']`. Never empty. */
	languages: string[];
	engine: OcrEngine;
}

/** Conversion options from settings; the managed extractor adds speech and vision. */
export interface DoclingCommonOptions {
	/** Write the pictures Docling finds to files for the pipeline to attach. */
	figures: boolean;
	ocr: OcrOptions;
	tableMode: TableMode;
	/** Per-document limit, in seconds; past it the sidecar is killed. */
	timeoutSec: number;
}
