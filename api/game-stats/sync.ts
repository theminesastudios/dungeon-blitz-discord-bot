import * as crypto from "node:crypto";
import {
	syncGameStatsBatch,
	summarizeGameStatsBatch,
	syncGameStatsForDiscordId,
} from "../../src/utils/gameStatsSync.js";
import {
	GameStatsConfigError,
	resolveGameStatsApiConfig,
	type GameStatsApiConfig,
} from "../../src/utils/gameStatsProfile.js";

/**
 * Refreshes Discord Game Stats Widget profiles for linked players.
 *
 * Called by Vercel Cron (GET) or by hand (POST). It is intentionally bounded — one call drains
 * `limit` players within `deadlineMs` and reports `stopReason: "deadline"` when the budget runs
 * out — so it fits inside the platform's 10-second limit and can simply be called again.
 *
 * Body (or query) options:
 *   { "discordIds": ["123..."], "limit": 25, "deadlineMs": 8000, "dryRun": true, "season": "S1" }
 *
 * Auth: only the caller holding the shared secret may run it, because a sync rewrites the public
 * widget data of every player it touches.
 */

const DEFAULT_LIMIT = 25;
const DEFAULT_DEADLINE_MS = 8000;
const MAX_DEADLINE_MS = 9000;
const MAX_REPORTED_RESULTS = 50;
const ERROR_LIMIT = 300;

function cleanEnvValue(value: string | undefined): string {
	return (value ?? "").trim();
}

/**
 * Both secrets are accepted, whichever is present: the dedicated one for manual calls and
 * CRON_SECRET because that is what Vercel Cron sends on its own.
 */
function getSyncSecrets(): string[] {
	return [cleanEnvValue(process.env.GAME_STATS_SYNC_SECRET), cleanEnvValue(process.env.CRON_SECRET)].filter(
		Boolean
	);
}

function matchesSecret(candidate: string, secret: string): boolean {
	const actual = Buffer.from(candidate, "utf8");
	const expected = Buffer.from(secret, "utf8");
	return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isAuthorized(req: any, secrets: string[]): boolean {
	const header = String(req?.headers?.authorization ?? "");
	const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	const candidates = [bearer, String(req?.headers?.["x-game-stats-secret"] ?? "")].filter(Boolean);
	return candidates.some((candidate) =>
		secrets.some((secret) => matchesSecret(candidate, secret))
	);
}

function parseBody(req: any): Record<string, unknown> {
	const raw = req?.body;
	if (!raw) return {};
	if (typeof raw === "object" && !Buffer.isBuffer(raw)) return raw as Record<string, unknown>;
	try {
		return JSON.parse(String(raw)) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function toNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
	if (typeof value === "string" && value.trim()) {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
	}
	return undefined;
}

function sendJson(res: any, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

export default async function handler(req: any, res: any) {
	const method = String(req?.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "POST") {
		res.setHeader("Allow", "GET, POST");
		sendJson(res, 405, { ok: false, error: "Use GET or POST." });
		return;
	}

	const secrets = getSyncSecrets();
	if (secrets.length === 0) {
		// Mirrors the game server's admin endpoints: a missing secret is a deployment problem,
		// not an authorization decision, so say so instead of answering 401 forever.
		sendJson(res, 503, {
			ok: false,
			error:
				"Game Stats sync is not configured. Set GAME_STATS_SYNC_SECRET (or CRON_SECRET) on this deployment.",
		});
		return;
	}

	if (!isAuthorized(req, secrets)) {
		sendJson(res, 401, { ok: false, error: "Unauthorized." });
		return;
	}

	const body = parseBody(req);
	const query = req?.query ?? {};
	const discordIds = toStringArray(body.discordIds) ?? toStringArray(query.discordIds);
	const explicitId = firstString(body.discordId, query.discordId);
	const single = explicitId ?? (discordIds?.length === 1 ? discordIds[0] : undefined);
	const dryRun =
		body.dryRun === true || query.dryRun === "true" || query.dryRun === "1";
	const season = firstString(body.season, query.season, process.env.GAME_STATS_SEASON);
	const limit = toNumber(body.limit ?? query.limit) ?? DEFAULT_LIMIT;
	const deadlineMs = Math.min(
		Math.max(0, toNumber(body.deadlineMs ?? query.deadlineMs) ?? DEFAULT_DEADLINE_MS),
		MAX_DEADLINE_MS
	);

	try {
		// A dry run only shapes payloads, so it must not require a bot token to be configured.
		const config: GameStatsApiConfig | undefined = dryRun ? undefined : resolveGameStatsApiConfig();

		// A single explicit player is the common operator action (verify one account), so it skips
		// the roster read and returns that player's detail straight away.
		if (single && !(discordIds && discordIds.length > 1)) {
			const result = await syncGameStatsForDiscordId(single, { dryRun, season, config });
			sendJson(res, result.outcome === "error" ? 502 : 200, {
				ok: result.outcome !== "error",
				scope: "single",
				result: {
					...result,
					...(result.error ? { error: result.error.slice(0, ERROR_LIMIT) } : {}),
				},
			});
			return;
		}

		const batch = await syncGameStatsBatch({
			discordIds,
			limit,
			deadlineMs,
			dryRun,
			season,
			config,
		});
		sendJson(res, 200, {
			ok: true,
			scope: "batch",
			summary: summarizeGameStatsBatch(batch),
			attempted: batch.attempted,
			stopReason: batch.stopReason,
			results: batch.results.slice(0, MAX_REPORTED_RESULTS).map((result) => ({
				discordId: result.discordId,
				outcome: result.outcome,
				...(result.providerIssuedUserId
					? { providerIssuedUserId: result.providerIssuedUserId }
					: {}),
				...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
				...(result.error ? { error: result.error.slice(0, ERROR_LIMIT) } : {}),
			})),
		});
	} catch (error) {
		if (error instanceof GameStatsConfigError) {
			sendJson(res, 503, { ok: false, error: error.message });
			return;
		}
		console.error("[game-stats] Sync endpoint failed:", error);
		sendJson(res, 500, {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
