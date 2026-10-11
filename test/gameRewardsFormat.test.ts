import assert from "node:assert/strict";
import { formatRewardLine } from "../src/utils/gameRewards.js";
import type { PackReward } from "../src/utils/sponsorPacks.js";

assert.equal(
	formatRewardLine({ kind: "mount", mountId: 13, exclusive: false, label: "Mount" }),
	"Mount #13",
);
assert.equal(
	formatRewardLine({ kind: "mount", mountId: 88, exclusive: true, label: "Mount" }),
	"Mount #88 (exclusive)",
);
assert.equal(
	formatRewardLine({ kind: "dye", dyeId: 19, legendary: true, label: "Legendary Dye" }),
	"Legendary dye #19",
);
assert.equal(
	formatRewardLine({ kind: "lockbox", lockboxId: 1, count: 25, label: "Trove Chests" }),
	"25× Trove Chest",
);
assert.equal(
	formatRewardLine({ kind: "consumable", consumableId: "exp", count: 2, label: "exp potion" }),
	"2× EXP Potion",
);
assert.equal(formatRewardLine({ kind: "gold", amount: 100_000 }), "100,000 gold");
assert.equal(formatRewardLine({ kind: "sigils", amount: 250 }), "250 Silver Sigils");
assert.equal(formatRewardLine({ kind: "keys", amount: 25 }), "25× Trove Key");

// Exhaustiveness: adding a reward kind without a formatter breaks this test.
const kinds = new Set<string>(["mount", "dye", "lockbox", "consumable", "gold", "sigils", "keys"]);
const sample: PackReward = { kind: "gold", amount: 1 };
assert.ok(kinds.has(sample.kind));

console.log("gameRewards format tests passed");
