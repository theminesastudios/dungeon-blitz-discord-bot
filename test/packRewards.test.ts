import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
	BOOSTER_PACK_DAYS,
	boostedDays,
	buildPackRewards,
	findSponsorPack,
	SPONSOR_PACKS,
	CONSUMABLE_ID_BY_KIND,
	EXCLUSIVE_MOUNT_IDS,
	LEGENDARY_DYE_IDS,
	NON_EXCLUSIVE_MOUNT_IDS,
	type PackReward,
} from "../src/utils/sponsorPacks.js";
import {
	applyPackRewardsToSave,
	LockedCharacterError,
	toGameRewardChange,
} from "../src/utils/gameRewards.js";

// Every pack rolls a non-empty, shape-valid reward list.
for (const pack of SPONSOR_PACKS) {
	const rewards = buildPackRewards(pack);
	assert.ok(rewards.length > 0, `${pack.id} must produce rewards`);

	for (const reward of rewards) {
		switch (reward.kind) {
			case "mount":
				if (reward.pick) {
					assert.ok(reward.pick.fromIds.length >= reward.pick.count, "a pick's pool covers its count");
					assert.ok(reward.pick.count > 0, "a pick gives at least one mount");
				} else {
					assert.ok(reward.mountId > 0, "mount ids are positive");
				}
				assert.equal(typeof reward.exclusive, "boolean");
				break;
			case "dye":
				assert.ok(reward.dyeId > 0, "dye ids are positive");
				break;
			case "lockbox":
				assert.ok(reward.count > 0, "lockbox counts are positive");
				break;
			case "consumable":
				assert.ok(CONSUMABLE_ID_BY_KIND[reward.consumableId] > 0);
				assert.ok(reward.count > 0, "consumable counts are positive");
				break;
			case "gold":
			case "sigils":
			case "keys":
				assert.ok(reward.amount > 0, "currency amounts are positive");
				break;
		}
	}
}

// Random mounts are picked by the game server from what the character does not own, so the bot
// only names the pool: non-exclusive for the Sponsor Pack, exclusive for Adventurer and Hero.
const packMounts = (id: string) =>
	buildPackRewards(findSponsorPack(id)!).filter(
		(reward): reward is PackReward & { kind: "mount" } => reward.kind === "mount",
	);
const sponsorRewards = buildPackRewards(findSponsorPack("sponsor")!);
assert.equal(sponsorRewards.length, 2);
assert.ok(sponsorRewards.some((reward) => reward.kind === "gold"));
for (const [id, pool, count, exclusive] of [
	["sponsor", NON_EXCLUSIVE_MOUNT_IDS, 1, false],
	["adventurer", EXCLUSIVE_MOUNT_IDS, 1, true],
	["hero", EXCLUSIVE_MOUNT_IDS, 3, true],
] as const) {
	const mounts = packMounts(id);
	assert.equal(mounts.length, 1, `${id} asks for its mounts as one pick`);
	assert.deepEqual(mounts[0].pick, { fromIds: [...pool], count }, `${id} picks ${count} from its pool`);
	assert.equal(mounts[0].exclusive, exclusive);
}

// Champions' pack grants every exclusive mount and every legendary dye. The mounts arrive as one
// bundle reward (the pack shows them as a single line), so collect ids from both shapes.
const championsRewards = buildPackRewards(findSponsorPack("champions")!);
const championMounts = championsRewards
	.filter((reward): reward is PackReward & { kind: "mount" } => reward.kind === "mount")
	.flatMap((reward) => reward.mountIds ?? [reward.mountId])
	.sort((a, b) => a - b);
assert.deepEqual(championMounts, [...EXCLUSIVE_MOUNT_IDS].sort((a, b) => a - b));
const championDyes = championsRewards
	.filter((reward): reward is PackReward & { kind: "dye" } => reward.kind === "dye")
	.map((reward) => reward.dyeId)
	.sort((a, b) => a - b);
assert.deepEqual(championDyes, [...LEGENDARY_DYE_IDS].sort((a, b) => a - b));

// Unknown packs roll nothing.
assert.deepEqual(buildPackRewards({ id: "unknown" }), []);

// Hero pack rolls three distinct-eligible exclusive mounts; the dye pool the
// supporter pack rolls from must be the legendary pool.
for (let roll = 0; roll < 25; roll += 1) {
	const supporterRewards = buildPackRewards(findSponsorPack("supporter")!);
	const dye = supporterRewards.find((reward): reward is PackReward & { kind: "dye" } => reward.kind === "dye")!;
	assert.ok(LEGENDARY_DYE_IDS.includes(dye.dyeId as never));
}

