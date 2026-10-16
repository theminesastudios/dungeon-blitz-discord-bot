import assert from "node:assert/strict";
import type { GameWalletSummary, PlayerProfile } from "../src/utils/gameWallet.js";
import { buildStaffProfile } from "../src/commands/profile.js";

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

function texts(container: ReturnType<typeof buildStaffProfile>): string[] {
	const found: string[] = [];
	JSON.parse(JSON.stringify(container.toJSON()), (key, value) => {
		if (key === "content" && typeof value === "string") found.push(value);
		return value;
	});
	return found;
}

// Every character is listed with its level and total experience; sponsor, contributor and
// credit details are not part of the profile.
const two = texts(buildStaffProfile(profile([wallet(1), wallet(2, { characterXp: 0, characterLevel: 1 })])));
const all = two.join("\n");
assert.match(all, /Hero1\*\*\n-# .*Level 36 · 1,234,567 XP · Paladin/);
assert.match(all, /Hero2\*\*\n-# .*Level 1 · 0 XP · Paladin/);
assert.doesNotMatch(all, /Sponsor|Contributor|Credits/);
assert.match(all, /GitHub beytullaheq · Game user 72/);

// A full save (the game allows 8 characters) with the longest names still fits in Discord's
// 4,000-character limit for a message's text.
const full = texts(
	buildStaffProfile(
		profile(
			Array.from({ length: 8 }, (_, index) =>
				wallet(index, {
					characterName: `${"N".repeat(31)}${index}`,
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
	),
);
assert.equal(full.filter((line) => line.includes(" XP · ")).length, 8);
assert.ok(full.join("").length <= 4000, `profile text is ${full.join("").length} characters`);

console.log("adminProfile.test: ok");
