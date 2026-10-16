import assert from "node:assert/strict";
import { stripPackRewardsFromCharacter } from "../src/utils/gameRewards.js";
import {
	EXCLUSIVE_MOUNT_IDS,
	LEGENDARY_DYE_IDS,
	NON_EXCLUSIVE_MOUNT_IDS,
} from "../src/utils/sponsorPacks.js";

/**
 * `/admin rewards` takes a test purchase back. It used to `$pull` the pack's mounts and dyes
 * from Mongo's `saves`, which the game writes over from its own live save, so the character
 * kept them. It now asks the game server, like every grant, and reports only what the server
 * says the character lost.
 */

type Body = { userId: number; characterName: string; rewards: Array<Record<string, any>>; allowLocked?: boolean; requestedBy?: string };

const originalFetch = globalThis.fetch;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";

/** A game server holding `owned` mounts and dyes; `failRequest` answers that request with a refusal. */
function gameServer(owned: { mounts: number[]; dyes: number[] }, failRequest = -1): Body[] {
	const bodies: Body[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		assert.match(String(url), /\/api\/admin\/rewards$/);
		const body = JSON.parse(String(init?.body ?? "{}")) as Body;
		bodies.push(body);
		if (bodies.length - 1 === failRequest) {
			return new Response(JSON.stringify({ error: "The player is signed in on another game server.", code: "held-elsewhere" }), { status: 409 });
		}
		const results = body.rewards.map((change) => {
			const held = change.kind === "dye" ? owned.dyes.includes(change.dyeId) : owned.mounts.includes(change.mountIds[0]);
			return {
				kind: change.kind,
				field: change.kind === "dye" ? "OwnedDyes" : "mounts",
				operation: "remove",
				status: held ? "applied" : "unchanged",
				before: held ? 1 : 0,
				after: 0,
			};
		});
		return new Response(JSON.stringify({ ok: true, userId: body.userId, characterName: "Viefinay", online: true, onlineRecipients: 1, results }), { status: 200 });
	}) as typeof fetch;
	return bodies;
}

try {
	const poolSize = LEGENDARY_DYE_IDS.length + NON_EXCLUSIVE_MOUNT_IDS.length + EXCLUSIVE_MOUNT_IDS.length;

	// Every pack id goes to the game server as a removal, in requests the server accepts.
	const bodies = gameServer({ mounts: [1, 81, 200], dyes: [34] });
	const strip = await stripPackRewardsFromCharacter(14, "viefinay");
	assert.ok(bodies.length >= 2, "more ids than one request may carry");
	for (const body of bodies) {
		assert.ok(body.rewards.length <= 100, `the server refuses more than 100 rewards (${body.rewards.length})`);
		assert.equal(body.userId, 14);
		assert.equal(body.characterName, "viefinay");
		assert.equal(body.allowLocked, true, "staff may change a locked character");
		assert.equal(body.requestedBy, "pack-rewards");
		assert.ok(body.rewards.every((change) => change.operation === "remove"));
	}
	const sent = bodies.flatMap((body) => body.rewards);
	assert.equal(sent.length, poolSize, "every id in the pools, once");
	assert.deepEqual(
		sent.filter((change) => change.kind === "dye").map((change) => change.dyeId),
		[...LEGENDARY_DYE_IDS],
	);
	assert.ok(sent.filter((change) => change.kind === "mount").every((change) => change.mountIds.length === 1),
		"one mount per removal, so the answer says which ones were held");

	// Only what the server says was held is reported, under the name the server knows.
	assert.equal(strip.name, "Viefinay");
	assert.deepEqual(strip.removedDyes, [34]);
	assert.deepEqual(strip.removedMounts, [1, 81], "mount 200 is not a pack mount and was never asked for");
	assert.equal(strip.error, undefined);

	// A refusal part-way stops there and says so; what the first request removed is still listed.
	const refused = gameServer({ mounts: [1], dyes: [34] }, 1);
	const partial = await stripPackRewardsFromCharacter(14, "Viefinay");
	assert.equal(refused.length, 2);
	assert.deepEqual(partial.removedDyes, [34]);
	assert.match(String(partial.error), /another game server/);

	// A refusal on the first request removes nothing.
	gameServer({ mounts: [1], dyes: [34] }, 0);
	const none = await stripPackRewardsFromCharacter(14, "Viefinay");
	assert.deepEqual([none.removedDyes, none.removedMounts], [[], []]);
	assert.ok(none.error);

	console.log("packRewardStrip.test: ok");
} finally {
	globalThis.fetch = originalFetch;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
}
