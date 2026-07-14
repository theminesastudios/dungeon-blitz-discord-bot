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
		return new Response(JSON.stringify({ ok: true, seconds: 300, recipients: 4 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const result = await broadcastGameMaintenance(300);
	assert.equal(requestedUrl, "https://game.example.com/api/admin/maintenance");
	assert.equal(authorization, "Bearer test-secret");
	assert.deepEqual(JSON.parse(requestBody), { seconds: 300 });
	assert.deepEqual(result, { ok: true, seconds: 300, recipients: 4 });

	console.log("gameMaintenance.test: ok");
} finally {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
}
