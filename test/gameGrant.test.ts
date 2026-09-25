import assert from "node:assert/strict";
import {
	ALL_MOUNT_IDS,
	DYE_NAMES,
	GRANT_CATEGORIES,
	MOUNT_NAMES,
	findGrantCategory,
	grantItemLabel,
	listGrantItems,
	mountLabel,
} from "../src/utils/gameGrant.js";
import {
	EXCLUSIVE_MOUNT_IDS,
	LEGENDARY_DYE_IDS,
	NON_EXCLUSIVE_MOUNT_IDS,
} from "../src/utils/sponsorPacks.js";
import {
	BAN_DURATION_CHOICES,
	banDurationSeconds,
	formatBanDuration,
} from "../src/utils/gameModeration.js";
import {
	canManageGuild,
	isAdministrator,
} from "../src/utils/discordInteractions.js";

// Every category is renderable: a select option built from it must have a label and an emoji.
for (const category of GRANT_CATEGORIES) {
	assert.ok(category.label.length > 0, `${category.id} needs a label`);
	assert.ok(category.emoji.length > 0, `${category.id} needs an emoji`);
	assert.ok(category.unit.length > 0, `${category.id} needs a unit`);
	assert.ok(category.shape === "currency" || category.shape === "list" || category.shape === "stack");
	if (category.shape === "currency") {
		assert.ok(category.currencyField, `${category.id} is a currency and needs a save field`);
	}
}

// Ids are unique; two categories with one id would make `findGrantCategory` lie.
const ids = GRANT_CATEGORIES.map((category) => category.id);
assert.equal(new Set(ids).size, ids.length);
assert.equal(findGrantCategory("gold")?.currencyField, "gold");
assert.equal(findGrantCategory("nope"), null);

// The mount picker offers the game's whole mount pool, exclusive ones included.
const mountItems = listGrantItems("mount").map((item) => Number(item.key));
assert.deepEqual(
	mountItems,
	[...NON_EXCLUSIVE_MOUNT_IDS, ...EXCLUSIVE_MOUNT_IDS],
);
assert.deepEqual(mountItems, [...ALL_MOUNT_IDS]);
assert.ok(listGrantItems("mount").some((item) => item.description.includes("Exclusive")));

// Dye options come from the legendary pool the shop rolls from.
assert.deepEqual(
	listGrantItems("dye").map((item) => Number(item.key)),
	[...LEGENDARY_DYE_IDS],
);

// Currency categories have nothing to pick: the flow asks for an amount instead.
for (const category of GRANT_CATEGORIES) {
	if (category.shape === "currency") {
		assert.deepEqual(listGrantItems(category.id), []);
	}
}
assert.ok(listGrantItems("consumable").length > 1);
assert.deepEqual(listGrantItems("lockbox").map((item) => item.key), ["1"]);

// Names are optional: a named mount wins, an unnamed one falls back to its id.
assert.equal(mountLabel(81), "Mount #81");
MOUNT_NAMES[81] = "Skybone Wyrm";
assert.equal(mountLabel(81), "Skybone Wyrm");
assert.equal(grantItemLabel("mount", "82"), "Mount #82");
assert.equal(grantItemLabel("dye", "4"), "Legendary dye #4");
DYE_NAMES[4] = "Emberdusk";
assert.equal(grantItemLabel("dye", "4"), "Emberdusk");
assert.equal(grantItemLabel("consumable", "gear"), "Gear potion");
assert.equal(grantItemLabel("gold", undefined), "");
delete MOUNT_NAMES[81];
delete DYE_NAMES[4];

// Durations the command offers all map to a length, and `permanent` is the only null.
for (const choice of BAN_DURATION_CHOICES) {
	const seconds = banDurationSeconds(choice.value);
	if (choice.value === "permanent") assert.equal(seconds, null);
	else assert.ok(typeof seconds === "number" && seconds > 0, `${choice.value} needs a length`);
}
assert.equal(banDurationSeconds("1d"), 86_400);
assert.equal(banDurationSeconds("30d"), 30 * 86_400);
assert.equal(formatBanDuration(null), "permanent");
assert.equal(formatBanDuration(86_400), "1 day");
assert.equal(formatBanDuration(30 * 86_400), "30 days");
assert.equal(formatBanDuration(3_600), "1 hour");

// Balance privacy hinges on these bits: Administrator (8) and Manage Server (32) pass,
// an unrelated permission does not, and a payload without permissions is refused.
assert.equal(canManageGuild({ member: { permissions: "8" } }), true);
assert.equal(canManageGuild({ member: { permissions: "32" } }), true);
assert.equal(canManageGuild({ member: { permissions: "16" } }), false);
assert.equal(canManageGuild({ member: { permissions: null } }), false);
assert.equal(canManageGuild({}), false);
assert.equal(isAdministrator({ member: { permissions: "32" } }), false);
assert.equal(isAdministrator({ member: { permissions: "8" } }), true);

console.log("gameGrant tests passed");
