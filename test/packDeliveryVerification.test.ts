import assert from "node:assert/strict";
import { deliveryResultsFromGame, type GameRewardResult } from "../src/utils/gameRewards.js";
import { CONSUMABLE_ID_BY_KIND, type PackReward } from "../src/utils/sponsorPacks.js";

/**
 * Delivery is only reported as done when the game server's answer shows the value afterwards.
 * These checks are what stand between a charge and "the credit went but the rewards are not in
 * the game", so each reward shape is verified both ways: present, and provably absent.
 */

const mount: PackReward = { kind: "mount", mountId: 81, exclusive: true, label: "Mount" };
const bundle: PackReward = {
	kind: "mount",
	mountId: 81,
	mountIds: [81, 82, 83],
	exclusive: true,
	label: "Mount",
};
const dye: PackReward = { kind: "dye", dyeId: 4, legendary: true, label: "Legendary Dye" };
const gold: PackReward = { kind: "gold", amount: 10_000 };
const sigils: PackReward = { kind: "sigils", amount: 250 };
const keys: PackReward = { kind: "keys", amount: 3 };
const lockbox: PackReward = { kind: "lockbox", lockboxId: 1, count: 50, label: "Trove Chests" };
const expPotion: PackReward = {
	kind: "consumable",
	consumableId: "exp",
	count: 2,
	label: "exp potion",
};

function result(field: string, before: number, after: number, status: GameRewardResult["status"] = "applied"): GameRewardResult {
	return { kind: "x", field, operation: "add", status, before, after };
}

function one(reward: PackReward, answer: GameRewardResult | undefined, online = false) {
	return deliveryResultsFromGame([reward], "Aiden", answer ? [answer] : [], online)[0];
}

// A mount that was added is delivered, and the detail names it.
const mountAdded = one(mount, result("mounts", 0, 1));
assert.equal(mountAdded.status, "delivered", JSON.stringify(mountAdded));
assert.equal(mountAdded.verified, "mounts +81");
assert.equal(mountAdded.delivery.characterName, "Aiden");

// Already owning it is still a delivery: the player has the reward the pack promised.
const mountOwned = one(mount, result("mounts", 1, 1, "unchanged"));
assert.equal(mountOwned.status, "delivered", JSON.stringify(mountOwned));
assert.match(String(mountOwned.verified), /already owned/);

// The failure this whole check exists for: the server answered, the value is not there.
const mountLost = one(mount, result("mounts", 0, 0));
assert.equal(mountLost.status, "failed", JSON.stringify(mountLost));
assert.match(String(mountLost.error), /did not land/);

// No answer for a reward is a failure, not a delivery.
assert.equal(one(mount, undefined).status, "failed");

// The Champions' pack delivers its mounts as one bundle; every id has to be owned.
const bundleAdded = one(bundle, result("mounts", 0, 3));
assert.equal(bundleAdded.status, "delivered", JSON.stringify(bundleAdded));
assert.equal(bundleAdded.verified, "mounts +81, 82, 83");
const bundlePartial = one(bundle, result("mounts", 0, 2));
assert.equal(bundlePartial.status, "failed", JSON.stringify(bundlePartial));
assert.match(String(bundlePartial.error), /2 of 3/);

// Dyes land in OwnedDyes.
assert.equal(one(dye, result("OwnedDyes", 0, 1)).status, "delivered");
assert.equal(one(dye, result("OwnedDyes", 0, 0)).status, "failed");

// Currencies are checked as a gain, not an equality: another payment landing in between is fine.
const goldGain = one(gold, result("gold", 12_000, 122_000));
assert.equal(goldGain.status, "delivered", JSON.stringify(goldGain));
assert.equal(goldGain.verified, "gold 12,000 → 122,000");
assert.equal(one(gold, result("gold", 12_000, 12_000)).status, "failed", "an unchanged balance is not a delivery");
assert.equal(one(gold, result("gold", 12_000, 20_000)).status, "failed");
assert.equal(one(sigils, result("SilverSigils", 0, 250)).status, "delivered");
assert.equal(one(sigils, result("SilverSigils", 10, 259)).status, "failed");
assert.equal(one(keys, result("DragonKeys", 0, 3)).status, "delivered");

// An online player took it on the live character, and the operator log says so.
assert.equal(one(keys, result("DragonKeys", 0, 3), true).verified, "DragonKeys 0 → 3 (live)");

// Stacked entries: the count itself has to move, including a stack the game had dropped at zero.
const stackGrown = one(lockbox, result("lockboxes[1]", 3, 53));
assert.equal(stackGrown.status, "delivered", JSON.stringify(stackGrown));
assert.equal(stackGrown.verified, "lockboxes[1] 3 → 53");
assert.equal(one(lockbox, result("lockboxes[1]", 0, 50)).verified, "lockboxes[1] 0 → 50");
const stackMissing = one(lockbox, result("lockboxes[1]", 3, 3));
assert.equal(stackMissing.status, "failed", JSON.stringify(stackMissing));
assert.match(String(stackMissing.error), /lockboxes\[1\]/);

// Consumables report their own stack.
const potionField = `consumables[${CONSUMABLE_ID_BY_KIND.exp}]`;
const potion = one(expPotion, result(potionField, 1, 3));
assert.equal(potion.status, "delivered", JSON.stringify(potion));
assert.equal(potion.verified, `${potionField} 1 → 3`);

// A refused reward fails, even though the request as a whole was answered.
assert.equal(one(gold, result("gold", 5, 5, "insufficient")).status, "failed");

// Results line up with the rewards by position.
const both = deliveryResultsFromGame([gold, keys], "Aiden", [result("gold", 0, 10_000), result("DragonKeys", 0, 0)]);
assert.deepEqual(both.map((entry) => entry.status), ["delivered", "failed"]);

console.log("pack delivery verification tests passed");
