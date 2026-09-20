import assert from "node:assert/strict";
import handler from "../api/game-log.js";

// The relay is reachable by anyone and it writes into a channel, so the checks
// that matter are: it refuses to be driven without the shared secret, it refuses
// to be driven by a GET at all, and an unconfigured deployment says so loudly
// instead of accepting a message it will silently drop. The outgoing Discord
// call is captured here — no network.

const previous = {
	secret: process.env.HEALTH_CHECK_SECRET,
	cronSecret: process.env.CRON_SECRET,
	botToken: process.env.DISCORD_BOT_TOKEN,
	channelId: process.env.DISCORD_LOG_CHANNEL_ID,
	webhook: process.env.GAME_HEALTH_WEBHOOK_URL,
};

function restoreEnv(): void {
	const assign = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	assign("HEALTH_CHECK_SECRET", previous.secret);
	assign("CRON_SECRET", previous.cronSecret);
	assign("DISCORD_BOT_TOKEN", previous.botToken);
	assign("DISCORD_LOG_CHANNEL_ID", previous.channelId);
	assign("GAME_HEALTH_WEBHOOK_URL", previous.webhook);
}

const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
const originalFetch = globalThis.fetch;

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
	await handler({ method: "POST", headers: {}, ...req }, response);
	return {
		status: response.statusCode as number,
		body: payload ? JSON.parse(payload) : null,
		headers,
	};
}

try {
	globalThis.fetch = (async (url: any, init: any) => {
		calls.push({
			url: String(url),
			body: init?.body ? JSON.parse(String(init.body)) : null,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return { ok: true, status: 204, async text() { return ""; } } as any;
	}) as any;

	process.env.HEALTH_CHECK_SECRET = "log-secret";
	process.env.DISCORD_BOT_TOKEN = "bot-token";
	delete process.env.DISCORD_LOG_CHANNEL_ID;
	delete process.env.GAME_HEALTH_WEBHOOK_URL;

	// GET can never write to the channel.
	const get = await request({ method: "GET" });
	assert.equal(get.status, 405);
	assert.equal(get.headers.allow, "POST");

	// No secret, wrong secret: refused before the body is looked at.
	const anonymous = await request({ body: { event: "started" } });
	assert.equal(anonymous.status, 401);
	const wrongSecret = await request({ headers: { authorization: "Bearer nope" }, body: { event: "started" } });
	assert.equal(wrongSecret.status, 401);
	assert.equal(calls.length, 0, "nothing reaches Discord unauthorized");

	// A missing event is a client bug, not a message.
	const noEvent = await request({ headers: { authorization: "Bearer log-secret" }, body: { message: "hi" } });
	assert.equal(noEvent.status, 400);
	assert.match(String(noEvent.body?.error), /Missing event/);

	// Malformed bodies are rejected, not forwarded.
	const badJson = await request({ headers: { authorization: "Bearer log-secret" }, body: "{not json" });
	assert.equal(badJson.status, 400);
	const oversized = await request({
		headers: { authorization: "Bearer log-secret" },
		body: JSON.stringify({ event: "started", message: "x".repeat(20_000) }),
	});
	assert.equal(oversized.status, 400);
	assert.match(String(oversized.body?.error), /too large/);
	assert.equal(calls.length, 0);

	// The happy path forwards one embed to the configured channel.
	const ok = await request({
		headers: { authorization: "Bearer log-secret" },
		body: {
			event: "crashed",
			message: "uncaughtException: boom",
			host: "dungeonblitzr.theminesa.studio",
			fields: [{ name: "Uptime", value: "3h 12m" }],
		},
	});
	assert.equal(ok.status, 200);
	assert.equal(ok.body?.sent, true);
	assert.equal(ok.body?.channel, "discord-channel:1551118889503432765");
	assert.equal(calls.length, 1);
	assert.match(calls[0]!.url, /channels\/1551118889503432765\/messages$/);
	assert.equal(calls[0]!.headers.Authorization, "Bot bot-token");
	assert.equal(calls[0]!.body.embeds.length, 1);
	assert.equal(calls[0]!.body.embeds[0].title, "🛑 Game server crashed");
	assert.equal(calls[0]!.body.embeds[0].description, "uncaughtException: boom");
	assert.deepEqual(calls[0]!.body.allowed_mentions, { parse: [] }, "log messages never ping anyone");

	// ?secret= is accepted too (the pinger's habit), and the cron secret works.
	const viaQuery = await request({ query: { secret: "log-secret" }, body: { event: "started" } });
	assert.equal(viaQuery.status, 200);
	process.env.CRON_SECRET = "cron-secret";
	const viaCron = await request({ headers: { authorization: "Bearer cron-secret" }, body: { event: "stopping" } });
	assert.equal(viaCron.status, 200);
	assert.equal(calls.length, 3);

	// An unconfigured deployment refuses to pretend: 503, and the answer names the knob.
	delete process.env.DISCORD_BOT_TOKEN;
	const unconfigured = await request({ headers: { authorization: "Bearer log-secret" }, body: { event: "started" } });
	assert.equal(unconfigured.status, 503);
	assert.match(String(unconfigured.body?.error), /not configured/);
	assert.equal(calls.length, 3, "no delivery attempt without a channel");

	// A webhook deployment is the fallback transport.
	process.env.GAME_HEALTH_WEBHOOK_URL = "https://discord.com/api/webhooks/1/2";
	const viaWebhook = await request({ headers: { authorization: "Bearer log-secret" }, body: { event: "started" } });
	assert.equal(viaWebhook.status, 200);
	assert.equal(viaWebhook.body?.channel, "discord-webhook");
	assert.equal(calls.length, 4);
	assert.equal(calls[3]!.url, "https://discord.com/api/webhooks/1/2");

	// A refused delivery is reported as a failure, not as success.
	globalThis.fetch = (async () => ({ ok: false, status: 403, async text() { return "forbidden"; } }) as any);
	const refused = await request({ headers: { authorization: "Bearer log-secret" }, body: { event: "crashed" } });
	assert.equal(refused.status, 502);
	assert.equal(refused.body?.sent, false);

	console.log("[gameLogEndpoint] all assertions passed");
} finally {
	globalThis.fetch = originalFetch;
	restoreEnv();
}