// Every pack's reward list matches its banner: count each kind of thing it hands out.
function tally(rewards: PackReward[]) {
	const sum = (kind: PackReward["kind"]) =>
		rewards.reduce((total, reward) => {
			if (reward.kind !== kind) return total;
			if (reward.kind === "lockbox" || reward.kind === "consumable") return total + reward.count;
			if (reward.kind === "mount") return total + (reward.pick?.count ?? reward.mountIds?.length ?? 1);
			if (reward.kind === "dye") return total + 1;
			return total + reward.amount;
		}, 0);
	return {
		keys: sum("keys"),
		chests: sum("lockbox"),
		mounts: sum("mount"),
		dyes: sum("dye"),
		sigils: sum("sigils"),
		gold: sum("gold"),
		potions: sum("consumable"),
	};
}
const expected: Record<string, ReturnType<typeof tally>> = {
	sponsor: { keys: 0, chests: 0, mounts: 1, dyes: 0, sigils: 0, gold: 10_000, potions: 0 },
	booster: { keys: 2, chests: 2, mounts: 0, dyes: 0, sigils: 0, gold: 10_000, potions: 1 },
	supporter: { keys: 3, chests: 3, mounts: 0, dyes: 1, sigils: 0, gold: 25_000, potions: 0 },
	adventurer: { keys: 10, chests: 10, mounts: 1, dyes: 2, sigils: 250, gold: 0, potions: 2 },
	hero: { keys: 25, chests: 25, mounts: 3, dyes: 4, sigils: 750, gold: 100_000, potions: 8 },
	champions: {
		keys: 50,
		chests: 50,
		mounts: EXCLUSIVE_MOUNT_IDS.length,
		dyes: LEGENDARY_DYE_IDS.length,
		sigils: 750,
		gold: 250_000,
		potions: 20,
	},
};
for (const pack of SPONSOR_PACKS) {
	assert.deepEqual(tally(buildPackRewards(pack)), expected[pack.id], `${pack.id} matches its banner`);
}

// Packs promising several dyes never roll the same one twice.
for (let roll = 0; roll < 50; roll += 1) {
	for (const id of ["adventurer", "hero"]) {
		const rewards = buildPackRewards(findSponsorPack(id)!);
		const dyes = rewards.flatMap((reward) => (reward.kind === "dye" ? [reward.dyeId] : []));
		assert.equal(new Set(dyes).size, dyes.length, `${id} dyes are distinct`);
	}
}

// Banners are served from the bot's own production host, one file per pack.
for (const pack of SPONSOR_PACKS) {
	assert.ok(existsSync(`assets/packs/${pack.id}.png`), `assets/packs/${pack.id}.png exists`);
	assert.match(pack.imageUrl, new RegExp(`^https://[^/]+/assets/packs/${pack.id}\\.png$`));
}

// The Booster Pack is free and gated on boosting for BOOSTER_PACK_DAYS days.
const booster = findSponsorPack("booster")!;
assert.equal(booster.priceCents, 0);
assert.equal(booster.requiredBoostDays, BOOSTER_PACK_DAYS);
const now = Date.parse("2026-10-11T12:00:00Z");
assert.equal(boostedDays(null, now), null);
assert.equal(boostedDays("not a date", now), null);
assert.equal(boostedDays("2026-10-05T12:00:01Z", now), 5);
assert.equal(boostedDays("2026-10-04T12:00:00Z", now), 7);

// Rewards are paid by the game server, never written to Mongo: the game's live save overwrites
// Mongo, which is how "Supporter Pack delivered to Aiden" ended up with nothing in game.
assert.deepEqual(toGameRewardChange({ kind: "mount", mountId: 81, exclusive: true, label: "" }), {
	kind: "mount",
	mountIds: [81],
});
assert.deepEqual(
	toGameRewardChange({ kind: "mount", mountId: 0, exclusive: true, label: "", pick: { fromIds: [81, 82, 83], count: 2 } }),
	{ kind: "mount", fromIds: [81, 82, 83], count: 2 },
	"a pick names its pool, never a mount id, so an older game server refuses it instead of granting the pool",
);
assert.deepEqual(
	toGameRewardChange({ kind: "consumable", consumableId: "exp", count: 2, label: "" }),
	{ kind: "consumable", consumableID: CONSUMABLE_ID_BY_KIND.exp, count: 2 },
	"potions travel as the game's numeric id",
);
assert.deepEqual(toGameRewardChange({ kind: "keys", amount: 3 }), { kind: "keys", amount: 3 });

