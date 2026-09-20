import * as crypto from "node:crypto";

/**
 * Shared-secret auth for the bot's operational endpoints (the game-health check
 * and the game log channel). Both are called by the game server VM and by Vercel
 * Cron, so they accept the same two secrets in the same three places: the
 * Authorization bearer header, an explicit x-health-secret header, or ?secret=.
 *
 * The comparison is constant-time: these endpoints can be reached by anyone, and
 * a secret that leaks a prefix byte at a time is not a secret.
 */

export function cleanEnvValue(value: string | undefined): string {
	return (value ?? "").trim();
}

/** Secrets that arm an operational endpoint: the shared VM secret, plus Vercel Cron's. */
export function requestSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	return [cleanEnvValue(env.HEALTH_CHECK_SECRET), cleanEnvValue(env.CRON_SECRET)].filter(Boolean);
}

export function matchesSecret(candidate: string, secret: string): boolean {
	const a = Buffer.from(candidate, "utf8");
	const b = Buffer.from(secret, "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isRequestAuthorized(req: any, env: NodeJS.ProcessEnv = process.env): boolean {
	const secrets = requestSecrets(env);
	if (secrets.length === 0) return false;
	const header = String(req?.headers?.authorization ?? "");
	const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	const candidates = [
		bearer,
		String(req?.headers?.["x-health-secret"] ?? ""),
		String(req?.query?.secret ?? ""),
	].filter(Boolean);
	return candidates.some((candidate) => secrets.some((secret) => matchesSecret(candidate, secret)));
}

export function sendJson(res: any, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}
