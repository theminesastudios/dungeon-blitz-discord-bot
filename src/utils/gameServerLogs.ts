/**
 * `/diagnose logs` — the end of the game server's pm2 logs, as the bot sees them.
 *
 * The game server answers `GET /api/admin/server/logs` (integrations/ServerLogTail.ts there):
 * read-only, behind the shared admin secret, a plain-substring filter, secrets masked on the
 * server before anything is sent. This file only asks and lays the answer out for Discord,
 * whose message content stops at 2,000 characters: a short answer goes inline, a long one as a
 * text file with the newest lines shown inline.
 */
import { fetchGameServerAdmin } from "./gameMaintenance.js";

export type LogStreamChoice = "both" | "error" | "out";

export type ServerLogFile = {
	stream: "out" | "error";
	file: string;
	exists: boolean;
	sizeBytes: number;
	scannedBytes: number;
	lines: string[];
	truncated: boolean;
};

export type ServerLogs = {
	ok: true;
	pm2App: string;
	filter: string;
	lines: number;
	files: ServerLogFile[];
};

export const DEFAULT_LINES = 100;
export const MAX_LINES = 500;
/** Discord's message content limit, less room for formatting. */
export const MAX_INLINE_CHARS = 1_900;

export function fetchServerLogs(options: {
	filter?: string;
	lines?: number;
	stream?: LogStreamChoice;
}): Promise<ServerLogs> {
	const query = new URLSearchParams();
	if (options.filter) query.set("filter", options.filter);
	query.set("lines", String(options.lines ?? DEFAULT_LINES));
	if (options.stream && options.stream !== "both") query.set("stream", options.stream);
	return fetchGameServerAdmin<ServerLogs>(
		`/api/admin/server/logs?${query.toString()}`,
		"the game server's logs",
		15_000,
	);
}

/** A line inside a code block must not be able to close it. */
function fence(line: string): string {
	return line.replace(/```/g, "`​``");
}

function fileTitle(file: ServerLogFile): string {
	return file.stream === "error" ? "error log" : "output log";
}

/** The whole answer as plain text, for the attachment. */
export function renderLogsText(logs: ServerLogs): string {
	const parts: string[] = [
		`pm2 app: ${logs.pm2App}`,
		`filter: ${logs.filter ? JSON.stringify(logs.filter) : "(none)"} · last ${logs.lines} line(s) per file`,
		`generated: ${new Date().toISOString()}`,
	];
	for (const file of logs.files) {
		parts.push("", `===== ${fileTitle(file)} (${file.file}) =====`);
		if (!file.exists) {
			parts.push("(file not found)");
			continue;
		}
		if (file.lines.length === 0) {
			parts.push("(no matching lines)");
			continue;
		}
		if (file.truncated) {
			parts.push(`(more lines matched; showing the last ${file.lines.length})`);
		}
		parts.push(...file.lines);
	}
	return `${parts.join("\n")}\n`;
}

/**
 * The inline message: a header and, per file, as many of the newest lines as fit. `fitsInline`
 * says whether that is everything (otherwise the caller attaches `renderLogsText`).
 */
export function renderLogsMessage(
	logs: ServerLogs,
	maxChars = MAX_INLINE_CHARS,
): { content: string; fitsInline: boolean } {
	const header = `**pm2 logs** \`${logs.pm2App}\` · filter ${logs.filter ? `\`${logs.filter.replace(/`/g, "'")}\`` : "none"} · last ${logs.lines}`;
	const sections = logs.files.map((file) => {
		const title = `**${fileTitle(file)}**`;
		if (!file.exists) return { title: `${title} — file not found`, lines: [] as string[], truncated: false };
		if (file.lines.length === 0) return { title: `${title} — no matching lines`, lines: [] as string[], truncated: false };
		return { title: `${title} — ${file.lines.length} line(s)${file.truncated ? ", more matched" : ""}`, lines: file.lines.map(fence), truncated: file.truncated };
	});

	const build = (perSection: (lines: string[]) => string[]) =>
		[
			header,
			...sections.map((section) =>
				section.lines.length === 0
					? section.title
					: `${section.title}\n\`\`\`\n${perSection(section.lines).join("\n")}\n\`\`\``,
			),
		].join("\n");

	const full = build((lines) => lines);
	if (full.length <= maxChars) {
		return { content: full, fitsInline: true };
	}

	// Too long: keep the newest lines of each section, sharing the room left equally.
	const withSections = sections.filter((section) => section.lines.length > 0).length || 1;
	const overhead = build(() => []).length + 40;
	const budget = Math.max(0, Math.floor((maxChars - overhead) / withSections));
	const content = build((lines) => {
		const kept: string[] = [];
		let used = 0;
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i].length > budget ? `${lines[i].slice(0, Math.max(0, budget - 1))}…` : lines[i];
			if (used + line.length + 1 > budget) break;
			kept.unshift(line);
			used += line.length + 1;
		}
		return kept.length < lines.length ? [`… ${lines.length - kept.length} earlier line(s) in the attached file`, ...kept] : kept;
	});
	return { content: content.slice(0, maxChars), fitsInline: false };
}

/**
 * Replaces a deferred interaction's reply with a message and a text file. The library's
 * editReply sends JSON only, and an attachment needs a multipart request to the same webhook.
 */
export async function editOriginalWithFile(options: {
	applicationId: string;
	token: string;
	content: string;
	fileName: string;
	fileText: string;
}): Promise<void> {
	const form = new FormData();
	form.append(
		"payload_json",
		JSON.stringify({
			content: options.content,
			attachments: [{ id: 0, filename: options.fileName }],
			allowed_mentions: { parse: [] },
		}),
	);
	form.append("files[0]", new Blob([options.fileText], { type: "text/plain; charset=utf-8" }), options.fileName);
	const response = await fetch(
		`https://discord.com/api/v10/webhooks/${options.applicationId}/${options.token}/messages/@original`,
		{ method: "PATCH", body: form, signal: AbortSignal.timeout(15_000) },
	);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Discord refused the attachment (${response.status}): ${detail.slice(0, 200)}`);
	}
}
