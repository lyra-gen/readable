import type { Plugin } from 'obsidian';
import type { IngestService } from '../core/ingest-service';
import type { ExplorerBadges } from './badges';
import type { ResultNotifier } from './notices';
import type { StatusBar } from './status-bar';

/** Keeps passive UI (status bar, badges, notices) in sync with the service. */
export function bindServiceToUi(
	plugin: Plugin,
	service: IngestService,
	ui: { statusBar: StatusBar; badges: ExplorerBadges; results: ResultNotifier },
): void {
	ui.statusBar.render(service.getSnapshot());
	ui.badges.setJobs(service.getSnapshot().jobs);
	const unsubscribe = service.subscribe((event) => {
		switch (event.type) {
			case 'changed':
				ui.statusBar.render(service.getSnapshot());
				ui.badges.setJobs(service.getSnapshot().jobs);
				break;
			case 'done':
				ui.badges.mark(event.job.sourcePath);
				ui.results.reportDone(event.job);
				break;
			case 'failed':
				ui.results.reportFailed(event.job);
				break;
			case 'engine-unavailable':
				ui.results.reportEngineUnavailable(event.job);
				break;
		}
	});
	plugin.register(unsubscribe);
}
