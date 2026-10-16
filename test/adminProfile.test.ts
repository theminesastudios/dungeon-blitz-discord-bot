import assert from "node:assert/strict";
import type {
	AccountActivity,
	CharacterProgress,
	GameWalletSummary,
	PlayerProfile,
} from "../src/utils/gameWallet.js";
import { ABILITIES } from "../src/data/abilities.js";
import {
	abilityLines,
	activityLine,
	buildCharacterInspect,
	buildStaffProfile,
	talentLine,
} from "../src/commands/profile.js";

function wallet(index: number, overrides: Partial<GameWalletSummary> = {}): GameWalletSummary {
	return {
		id: "72",
		selector: `saves:72:Hero${index}`,
		source: "saves",
		gameUserId: 72,
		characterName: `Hero${index}`,
		characterClass: "Paladin",
		characterMasterClass: 5,
		characterLevel: 36,
		characterXp: 1_234_567,
		gold: 1_206_149,
		mammothIdols: 8,
		dragonKeys: 0,
		dragonOre: 3_441,
		silverSigils: 1_674,
		royalSigils: 0,
		missions: {},
		updatedAtMs: 0,
		lastPlayedMs: index,
		owner: { discordId: "1", discordUsername: "beytullahs52" },
		...overrides,
	};
}

function profile(wallets: GameWalletSummary[]): PlayerProfile {
	return {
		discordUserId: "1",
		githubUsername: "beytullaheq",
		isSponsor: true,
		sponsorTarget: "theminesastudios",
		isContributor: false,
		wallets,
	};
}

const activity: AccountActivity = {
	playtimeMs: 2 * 86_400_000 + 5 * 3_600_000,
	runs: 120,
	wins: 98,
	kills: 4_512,
	deaths: 33,
	characterPlaytimeMs: { hero1: 3 * 3_600_000 + 5 * 60_000 },
};

/** Every text a container shows, and the raw payload for component checks. */
function render(container: { toJSON(): unknown }) {
	const json = JSON.parse(JSON.stringify(container.toJSON()));
	const texts: string[] = [];
	const components: Array<Record<string, unknown>> = [];
	JSON.parse(JSON.stringify(json), (key, value) => {
		if (key === "content" && typeof value === "string") texts.push(value);
		if (value && typeof value === "object" && "custom_id" in value) components.push(value);
		return value;
	});
	return { text: texts.join("\n"), length: texts.join("").length, components };
}