{
	const originalFetch = globalThis.fetch;
	const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
	const calls: Array<{ url: string; auth: string; body: Record<string, any> }> = [];
	let answers: Array<{ status: number; body: string } | Error> = [];

	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({
			url: String(url),
			auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
			body: JSON.parse(String(init?.body ?? "{}")),
		});
		const next = answers.shift() ?? { status: 500, body: "{}" };
		if (next instanceof Error) throw next;
		return new Response(next.body, { status: next.status });
	}) as typeof fetch;
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";

	const supporter: PackReward[] = [
		{ kind: "keys", amount: 3 },
		{ kind: "lockbox", lockboxId: 1, count: 3, label: "Trove Chests" },
		{ kind: "dye", dyeId: 34, legendary: true, label: "Legendary Dye" },
		{ kind: "gold", amount: 25_000 },
	];
	const paid = {
		ok: true,
		userId: 14,
		characterName: "Aiden",
		online: true,
		onlineRecipients: 1,
		results: [
			{ kind: "keys", field: "DragonKeys", operation: "add", status: "applied", before: 0, after: 3 },
			{ kind: "lockbox", field: "lockboxes[1]", operation: "add", status: "applied", before: 0, after: 3 },
			{ kind: "dye", field: "OwnedDyes", operation: "add", status: "applied", before: 0, after: 1 },
			{ kind: "gold", field: "gold", operation: "add", status: "applied", before: 100, after: 25_100 },
		],
	};

	try {
		// The whole pack is one authorized request, and every reward comes back delivered.
		answers = [{ status: 200, body: JSON.stringify(paid) }];
		const delivered = await applyPackRewardsToSave(14, "aiden", supporter);
		assert.equal(calls.length, 1);
		assert.match(calls[0].url, /\/api\/admin\/rewards$/);
		assert.equal(calls[0].auth, "Bearer test-secret");
		assert.equal(calls[0].body.userId, 14);
		assert.equal(calls[0].body.characterName, "aiden");
		assert.deepEqual(calls[0].body.rewards, supporter.map(toGameRewardChange));
		assert.equal(typeof calls[0].body.requestId, "string");
		assert.ok(!calls[0].body.allowLocked, "the shop never pays a locked character");
		assert.deepEqual(delivered.map((entry) => entry.status), ["delivered", "delivered", "delivered", "delivered"]);
		assert.equal(delivered[0].delivery.characterName, "Aiden", "the game's own spelling of the name");
		assert.equal(delivered[3].verified, "gold 100 → 25,100 (live)");

		// A timeout may already have paid: the retry carries the same requestId, so it pays once.
		calls.length = 0;
		answers = [new Error("The operation was aborted due to timeout"), { status: 200, body: JSON.stringify(paid) }];
		const retried = await applyPackRewardsToSave(14, "Aiden", supporter);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].body.requestId, calls[0].body.requestId);
		assert.ok(retried.every((entry) => entry.status === "delivered"));

		// Unreachable twice: every reward fails, which refunds the purchase.
		calls.length = 0;
		answers = [new Error("ECONNREFUSED"), new Error("ECONNREFUSED")];
		const unreachable = await applyPackRewardsToSave(14, "Aiden", supporter);
		assert.ok(unreachable.every((entry) => entry.status === "failed"));
		assert.match(String(unreachable[0].error), /could not be reached/);

		// A game server without the route yet answers with an HTML 404: nothing was paid.
		answers = [{ status: 404, body: "<!DOCTYPE html><pre>Cannot POST /api/admin/rewards</pre>" }];
		const noRoute = await applyPackRewardsToSave(14, "Aiden", supporter);
		assert.ok(noRoute.every((entry) => entry.status === "failed"));
		assert.match(String(noRoute[0].error), /no \/api\/admin\/rewards route/);

		// Refusals name what the player can do about them.
		answers = [{ status: 404, body: JSON.stringify({ error: "x", code: "not-found" }) }];
		const missing = await applyPackRewardsToSave(14, "Ghost", supporter);
		assert.ok(missing.every((entry) => entry.status === "failed"));
		assert.match(String(missing[0].error), /"Ghost" is not on your game save/);

		answers = [{ status: 404, body: JSON.stringify({ error: "x", code: "no-save" }) }];
		assert.match(String((await applyPackRewardsToSave(14, "Aiden", supporter))[0].error), /No game save exists/);

		answers = [{ status: 409, body: JSON.stringify({ error: "x", code: "held-elsewhere" }) }];
		assert.match(String((await applyPackRewardsToSave(14, "Aiden", supporter))[0].error), /another game server/);

		answers = [{ status: 409, body: JSON.stringify({ error: "x", code: "locked" }) }];
		await assert.rejects(applyPackRewardsToSave(14, "Alt", supporter), LockedCharacterError);

		// A 500 is a failed save on the game server, which put the character back as it was.
		answers = [{ status: 500, body: JSON.stringify({ error: "The reward delivery failed." }) }];
		const crashed = await applyPackRewardsToSave(14, "Aiden", supporter);
		assert.ok(crashed.every((entry) => entry.status === "failed"));
	} finally {
		globalThis.fetch = originalFetch;
		if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
		else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
	}
}

console.log("packRewards tests passed");
