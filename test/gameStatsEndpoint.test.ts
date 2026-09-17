import assert from "node:assert/strict";
import handler from "../api/game-stats/sync.js";

// The sync rewrites public profile data, so the endpoint must refuse anything it cannot
// authenticate — and say so clearly when the deployment simply forgot the secret.

const previous = {
	secret: process.env.GAME_STATS_SYNC_SECRET,
	cronSecret: process.env.CRON_SECRET,
	mongoUri: process.env.MONGODB_URI,
	gameMongoUri: process.env.GAME_MONGODB_URI,
};

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
	await handler({ headers: {}, method: "GET", ...req }, response);
	return {
		status: response.statusCode as number,
		body: payload ? JSON.parse(payload) : null,
		headers,
	};
}

try {
	// No secret configured: a deployment problem, not an authorization decision.
	delete process.env.GAME_STATS_SYNC_SECRET;
	delete process.env.CRON_SECRET;
	const unconfigured = await request({ method: "GET" });
	assert.equal(unconfigured.status, 503);
	assert.match(String(unconfigured.body?.error), /GAME_STATS_SYNC_SECRET/);

	process.env.GAME_STATS_SYNC_SECRET = "sync-secret";

	const anonymous = await request({ method: "GET" });
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.body?.ok, false);

	const wrongSecret = await request({
		method: "GET",
		headers: { authorization: "Bearer nope" },
	});
	assert.equal(wrongSecret.status, 401);

	const unsupported = await request({
		method: "DELETE",
		headers: { authorization: "Bearer sync-secret" },
	});
	assert.equal(unsupported.status, 405);
	assert.equal(unsupported.headers.allow, "GET, POST");

	// A wrong-length candidate must not crash the timing-safe comparison.
	const shortSecret = await request({
		method: "GET",
		headers: { "x-game-stats-secret": "s" },
	});
	assert.equal(shortSecret.status, 401);

	// Past the secret checks the handler reaches the sync itself. The database is deliberately
	// unavailable here, which must surface as a failure rather than an authorization answer.
	delete process.env.MONGODB_URI;
	delete process.env.GAME_MONGODB_URI;
	const authorized = await request({
		method: "GET",
		headers: { authorization: "Bearer sync-secret" },
		query: { discordId: "1447954255452311695" },
	});
	assert.notEqual(authorized.status, 401, "an authenticated request is not rejected as anonymous");
	assert.equal(authorized.body?.ok, false, "the sync cannot succeed without database access");

	// Vercel Cron authenticates with CRON_SECRET instead of the dedicated secret.
	process.env.CRON_SECRET = "cron-secret";
	const withCronSecret = await request({
		method: "GET",
		headers: { authorization: "Bearer cron-secret" },
		query: { discordId: "1447954255452311695" },
	});
	assert.notEqual(withCronSecret.status, 401, "the Vercel cron secret authenticates the request");
} finally {
	for (const [key, value] of [
		["GAME_STATS_SYNC_SECRET", previous.secret],
		["CRON_SECRET", previous.cronSecret],
		["MONGODB_URI", previous.mongoUri],
		["GAME_MONGODB_URI", previous.gameMongoUri],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

console.log("game stats endpoint checks passed");
