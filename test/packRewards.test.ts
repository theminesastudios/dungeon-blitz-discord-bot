import assert from "node:assert/strict";
import {
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

console.log("packRewards tests passed");
