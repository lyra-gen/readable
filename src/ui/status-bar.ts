import { setIcon } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { QueueSnapshot } from '../core/types';
import { queueCounts } from './format';

/** Bottom-right indicator derived from the queue snapshot. Click opens the queue. */
export class StatusBar {
	private readonly el: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly textEl: HTMLElement;

	constructor(plugin: Plugin, onClick: () => void) {
		this.el = plugin.addStatusBarItem();
		this.el.addClass('readable-status', 'mod-clickable');
		this.el.setAttr('aria-label', 'Readable status');
		this.el.setAttr('data-tooltip-position', 'top');
		this.iconEl = this.el.createSpan({ cls: 'readable-status-icon' });
		this.textEl = this.el.createSpan({ cls: 'readable-status-text' });
		plugin.registerDomEvent(this.el, 'click', onClick);
		this.render({ paused: false, jobs: [] });
	}

	render(snapshot: QueueSnapshot): void {
		const { queued, paused, finished, total } = queueCounts(snapshot.jobs);
		// Paused files wait for the user, so they are named rather than counted as done
		const held = paused > 0 ? `, ${paused} paused` : '';
		this.el.toggleClass('is-processing', queued > 0 && !snapshot.paused);
		if (snapshot.paused) {
			setIcon(this.iconEl, 'pause');
			this.textEl.setText(queued > 0 ? `Readable paused, ${queued} waiting${held}` : `Readable paused${held}`);
		} else if (queued > 0) {
			setIcon(this.iconEl, 'loader');
			this.textEl.setText(`Readable ${finished}/${total} processing${held}`);
		} else {
			setIcon(this.iconEl, 'circle-check');
			this.textEl.setText(`Readable idle${held}`);
		}
	}
}
