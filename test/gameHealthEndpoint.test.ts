import assert from "node:assert/strict";
import handler from "../api/game-health.js";

// The health endpoint is public read-only status without a secret; with one it
// also evaluates and sends alerts. Probes run for real here against a name that
// cannot resolve, so no network dependency and the report classifies as down.

const previous = {
	hostname: process.env.GAME_HEALTH_HOSTNAME,
	secret: process.env.HEALTH_CHECK_SECRET,
	cronSecret: process.env.CRON_SECRET,
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
	process.env.GAME_HEALTH_HOSTNAME = "health-check-test.invalid";
	delete process.env.HEALTH_CHECK_SECRET;
	delete process.env.CRON_SECRET;

	const unsupported = await request({ method: "DELETE" });
	assert.equal(unsupported.status, 405);
	assert.equal(unsupported.headers.allow, "GET, POST");

	// No secret configured anywhere: read-only status, and the note says alerting is unconfigured.
	const publicStatus = await request({});
	assert.equal(publicStatus.status, 200);
	assert.equal(publicStatus.body?.ok, true);
	assert.equal(publicStatus.body?.report?.overall, "down");
	assert.match(String(publicStatus.body?.note), /not configured/);

	// A secret is configured but the request carries none: still read-only.
	process.env.HEALTH_CHECK_SECRET = "health-secret";
	const unauthenticated = await request({});
	assert.equal(unauthenticated.status, 200);
	assert.match(String(unauthenticated.body?.note), /alerting not run/);

	// Wrong secret: still read-only, never an error.
	const wrongSecret = await request({ headers: { authorization: "Bearer nope" } });
	assert.equal(wrongSecret.status, 200);
	assert.match(String(wrongSecret.body?.note), /alerting not run/);

	// Bearer secret arms alerting. Delivery is unconfigured, so the result must
	// say so instead of pretending an alert went out.
	const armed = await request({ headers: { authorization: "Bearer health-secret" } });
	assert.equal(armed.status, 200);
	assert.ok(armed.body?.alert, "armed requests evaluate the alert state");
	assert.equal(armed.body.alert?.sent, false);
	assert.match(String(armed.body.alert?.error), /no alert channel configured/);

	// Vercel's cron secret authenticates too.
	process.env.CRON_SECRET = "cron-secret";
	const viaCron = await request({ headers: { authorization: "Bearer cron-secret" } });
	assert.equal(viaCron.status, 200);
	assert.ok(viaCron.body?.alert);
} finally {
	for (const [key, value] of [
		["GAME_HEALTH_HOSTNAME", previous.hostname],
		["HEALTH_CHECK_SECRET", previous.secret],
		["CRON_SECRET", previous.cronSecret],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

console.log("game health endpoint checks passed");
