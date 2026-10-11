import assert from "node:assert/strict";
import {
	deleteGameCharacter,
	renameGameCharacter,
	RENAME_COST_IDOLS,
	validateCharacterName,
} from "../src/utils/gameCharacterAdmin.js";

assert.deepEqual(validateCharacterName("  Hero2 "), { ok: true, name: "Hero2" });
for (const bad of ["ab", "2Hero", "Hero Two", "Hero:Two", "a".repeat(17), ""]) {
	assert.equal(validateCharacterName(bad).ok, false, bad);
}

const originalFetch = globalThis.fetch;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let next: { status: number; body: string } = { status: 200, body: "{}" };

globalThis.fetch = (async (url: string, init?: RequestInit) => {
	calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
	return new Response(next.body, { status: next.status });
}) as typeof fetch;
process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";

try {
	const input = { userId: 14, characterName: "Hero", newName: "Hero2", requestedByDiscordId: "1" };

	// The bot always sends the cost; the game server charges it with the rename.
	next = {
		status: 200,
		body: JSON.stringify({ ok: true, oldName: "Hero", newName: "Hero2", idolsBefore: 700, idolsAfter: 200 }),
	};
	assert.deepEqual(await renameGameCharacter(input), {
		ok: true,
		oldName: "Hero",
		newName: "Hero2",
		idolsBefore: 700,
		idolsAfter: 200,
	});
	assert.match(calls[0].url, /\/api\/admin\/character\/rename$/);
	assert.equal(calls[0].body.cost, RENAME_COST_IDOLS);

	// Refusals carry a code the player can act on.
	next = { status: 409, body: JSON.stringify({ error: "online", code: "online" }) };
	const online = await renameGameCharacter(input);
	assert.equal(online.ok, false);
	assert.equal(!online.ok && online.refusal, "online");

	next = { status: 409, body: JSON.stringify({ error: "poor", code: "insufficient-idols" }) };
	const poor = await renameGameCharacter(input);
	assert.equal(!poor.ok && poor.refusal, "insufficient-idols");

	// A game server without the route answers with Express's HTML 404: nothing changed.
	next = { status: 404, body: "<!DOCTYPE html><pre>Cannot POST</pre>" };
	const missing = await deleteGameCharacter({ userId: 14, characterName: "Hero", requestedByDiscordId: "1" });
	assert.equal(!missing.ok && missing.refusal, "unavailable");

	next = { status: 404, body: JSON.stringify({ error: "Player character was not found." }) };
	const gone = await deleteGameCharacter({ userId: 14, characterName: "Hero", requestedByDiscordId: "1" });
	assert.equal(!gone.ok && gone.refusal, "not-found");

	next = { status: 200, body: JSON.stringify({ ok: true, characterName: "Hero", remaining: 2 }) };
	assert.deepEqual(
		await deleteGameCharacter({ userId: 14, characterName: "Hero", requestedByDiscordId: "1" }),
		{ ok: true, characterName: "Hero", remaining: 2 },
	);

	console.log("characterAdmin.test: ok");
} finally {
	globalThis.fetch = originalFetch;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
}
