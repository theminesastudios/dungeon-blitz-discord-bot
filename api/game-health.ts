import {
	checkGameHealth,
	maybeAlertOnGameHealth,
	getGameHealthStateStore,
	summarizeGameHealth,
	type GameHealthCheckOptions,
	type GameHealthReport,
} from "../src/utils/gameHealthCheck.js";
import { isRequestAuthorized, requestSecrets, sendJson } from "../src/utils/requestAuth.js";

/**
 * Independent health check for the Dungeon Blitz game host, run from Vercel —
 * a different network and resolver than the game server, so a DNS outage (like
 * the 2026-09 dungeonblitzr A-record loss) or dead game sockets are noticed
 * here even when the server itself looks fine from inside.
 *
 * GET  → run the check, report JSON. With authorized access it also evaluates
 *        the alert state (first alert, hourly reminder, recovery) and sends it
 *        to the configured Discord webhook or DM.
 * POST → identical to GET (convenient for the VM's curl pinger).
 *
 * Auth: with HEALTH_CHECK_SECRET set, requests must present
 * `Authorization: Bearer <secret>` (or `?secret=`) to trigger alerting; Vercel
 * Cron presents CRON_SECRET, which also counts. Without any secret configured
 * the endpoint is read-only public status — the same posture as the game
 * server's public config endpoint.
 */

function cleanEnvValue(value: string | undefined): string {
	return (value ?? "").trim();
}

/**
 * The deployment may pin the probe targets; anything unset falls back to the
 * built-in live defaults so the check works with zero configuration.
 */
function resolveCheckOptions(): GameHealthCheckOptions {
	const hostname = cleanEnvValue(process.env.GAME_HEALTH_HOSTNAME) || undefined;
	const expectedIp = cleanEnvValue(process.env.GAME_HEALTH_EXPECTED_IP) || undefined;
	const pagePath = cleanEnvValue(process.env.GAME_HEALTH_PAGE_PATH) || undefined;
	return {
		...(hostname ? { hostname } : {}),
		...(expectedIp ? { expectedIp } : {}),
		...(pagePath ? { pagePath } : {}),
	};
}

export default async function handler(req: any, res: any) {
	const method = String(req?.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "POST") {
		res.setHeader("Allow", "GET, POST");
		sendJson(res, 405, { ok: false, error: "Use GET or POST." });
		return;
	}

	const alerting = isRequestAuthorized(req);
	const checkOptions = resolveCheckOptions();
	let report: GameHealthReport;
	try {
		report = await checkGameHealth(checkOptions);
	} catch (error) {
		console.error("[game-health] check failed:", error);
		sendJson(res, 500, {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	let alert: Awaited<ReturnType<typeof maybeAlertOnGameHealth>> | null = null;
	if (alerting) {
		const store = await getGameHealthStateStore();
		alert = await maybeAlertOnGameHealth(report, { store });
	}

	sendJson(res, 200, {
		ok: true,
		summary: summarizeGameHealth(report),
		report,
		...(alert ? { alert } : {}),
		...(alerting ? {} : requestSecrets().length > 0
			? { note: "alerting not run: present HEALTH_CHECK_SECRET (or CRON_SECRET) to arm it" }
			: { note: "alerting not configured on this deployment: set HEALTH_CHECK_SECRET plus GAME_HEALTH_WEBHOOK_URL (or GAME_HEALTH_ALERT_DISCORD_ID)" }),
	});
}
