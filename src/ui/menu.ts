import type { Menu } from 'obsidian';

/**
 * Menu placement rules. Never call `showAtMouseEvent` / `showAtPosition`
 * directly (enforced by ESLint); use one of these.
 *
 * - Button-triggered menus anchor to the button, not the cursor.
 * - Right-click (context) menus open at the cursor, like Obsidian's own.
 */

/** Opens a menu anchored to the button that triggered it. */
export function showMenuForButton(
	menu: Menu,
	button: HTMLElement,
	side: 'below' | 'right' = 'below',
): void {
	const rect = button.getBoundingClientRect();
	// eslint-disable-next-line no-restricted-syntax -- the one sanctioned call site
	menu.showAtPosition(
		side === 'right'
			? { x: rect.right + 4, y: rect.top }
			: { x: rect.left, y: rect.bottom + 4, width: rect.width, overlap: true, left: false },
		button.doc,
	);
}

/** Opens a right-click context menu at the cursor. */
export function showContextMenu(menu: Menu, evt: MouseEvent): void {
	// eslint-disable-next-line no-restricted-syntax -- the one sanctioned call site
	menu.showAtMouseEvent(evt);
}