// Overview: account activity, then every character with level, total XP and its own playtime.
// Sponsor, contributor and credit details are not part of the profile.
const overview = render(buildStaffProfile(profile([wallet(1), wallet(2, { characterXp: 0, characterLevel: 1 })]), activity));
assert.match(overview.text, /GitHub beytullaheq · Game user 72\n-# Played 2d 5h · 120 runs \(98 won\) · 4,512 kills · 33 deaths/);
assert.match(overview.text, /Hero1\*\*\n-# .*Level 36 · 1,234,567 XP · Played 3h 5m · .*Justicar\n/);
// No playtime recorded for a character: the part is left out rather than shown as zero. The
// class is named only when no discipline implies it.
assert.match(overview.text, /Hero2\*\*\n-# .*Level 1 · 0 XP · .*Justicar\n/);
assert.doesNotMatch(overview.text, /Paladin ·/);
const noDiscipline = render(buildStaffProfile(profile([wallet(3, { characterMasterClass: 0 })]))).text;
assert.match(noDiscipline, /XP · Paladin · No discipline yet/);
assert.doesNotMatch(overview.text, /Sponsor|Contributor|Credits/);

// The picker lists each character by its wallet selector.
const picker = overview.components.find((component) => component.custom_id === "admin-profile:inspect");
assert.ok(picker, "the overview has a character picker");
assert.deepEqual(
	(picker.options as Array<{ value: string; label: string }>).map((option) => [option.label, option.value]),
	[
		["Hero2", "saves:72:Hero2"],
		["Hero1", "saves:72:Hero1"],
	],
);

// Without recorded activity the line is simply absent.
assert.equal(activityLine(null), null);
assert.equal(activityLine({ ...activity, playtimeMs: 0, runs: 0, wins: 0, kills: 0, deaths: 0 }), null);
assert.doesNotMatch(render(buildStaffProfile(profile([wallet(1)]))).text, /runs/);

// A save with no characters has nothing to pick.
const empty = render(buildStaffProfile(profile([])));
assert.match(empty.text, /No characters on a live save/);
assert.equal(empty.components.length, 0);

// A full save (the game allows 8 characters) with the longest names, huge numbers and
// playtime on every character still fits in Discord's 4,000-character limit for text.
const longNames = Array.from({ length: 8 }, (_, index) => `${"N".repeat(31)}${index}`);
const full = render(
	buildStaffProfile(
		profile(
			longNames.map((characterName, index) =>
				wallet(index, {
					characterName,
					characterXp: 999_999_999,
					gold: 999_999_999,
					mammothIdols: 999_999,
					dragonKeys: 99_999,
					dragonOre: 999_999,
					silverSigils: 999_999,
					royalSigils: 99_999,
				}),
			),
		),
		{
			...activity,
			playtimeMs: 999 * 86_400_000,
			runs: 999_999,
			wins: 999_999,
			kills: 99_999_999,
			deaths: 999_999,
			characterPlaytimeMs: Object.fromEntries(longNames.map((name) => [name.toLowerCase(), 999 * 86_400_000])),
		},
	),
);
assert.equal(full.text.match(/ XP · Played /g)?.length, 8);
assert.ok(full.length <= 4000, `profile text is ${full.length} characters`);

// Detail view: abilities grouped base class first, then disciplines, with rank out of max.
const justicar: CharacterProgress = {
	wallet: wallet(1, { lastPlayedMs: 1_760_000_000_000 }),
	abilities: [
		{ id: 19, rank: 10 },
		{ id: 22, rank: 4 },
		{ id: 78, rank: 7 },
		{ id: 118, rank: 1 },
		{ id: 9999, rank: 2 },
	],
	activeAbilities: [78, 19],
	talentPoints: { "2": 50, "1": 12 },
};
const lines = abilityLines(justicar);
assert.equal(lines[0], "**Paladin** — Smash **10**/10 · Healing Touch **4**/10");
assert.ok(lines.includes("**Justicar** — Flame Axe **7**/10"), lines.join("\n"));
assert.ok(lines.includes("**Other** — Ability 9999 **2**"), "an unknown id still shows");
assert.ok(!lines.join("\n").includes("Sword Melee"), "the basic melee is not an ability to upgrade");
assert.equal(lines.at(-1), "-# Hotbar: Flame Axe, Smash");
assert.deepEqual(abilityLines({ ...justicar, abilities: [], activeAbilities: [] }), ["-# No abilities learned."]);

// Talent keys "1".."3" are the base class's three disciplines, in MasterClassID order.
assert.equal(talentLine(justicar), "Sentinel 12/50 · Justicar 50/50 · Templar 0/50");
assert.equal(
	talentLine({ ...justicar, wallet: wallet(1, { characterClass: "Mage" }), talentPoints: { "3": 9 } }),
	"Frostwarden 0/50 · Flameseer 0/50 · Necromancer 9/50",
);

const inspect = render(buildCharacterInspect(justicar, activity));
assert.match(inspect.text, /## .* Hero1\n-# .*Level 36 · 1,234,567 XP · Played 3h 5m · Paladin/);
assert.match(inspect.text, /Game user 72 · <@1> · Last played <t:1760000000:R>/);
assert.match(inspect.text, /### Class Tower talent points\nSentinel 12\/50/);
assert.ok(inspect.components.some((component) => component.custom_id === "admin-profile:back:1"));

// Every ability a Paladin can learn, at max rank, still fits.
const everything: CharacterProgress = {
	...justicar,
	wallet: wallet(1, { characterName: "N".repeat(32) }),
	abilities: Object.entries(ABILITIES)
		.filter(([, info]) => ["Paladin", "Sentinel", "Justicar", "Templar"].includes(info.className))
		.map(([id, info]) => ({ id: Number(id), rank: info.maxRank })),
	activeAbilities: [108, 109, 110],
};
assert.equal(everything.abilities.length, 39);
const maxed = render(buildCharacterInspect(everything, activity));
assert.ok(maxed.length <= 4000, `inspect text is ${maxed.length} characters`);

console.log("adminProfile.test: ok");
