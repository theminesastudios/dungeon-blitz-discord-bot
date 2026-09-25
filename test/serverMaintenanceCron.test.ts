import assert from "node:assert/strict";
import handler from "../api/server-maintenance.js";

// The daily 03:00 restart is the one endpoint that changes production without anybody
// present, so what matters is: it cannot be triggered without a secret, it asks the game
// server for a warned restart onto the deployed branch, it records the decision in the
// operator log channel, and it can be disarmed. The outgoing calls are captured here — no
// network, and nothing is restarted.

const previous = {
	secret: process.env.HEALTH_CHECK_SECRET,
	cronSecret: process.env.CRON_SECRET,
	maintenanceSecret: process.env.DISCORD_MAINTENANCE_API_SECRET,
	baseUrl: process.env.GAME_SERVER_BASE_URL,
	botToken: process.env.DISCORD_BOT_TOKEN,
	channelId: process.env.DISCORD_LOG_CHANNEL_ID,
	webhook: process.env.GAME_HEALTH_WEBHOOK_URL,
	enabled: process.env.DAILY_RESTART_ENABLED,
	warning: process.env.DAILY_RESTART_WARNING_SECONDS,
};

function restoreEnv(): void {
	const assign = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	assign("HEALTH_CHECK_SECRET", previous.secret);
	assign("CRON_SECRET", previous.cronSecret);
	assign("DISCORD_MAINTENANCE_API_SECRET", previous.maintenanceSecret);
	assign("GAME_SERVER_BASE_URL", previous.baseUrl);
	assign("DISCORD_BOT_TOKEN", previous.botToken);
	assign("DISCORD_LOG_CHANNEL_ID", previous.channelId);
	assign("GAME_HEALTH_WEBHOOK_URL", previous.webhook);
	assign("DAILY_RESTART_ENABLED", previous.enabled);
	assign("DAILY_RESTART_WARNING_SECONDS", previous.warning);
}

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

const calls: Call[] = [];
const originalFetch = globalThis.fetch;

const RESTART_PAYLOAD = {
	ok: true,
	branch: "main",
	commit: "b2e0728c89b9c899679ae1bc81712afd0ece1578",
	seconds: 60,
	requestedAt: "2026-09-25T03:00:00.000Z",
	restartAt: "2026-09-25T03:01:00.000Z",
	recipients: 4,
	hold: false,
	dryRun: false,
};

