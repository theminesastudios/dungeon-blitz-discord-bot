import { publishGameLog } from "../src/utils/gameLogChannel.js";
import { isRequestAuthorized, matchesSecret, sendJson } from "../src/utils/requestAuth.js";
import { restartGameServer } from "../src/utils/gameServerDeploy.js";
import { errorMessage, logError, logInfo, startTimer } from "../src/utils/logger.js";

/**
 * The scheduled restart of the live game server — `0 3 * * *` in vercel.json.
 *
 * It does two things and neither of them blocks: it asks the game server for a restart onto
 * the branch that is already deployed, with the one-minute warning every player receives in
 * game, and it records the decision in the operator log channel. The waiting and the pm2
 * restart happen on the VM, which can hold a timer across the restart; a serverless function
 * cannot, and a function that tried would either time out before the restart or be killed by
 * it.
 *
 * Why a cron at all: the server only picks up code when it is restarted, so a day whose
 * branch moved but whose process kept running serves yesterday's build. Restarting at a fixed
 * quiet hour makes the deployed commit match the branch without anyone remembering to.
 *
 * Auth: the Vercel cron secret (CRON_SECRET) or the VM's shared secret (HEALTH_CHECK_SECRET),
 * and DISCORD_MAINTENANCE_API_SECRET so an administrator can trigger or rehears it by hand.
 * GET works because Vercel Cron only sends GET.
 *
 * Knobs: `DAILY_RESTART_ENABLED=false` disarms the schedule (`?run=now` still runs it, which
 * is how a disarmed deployment is tested), `DAILY_RESTART_WARNING_SECONDS` changes the
 * warning, and `?branch=`/`?seconds=`/`?dryRun=true` steer a manual run.
 */

function readQuery(req: any): Record<string, string> {
	const query = req?.query;
	if (!query || typeof query !== "object") return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
		const text = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
		if (text) result[key] = text;
	}
	return result;
}

function readBody(req: any): Record<string, unknown> {
	const body = req?.body;
	if (body && typeof body === "object" && !Array.isArray(body)) {
		return body as Record<string, unknown>;
	}
	if (typeof body !== "string") return {};
	try {
		const parsed = JSON.parse(body);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function maintenanceSecretAuthorized(req: any): boolean {
	const configured = String(process.env.DISCORD_MAINTENANCE_API_SECRET ?? "").trim();
	if (!configured) return false;
	const header = String(req?.headers?.authorization ?? "");
	const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	return Boolean(bearer) && matchesSecret(bearer, configured);
}

function dailyRestartEnabled(): boolean {
	const raw = String(process.env.DAILY_RESTART_ENABLED ?? "").trim().toLowerCase();
	return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

function warningSeconds(query: Record<string, string>, body: Record<string, unknown>): number {
	const raw = query.seconds ?? body.seconds ?? process.env.DAILY_RESTART_WARNING_SECONDS ?? "60";
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 60;
}

/** `?dryRun=1`, `?run=now` and `?force=yes` are all what a human types; only the words that
 * actually mean "off" are read as off. */
function isEnabledFlag(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (value === true) return true;
	if (value === false) return false;
	return !["", "false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

export default async function handler(req: any, res: any) {
	const method = String(req?.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "POST") {
		res.setHeader("Allow", "GET, POST");
		sendJson(res, 405, { ok: false, error: "Use GET or POST." });
		return;
	}

	if (!isRequestAuthorized(req) && !maintenanceSecretAuthorized(req)) {
		sendJson(res, 401, { ok: false, error: "Unauthorized." });
		return;
	}

	const query = readQuery(req);
	const body = readBody(req);
	const elapsed = startTimer();
	const runNow = isEnabledFlag(query.run) || isEnabledFlag(body.run);

	if (!dailyRestartEnabled() && !runNow) {
		logInfo("server-maintenance", "skipped", { reason: "DAILY_RESTART_ENABLED is off" });
		sendJson(res, 200, {
			ok: true,
			skipped: "disabled",
			note: "The daily restart is disarmed (DAILY_RESTART_ENABLED=false); append ?run=now to run it anyway.",
		});
		return;
	}

	const seconds = warningSeconds(query, body);
	const requestedBranch = String(query.branch ?? body.branch ?? "").trim() || undefined;
	const dryRun = isEnabledFlag(query.dryRun) || isEnabledFlag(body.dryRun);
	const force = isEnabledFlag(query.force) || isEnabledFlag(body.force);
	const requestedBy = dryRun
		? "scheduled-daily-restart (dry run)"
		: "scheduled-daily-restart";

	try {
		const result = await restartGameServer({
			...(requestedBranch ? { branch: requestedBranch } : {}),
			seconds,
			dryRun,
			force,
			requestedBy,
		});

		const log = await publishGameLog({
			event: "deploy-scheduled",
			title: dryRun ? "🧪 Scheduled restart rehearsal" : undefined,
			message: dryRun
				? `The daily restart would redeploy \`${result.branch}\` at ${result.restartAt}. Nothing was scheduled.`
				: `Redeploying \`${result.branch}\` at ${result.restartAt}. The game server warned ${result.recipients} connected player(s).`,
			fields: [
				{ name: "Branch", value: `\`${result.branch}\``, inline: true },
				{ name: "Commit", value: `\`${String(result.commit ?? "unknown").slice(0, 7)}\``, inline: true },
				{ name: "Warning", value: `${seconds}s`, inline: true },
				{ name: "Requested by", value: requestedBy, inline: true },
				...(result.hold
					? [{ name: "Maintenance hold", value: "set — the restart will not switch branches", inline: false }]
					: []),
			],
			host: "daily-restart cron",
		});

		logInfo("server-maintenance", dryRun ? "rehearsed" : "scheduled", {
			branch: result.branch,
			commit: String(result.commit ?? "unknown").slice(0, 7),
			seconds: result.seconds,
			recipients: result.recipients,
			restartAt: result.restartAt,
			logSent: log.sent,
			ms: elapsed(),
		});

		sendJson(res, 200, {
			ok: true,
			dryRun: result.dryRun,
			branch: result.branch,
			commit: result.commit,
			seconds: result.seconds,
			recipients: result.recipients,
			restartAt: result.restartAt,
			hold: result.hold,
			log: { sent: log.sent, channel: log.channel, ...(log.error ? { error: log.error } : {}) },
			summary: dryRun
				? `Dry run: would redeploy ${result.branch} in ${result.seconds}s.`
				: `Restart to ${result.branch} scheduled in ${result.seconds}s; warned ${result.recipients} player(s).`,
		});
	} catch (error) {
		const message = errorMessage(error);
		logError("server-maintenance", "failed", { error: message, dryRun, ms: elapsed() });
		// A rehearsal that cannot reach the game server is the operator learning something, not
		// an incident: it answers with the reason and leaves the channel alone. A real run that
		// failed is exactly what the channel is for.
		const log = dryRun
			? { sent: false, channel: null, error: "dry run: nothing to report" }
			: await publishGameLog({
					event: "deploy-failed",
					message: `The daily 03:00 restart did not go through: ${message}`,
					fields: [{ name: "Requested by", value: requestedBy, inline: true }],
					host: "daily-restart cron",
				});
		sendJson(res, 502, {
			ok: false,
			dryRun,
			error: message,
			log: { sent: log.sent, channel: log.channel, ...(log.error ? { error: log.error } : {}) },
			note: dryRun
				? "Dry run: nothing was scheduled."
				: "The game server kept running; nothing was restarted.",
		});
	}
}
