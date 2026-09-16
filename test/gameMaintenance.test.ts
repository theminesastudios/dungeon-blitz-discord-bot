import assert from "node:assert/strict";
import { broadcastGameMaintenance } from "../src/utils/gameMaintenance.js";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
	let requestedUrl = "";
	let authorization = "";
	let requestBody = "";
	globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
		requestBody = String(init?.body ?? "");
		const seconds = (JSON.parse(requestBody) as { seconds?: number }).seconds ?? 0;
		return new Response(JSON.stringify({ ok: true, seconds, recipients: 4 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

const result = await broadcastGameMaintenance(300);
assert.equal(requestedUrl, "https://game.example.com/api/admin/maintenance");
assert.equal(authorization, "Bearer test-secret");
assert.deepEqual(JSON.parse(requestBody), { seconds: 300 });
assert.deepEqual(result, { ok: true, seconds: 300, recipients: 4 });

// Without GAME_SERVER_BASE_URL the live game server is used by default.
delete process.env.GAME_SERVER_BASE_URL;
const resultDefault = await broadcastGameMaintenance(60);
assert.equal(requestedUrl, "http://35.185.71.109/api/admin/maintenance");
assert.deepEqual(JSON.parse(requestBody), { seconds: 60 });
assert.deepEqual(resultDefault, { ok: true, seconds: 60, recipients: 4 });

// A misconfigured game server (no admin secret) surfaces its actionable reason verbatim.
const notConfiguredResponse = new Response(
	JSON.stringify({
		error:
			"Discord admin API is not configured: the game server has no ADMIN_API_SECRET or DISCORD_MAINTENANCE_API_SECRET set. Add the same secret the bot uses as its DISCORD_MAINTENANCE_API_SECRET to the game server .env and restart it.",
	}),
	{ status: 503, headers: { "content-type": "application/json" } },
);
globalThis.fetch = async () => notConfiguredResponse;
let notConfiguredReason = "";
try {
	await broadcastGameMaintenance(30);
} catch (error) {
	notConfiguredReason = error instanceof Error ? error.message : String(error);
}
assert.match(notConfiguredReason, /Game server rejected maintenance broadcast \(503\)/);
assert.match(notConfiguredReason, /no ADMIN_API_SECRET or DISCORD_MAINTENANCE_API_SECRET/);

// Without the bot-side secret nothing is sent and the reason names the fix.
delete process.env.DISCORD_MAINTENANCE_API_SECRET;
let missingSecretCalledFetch = false;
globalThis.fetch = async () => {
	missingSecretCalledFetch = true;
	return new Response("{}", { status: 200 });
};
let missingSecretReason = "";
try {
	await broadcastGameMaintenance(30);
} catch (error) {
	missingSecretReason = error instanceof Error ? error.message : String(error);
}
assert.equal(missingSecretCalledFetch, false);
assert.match(missingSecretReason, /DISCORD_MAINTENANCE_API_SECRET/);

console.log("gameMaintenance.test: ok");
} finally {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
}
