import assert from "node:assert/strict";
import type { GameWalletSummary } from "../src/utils/gameWallet.js";
import type { PublicGameAccount } from "../src/utils/gameAccount.js";

// account.ts loads the OAuth config at import time, which refuses to start without these.
process.env.DISCORD_APPLICATION_ID ||= "1";
process.env.DISCORD_CLIENT_SECRET ||= "test-secret";

const {
	ACCOUNT_IDS,
	buildCharacterDetail,
	buildDashboard,
	buildDeleteConfirm,
	buildRenameConfirm,
	customIdNames,
	pickCurrentCharacter,
} = await import("../src/commands/account.js");
const { buildPlayerCard } = await import("../src/commands/player.js");
const { currentQuest, formatQuest } = await import("../src/utils/characterDisplay.js");
const { formatCharacterLabel } = await import("../src/utils/gameWallet.js");

function character(overrides: Partial<GameWalletSummary>): GameWalletSummary {
	return {
		id: "14",
		selector: "saves:14:Hero",
		source: "saves",
		gameUserId: 14,
		characterName: "Hero",
		characterClass: "Mage",
		characterMasterClass: 8,
		characterLevel: 50,
		characterXp: 0,
		gold: 12_345,
		mammothIdols: 700,
		dragonKeys: 3,
		dragonOre: 10,
		silverSigils: 0,
		royalSigils: 1,
		missions: {},
		updatedAtMs: 0,
		lastPlayedMs: 0,
		owner: { discordId: "1", discordUsername: "neo" },
		...overrides,
	};
}

const account: PublicGameAccount = {
	email: "hero@example.com",
	userId: 14,
	discordId: "1",
	passwordConfigured: true,
	connections: [],
	widgetState: null,
	playtimeMs: 3_600_000,
	characterPlaytimeMs: {},
};

/** Every string in a serialized payload, for "does it say X" checks. */
function texts(value: unknown): string {
	return JSON.stringify(value);
}

function customIds(value: unknown): string[] {
	const ids: string[] = [];
	JSON.stringify(value, (key, entry) => {
		if (key === "custom_id") ids.push(entry);
		return entry;
	});
	return ids;
}

// The current character is the one played last, not the highest level.
const veteran = character({ characterName: "Veteran", characterLevel: 50, lastPlayedMs: 1_000 });
const fresh = character({ characterName: "Fresh", characterLevel: 3, characterClass: "Rogue", lastPlayedMs: 9_000 });
assert.equal(pickCurrentCharacter([veteran, fresh])?.characterName, "Fresh");
assert.equal(pickCurrentCharacter([veteran, character({ characterName: "Low", characterLevel: 2 })])?.characterName, "Veteran");
assert.equal(pickCurrentCharacter([]), null);

// Dashboard: one View button per character, settings as buttons, discipline in the -# line.
const dashboard = buildDashboard({ account, characters: [veteran, fresh], notices: true }, "Neo").toJSON();
const dashboardIds = customIds(dashboard);
assert.ok(dashboardIds.includes(`${ACCOUNT_IDS.view}Veteran`));
assert.ok(dashboardIds.includes(`${ACCOUNT_IDS.view}Fresh`));
assert.ok(dashboardIds.includes(`${ACCOUNT_IDS.password}reset`));
assert.ok(dashboardIds.includes(ACCOUNT_IDS.notifications));
assert.match(texts(dashboard), /Upgrade DMs: On/);
assert.match(texts(dashboard), /-# .*Level 50 .*Mage .*Flameseer/);
assert.match(texts(dashboard), /No discipline yet|Flameseer/);

const noPassword = buildDashboard(
	{ account: { ...account, passwordConfigured: false }, characters: [], notices: false },
	"Neo",
).toJSON();
assert.ok(customIds(noPassword).includes(`${ACCOUNT_IDS.password}initial`));
assert.match(texts(noPassword), /Upgrade DMs: Off/);
assert.match(texts(noPassword), /No characters yet/);

// Character detail offers Back, Rename and Delete for that character only.
const detailIds = customIds(buildCharacterDetail({ account, characters: [veteran], notices: true }, veteran).toJSON());
assert.deepEqual(detailIds, [ACCOUNT_IDS.home, `${ACCOUNT_IDS.rename}Veteran`, `${ACCOUNT_IDS.delete}Veteran`]);

// Rename confirm carries both names, and is disabled when the account cannot pay.
const renameJson = buildRenameConfirm(veteran, "NewHero", 700).toJSON();
const [renameId] = customIds(renameJson);
assert.deepEqual(customIdNames(renameId, ACCOUNT_IDS.renameConfirm), ["Veteran", "NewHero"]);
assert.doesNotMatch(texts(renameJson), /"disabled":true/);
assert.match(texts(buildRenameConfirm(veteran, "NewHero", 499).toJSON()), /"disabled":true/);

// A name with a separator in it survives the custom id round trip.
const odd = character({ characterName: "a:b" });
const [deleteId] = customIds(buildDeleteConfirm(odd).toJSON());
assert.deepEqual(customIdNames(deleteId, ACCOUNT_IDS.deleteConfirm), ["a:b"]);

// Current quest: the story quest leads, and a finished objective shows its turn-in text.
assert.equal(currentQuest({}), null);
assert.equal(formatQuest(null), "No active quest");
assert.equal(currentQuest({ "1": 3 }), null, "claimed missions are not on the tracker");
const quest = currentQuest({ "1": 1 });
assert.equal(quest?.name, "Goblin Assault");
assert.match(formatQuest(quest), /\*\*Goblin Assault\*\* — Defend the Niobe/);
assert.match(formatQuest(currentQuest({ "1": 2 })), /Captain Fink/);
const storyFirst = currentQuest({ "1": 1, "6": 1 });
assert.equal(storyFirst?.id, 6, "the higher-level story quest wins");

// The public card shows level, gold and quest — never idols or other balances.
const card = texts(buildPlayerCard(character({ missions: { "1": 1 } })).toJSON());
assert.match(card, /Level 50/);
assert.match(card, /12,345/);
assert.match(card, /Goblin Assault/);
assert.doesNotMatch(card, /Idol|Dragon|Sigil|neo/);

// Picker rows name the owner next to the character.
assert.equal(formatCharacterLabel(veteran), "Veteran · Lv 50 Mage — @neo");
assert.equal(
	formatCharacterLabel(character({ owner: { discordId: "42", discordUsername: "" } })),
	"Hero · Lv 50 Mage — Discord 42",
);

console.log("accountPanel.test: ok");
