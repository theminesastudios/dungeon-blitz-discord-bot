/**
 * HTML pages bundled into the Worker (see src/worker.ts). The Worker has no project
 * filesystem, so MiniInteraction reads its OAuth pages from here first.
 */
const pages = new Map<string, string>();

export function registerHtmlPages(entries: Record<string, string>): void {
	for (const [file, html] of Object.entries(entries)) pages.set(file, html);
}

export function bundledHtmlPage(file: string): string | undefined {
	return pages.get(file);
}
