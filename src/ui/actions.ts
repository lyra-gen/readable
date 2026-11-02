/**
 * User-level actions every surface (ribbon, palette, queue toolbar,
 * context menus) can trigger. Implemented once in main.ts.
 */
export interface UiActions {
	ingestActiveFile: () => void;
	ingestNoteAttachments: () => void;
	ingestFolder: () => void;
	openQueue: () => void;
	openSettings: () => void;
	isAutoIngest: () => boolean;
	/** Reduce motion in settings: queue rows jump instead of sliding. */
	reduceMotion: () => boolean;
	setAutoIngest: (on: boolean) => void;
}
