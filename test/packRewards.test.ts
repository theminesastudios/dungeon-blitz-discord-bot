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

// Every pack rolls a non-empty, shape-valid reward list.
for (const pack of SPONSOR_PACKS) {
	const rewards = buildPackRewards(pack);
	assert.ok(rewards.length > 0, `${pack.id} must produce rewards`);

	for (const reward of rewards) {
		switch (reward.kind) {
			case "mount":
				assert.ok(reward.mountId > 0, "mount ids are positive");
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

// The sponsor pack's mount roll stays inside the non-exclusive pool and the
// pack contents stay gold-only otherwise.
const sponsorRewards = buildPackRewards(findSponsorPack("sponsor")!);
assert.equal(sponsorRewards.length, 2);
const sponsorMount = sponsorRewards.find((reward): reward is PackReward & { kind: "mount" } => reward.kind === "mount")!;
assert.ok(NON_EXCLUSIVE_MOUNT_IDS.includes(sponsorMount.mountId as never));
assert.equal(sponsorMount.exclusive, false);
assert.ok(sponsorRewards.some((reward) => reward.kind === "gold"));

// Exclusive mounts only ever roll from the exclusive pool.
for (let roll = 0; roll < 25; roll += 1) {
	const rewards = buildPackRewards(findSponsorPack("adventurer")!);
	const mount = rewards.find((reward): reward is PackReward & { kind: "mount" } => reward.kind === "mount")!;
	assert.ok(EXCLUSIVE_MOUNT_IDS.includes(mount.mountId as never));
	assert.equal(mount.exclusive, true);
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
			if (reward.kind === "mount") return total + (reward.mountIds?.length ?? 1);
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

// Packs promising several mounts or dyes never roll the same one twice.
for (let roll = 0; roll < 50; roll += 1) {
	for (const id of ["adventurer", "hero"]) {
		const rewards = buildPackRewards(findSponsorPack(id)!);
		const mounts = rewards.flatMap((reward) => (reward.kind === "mount" ? [reward.mountId] : []));
		const dyes = rewards.flatMap((reward) => (reward.kind === "dye" ? [reward.dyeId] : []));
		assert.equal(new Set(mounts).size, mounts.length, `${id} mounts are distinct`);
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

console.log("packRewards tests passed");
