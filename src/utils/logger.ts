/**
 * One line per event, always the same shape:
 *
 *   [scope] event key=value key=value
 *
 * Vercel's log viewer is a line-oriented list with no structure, so the value of a log line
 * is decided before it is written: one line per thing that happened, at the point the
 * outcome is known, carrying the identifiers an operator would otherwise have to guess at
 * (command, user, duration, error). Nothing here prints a request body, a token, or a
 * multi-line stack — those turn one event into a wall of noise and are the reason a bot
 * deployment's logs stop being readable.
 */

export type LogLevel = "log" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const MAX_VALUE_LENGTH = 220;
// Bare enough to read, quoted when anything in it is not: a value with a space would
// otherwise look like two fields.
const BARE_VALUE_PATTERN = /^[A-Za-z0-9._:/-]+$/;

export function formatLogValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const text = String(value).replace(/\s+/g, " ").trim();
	if (!text) return '""';
	const truncated =
		text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
	return BARE_VALUE_PATTERN.test(truncated) ? truncated : JSON.stringify(truncated);
}

export function logEvent(
	level: LogLevel,
	scope: string,
	event: string,
	fields: LogFields = {},
): void {
	const parts = [`[${scope}]`, event];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		parts.push(`${key}=${formatLogValue(value)}`);
	}
	console[level](parts.join(" "));
}

export function logInfo(scope: string, event: string, fields?: LogFields): void {
	logEvent("log", scope, event, fields);
}

export function logWarn(scope: string, event: string, fields?: LogFields): void {
	logEvent("warn", scope, event, fields);
}

export function logError(scope: string, event: string, fields?: LogFields): void {
	logEvent("error", scope, event, fields);
}

/** The message, never the stack: a stack belongs in a thrown error, not in a log line. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

/** `const elapsed = startTimer(); … elapsed()` — milliseconds, rounded. */
export function startTimer(): () => number {
	const startedAt = Date.now();
	return () => Date.now() - startedAt;
}

/** Human-readable uptime for log lines and Discord fields. */
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${total % 60}s`;
	return `${total}s`;
}