function installFetch(restartResponse: { status: number; body: Record<string, unknown> }) {
	calls.length = 0;
	globalThis.fetch = (async (url: unknown, init: any) => {
		const target = String(url);
		calls.push({
			url: target,
			method: String(init?.method ?? "GET"),
			body: init?.body ? JSON.parse(String(init.body)) : null,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		if (target.includes("discord.com")) {
			return { ok: true, status: 204, async text() { return ""; } } as any;
		}
		return new Response(JSON.stringify(restartResponse.body), {
			status: restartResponse.status,
			headers: { "content-type": "application/json" },
		});
	}) as any;
}

async function request(req: Record<string, unknown>) {
	const headers: Record<string, string> = {};
	let payload = "";
	const response: any = {
		statusCode: 0,
		setHeader: (name: string, value: string) => {
			headers[name.toLowerCase()] = value;
		},
		end: (value?: string) => {
			payload = value ?? "";
		},
	};
	await handler({ method: "GET", headers: {}, ...req }, response);
	return {
		status: response.statusCode as number,
		body: payload ? JSON.parse(payload) : null,
		headers,
	};
}

try {
	process.env.HEALTH_CHECK_SECRET = "health-secret";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "maintenance-secret";
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com";
	process.env.DISCORD_BOT_TOKEN = "bot-token";
	process.env.DISCORD_LOG_CHANNEL_ID = "1551118889503432765";
	delete process.env.CRON_SECRET;
	delete process.env.DAILY_RESTART_ENABLED;
	delete process.env.DAILY_RESTART_WARNING_SECONDS;
	installFetch({ status: 202, body: RESTART_PAYLOAD });

	// Only GET and POST; the cron itself always sends GET.
	const notAllowed = await request({ method: "DELETE" });
	assert.equal(notAllowed.status, 405);
	assert.equal(notAllowed.headers.allow, "GET, POST");

	// Nothing without a secret — this endpoint restarts the live server.
	const anonymous = await request({});
	assert.equal(anonymous.status, 401);
	const wrong = await request({ headers: { authorization: "Bearer nope" } });
	assert.equal(wrong.status, 401);
	assert.equal(calls.length, 0, "an unauthorized request must not reach the game server");

	// Vercel Cron authenticates with CRON_SECRET, which is the production path.
	process.env.CRON_SECRET = "cron-secret";
	const viaCron = await request({ headers: { authorization: "Bearer cron-secret" } });
	assert.equal(viaCron.status, 200, JSON.stringify(viaCron.body));
	assert.equal(viaCron.body?.ok, true);
	assert.equal(viaCron.body?.branch, "main");
	assert.equal(viaCron.body?.seconds, 60);
	assert.equal(viaCron.body?.recipients, 4);
	assert.equal(viaCron.body?.dryRun, false);
	assert.match(String(viaCron.body?.summary), /Restart to main scheduled in 60s/);

	assert.equal(calls.length, 2, "one restart request, one log message");
	assert.equal(calls[0]!.url, "https://game.example.com/api/admin/server/restart");
	assert.equal(calls[0]!.method, "POST");
	assert.equal(calls[0]!.headers.Authorization, "Bearer maintenance-secret");
	assert.deepEqual(calls[0]!.body, {
		seconds: 60,
		requestedBy: "scheduled-daily-restart",
	});
	assert.match(calls[1]!.url, /channels\/1551118889503432765\/messages$/);
	assert.equal(calls[1]!.headers.Authorization, "Bot bot-token");
	assert.equal(calls[1]!.body.embeds[0].title, "🛠️ Server restart scheduled");
	assert.match(String(calls[1]!.body.embeds[0].description), /Redeploying `main`/);
	assert.equal(calls[1]!.body.embeds[0].fields[0].name, "Branch");
	assert.equal(calls[1]!.body.embeds[0].fields[0].value, "`main`");

	// A warning length is configurable; the VM secret and query secrets both authenticate.
	process.env.DAILY_RESTART_WARNING_SECONDS = "300";
	const viaHealthSecret = await request({ query: { secret: "health-secret" } });
	assert.equal(viaHealthSecret.status, 200);
	assert.equal(calls.at(-2)!.body.seconds, 300);
	process.env.DAILY_RESTART_WARNING_SECONDS = "60";

	const viaMaintenanceSecret = await request({
		headers: { authorization: "Bearer maintenance-secret" },
	});
	assert.equal(viaMaintenanceSecret.status, 200);
	assert.equal(calls.length, 6);

	// A rehearsal reports what would happen and schedules nothing.
	const dryRun = await request({
		headers: { authorization: "Bearer cron-secret" },
		query: { dryRun: "true", branch: "release/2026-10-02" },
	});
	assert.equal(dryRun.status, 200);
	assert.equal(calls.at(-2)!.body.branch, "release/2026-10-02");
	assert.equal(calls.at(-2)!.body.dryRun, true);
	assert.equal(calls.at(-2)!.body.requestedBy, "scheduled-daily-restart (dry run)");
	assert.equal(calls.at(-1)!.body.embeds[0].title, "🧪 Scheduled restart rehearsal");
	assert.match(String(calls.at(-1)!.body.embeds[0].description), /Nothing was scheduled/);

	// Disarmed, the cron does nothing at all — and ?run=now is the way to test while disarmed.
	calls.length = 0;
	process.env.DAILY_RESTART_ENABLED = "false";
	const disarmed = await request({ headers: { authorization: "Bearer cron-secret" } });
	assert.equal(disarmed.status, 200);
	assert.equal(disarmed.body?.skipped, "disabled");
	assert.match(String(disarmed.body?.note), /DAILY_RESTART_ENABLED=false/);
	assert.equal(calls.length, 0, "a disarmed cron must not touch the game server");
	const forced = await request({
		headers: { authorization: "Bearer cron-secret" },
		query: { run: "now" },
	});
	assert.equal(forced.status, 200);
	assert.equal(forced.body?.dryRun, false);
	assert.equal(calls.length, 2);
	delete process.env.DAILY_RESTART_ENABLED;

	// A rehearsal that cannot reach the game server answers with the reason and stays out of
	// the channel — only a real failed run is an incident worth a message.
	installFetch({ status: 404, body: { ok: false, error: "Cannot POST /api/admin/server/restart" } });
	const rehearsalFailure = await request({
		headers: { authorization: "Bearer cron-secret" },
		query: { dryRun: "true" },
	});
	assert.equal(rehearsalFailure.status, 502);
	assert.match(String(rehearsalFailure.body?.error), /Cannot POST/);
	assert.equal(rehearsalFailure.body?.dryRun, true);
	assert.equal(calls.length, 1, "a failed rehearsal posts nothing");

	// A refusal from the game server is reported as a failure and recorded in the channel.
	installFetch({
		status: 409,
		body: {
			ok: false,
			error: "a maintenance hold is set (tools/server-maintenance.sh --hold)",
		},
	});
	const refused = await request({ headers: { authorization: "Bearer cron-secret" } });
	assert.equal(refused.status, 502);
	assert.match(String(refused.body?.error), /maintenance hold is set/);
	assert.match(String(refused.body?.note), /kept running/);
	assert.equal(calls.length, 2);
	assert.equal(calls.at(-1)!.body.embeds[0].title, "⚠️ Server restart request failed");
	assert.match(String(calls.at(-1)!.body.embeds[0].description), /did not go through/);
	assert.equal(
		calls.at(-1)!.body.allowed_mentions.parse.length,
		0,
		"log messages never ping anyone",
	);

	console.log("[serverMaintenanceCron] all assertions passed");
} finally {
	globalThis.fetch = originalFetch;
	restoreEnv();
}
