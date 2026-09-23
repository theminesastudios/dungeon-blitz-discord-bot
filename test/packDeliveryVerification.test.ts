import assert from "node:assert/strict";
import { verifyRewardDelivery } from "../src/utils/gameRewards.js";
import { CONSUMABLE_ID_BY_KIND, type PackReward } from "../src/utils/sponsorPacks.js";

/**
 * Delivery is only reported as done when the save read back after the write shows the value.
 * These checks are what stand between a charge and "the credit went but the rewards are not in
 * the database", so each reward shape is verified both ways: present, and provably absent.
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
const lockbox: PackReward = { kind: "lockbox", lockboxId: 1, count: 50, label: "Trove Chests" };
const expPotion: PackReward = {
	kind: "consumable",
	consumableId: "exp",
	count: 2,
	label: "exp potion",
};

// A mount that was added is delivered, and the detail names it.
const mountAdded = verifyRewardDelivery(mount, { mounts: [1, 7] }, { mounts: [1, 7, 81] });
assert.equal(mountAdded.ok, true, JSON.stringify(mountAdded));
assert.equal(mountAdded.detail, "mounts +81");

// Already owning it is still a delivery: the player has the reward the pack promised.
const mountOwned = verifyRewardDelivery(mount, { mounts: [81] }, { mounts: [81] });
assert.equal(mountOwned.ok, true, JSON.stringify(mountOwned));
assert.match(mountOwned.detail, /already owned/);

// The failure this whole check exists for: the write was accepted, the save did not change.
const mountLost = verifyRewardDelivery(mount, { mounts: [1, 7] }, { mounts: [1, 7] });
assert.equal(mountLost.ok, false, JSON.stringify(mountLost));
assert.match(String(mountLost.error), /missing 81/);
assert.match(String(mountLost.error), /did not persist/);

// A character with no mounts array at all is the same test, not a crash.
const mountFromNothing = verifyRewardDelivery(mount, null, { mounts: [81] });
assert.equal(mountFromNothing.ok, true, JSON.stringify(mountFromNothing));
assert.equal(verifyRewardDelivery(mount, null, null).ok, false);

// The Champions' pack delivers its mounts as one bundle; every id has to be there.
const bundleAdded = verifyRewardDelivery(bundle, { mounts: [1] }, { mounts: [1, 81, 82, 83] });
assert.equal(bundleAdded.ok, true, JSON.stringify(bundleAdded));
assert.equal(bundleAdded.detail, "mounts +81, 82, 83");
const bundlePartial = verifyRewardDelivery(bundle, { mounts: [1] }, { mounts: [1, 81, 82] });
assert.equal(bundlePartial.ok, false, JSON.stringify(bundlePartial));
assert.match(String(bundlePartial.error), /missing 83/);

// Dyes land in OwnedDyes.
assert.equal(verifyRewardDelivery(dye, { OwnedDyes: [] }, { OwnedDyes: [4] }).ok, true);
assert.equal(verifyRewardDelivery(dye, { OwnedDyes: [9] }, { OwnedDyes: [9] }).ok, false);

// Currencies are checked as a gain, not an equality: another purchase landing in between is fine.
const goldGain = verifyRewardDelivery(gold, { gold: 12_000 }, { gold: 122_000 });
assert.equal(goldGain.ok, true, JSON.stringify(goldGain));
assert.equal(goldGain.detail, "gold 12,000 → 122,000");
assert.equal(
	verifyRewardDelivery(gold, { gold: 12_000 }, { gold: 12_000 }).ok,
	false,
	"an unchanged balance is not a delivery",
);
assert.equal(verifyRewardDelivery(gold, { gold: 12_000 }, { gold: 20_000 }).ok, false);
assert.equal(verifyRewardDelivery(sigils, null, { SilverSigils: 250 }).ok, true);
assert.equal(verifyRewardDelivery(sigils, { SilverSigils: 10 }, { SilverSigils: 259 }).ok, false);

// Stacked entries: the count itself has to move, and a missing stack is a failure.
const stackGrown = verifyRewardDelivery(lockbox, { lockboxes: [{ lockboxID: 1, count: 3 }] }, { lockboxes: [{ lockboxID: 1, count: 53 }] });
assert.equal(stackGrown.ok, true, JSON.stringify(stackGrown));
assert.equal(stackGrown.detail, "lockboxes[1] 3 → 53");
const stackMissing = verifyRewardDelivery(lockbox, { lockboxes: [{ lockboxID: 1, count: 3 }] }, { lockboxes: [{ lockboxID: 1, count: 3 }] });
assert.equal(stackMissing.ok, false, JSON.stringify(stackMissing));
assert.match(String(stackMissing.error), /lockboxes\[1\]/);

// A stack the character did not own at all is created, not silently skipped.
const stackCreated = verifyRewardDelivery(lockbox, null, { lockboxes: [{ lockboxID: 1, count: 50 }] });
assert.equal(stackCreated.ok, true, JSON.stringify(stackCreated));
assert.equal(stackCreated.detail, "lockboxes[1] 0 → 50");

// Consumables are keyed by the game's numeric id, and only that entry counts.
const potion = verifyRewardDelivery(
	expPotion,
	{ consumables: [{ consumableID: CONSUMABLE_ID_BY_KIND.exp, count: 1 }] },
	{ consumables: [{ consumableID: CONSUMABLE_ID_BY_KIND.exp, count: 3 }] },
);
assert.equal(potion.ok, true, JSON.stringify(potion));
assert.equal(potion.detail, `consumables[${CONSUMABLE_ID_BY_KIND.exp}] 1 → 3`);
assert.equal(
	verifyRewardDelivery(
		expPotion,
		{ consumables: [] },
		{ consumables: [{ consumableID: CONSUMABLE_ID_BY_KIND.gear, count: 2 }] },
	).ok,
	false,
	"the wrong potion id is not a delivery",
);
assert.equal(
	verifyRewardDelivery(expPotion, { consumables: "not-an-array" }, { consumables: null }).ok,
	false,
	"a corrupt field is reported, not thrown",
);

console.log("pack delivery verification tests passed");
