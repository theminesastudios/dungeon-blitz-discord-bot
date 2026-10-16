import assert from "node:assert/strict";
import {
	findGameWallet,
	findLiveCharacter,
	getPlayerProfile,
	searchGameWallets,
	searchPlayers,
	setWalletCollectionsForTests,
} from "../src/utils/gameWallet.js";

/**
 * Every lookup must return only live characters: on a current save, owned by an account that
 * a Discord user is linked to. The old Accounts.json test accounts have saves but no
 * `discordId`, and must never surface — not in pickers, not on `/player`, not on profiles.
 */

type Doc = Record<string, unknown>;

/** Values at a dotted path, flattening arrays the way MongoDB does (`characters.name`). */
function valuesAt(doc: unknown, path: string[]): unknown[] {
	if (path.length === 0) return [doc];
	if (Array.isArray(doc)) {
		const [head, ...rest] = path;
		if (/^\d+$/.test(head)) return valuesAt(doc[Number(head)], rest);
		return doc.flatMap((item) => valuesAt(item, path));
	}
	if (!doc || typeof doc !== "object") return [];
	const [head, ...rest] = path;
	if (!(head in (doc as Doc))) return [];
	return valuesAt((doc as Doc)[head], rest);
}

/** The filter subset the wallet queries use: $or/$and, $regex, $in, $type, $ne, $exists. */
function matches(doc: Doc, filter: Doc): boolean {
	return Object.entries(filter).every(([key, condition]) => {
		if (key === "$or") return (condition as Doc[]).some((sub) => matches(doc, sub));
		if (key === "$and") return (condition as Doc[]).every((sub) => matches(doc, sub));
		const values = valuesAt(doc, key.split("."));
		if (condition instanceof RegExp) return values.some((v) => condition.test(String(v)));
		if (condition && typeof condition === "object" && !Array.isArray(condition)) {
			const ops = condition as Doc;
			if ("$exists" in ops) return (values.length > 0 && values[0] !== undefined) === ops.$exists;
			return Object.entries(ops).every(([op, arg]) => {
				switch (op) {
					case "$regex":
						return values.some((v) => new RegExp(String(arg), String(ops.$options ?? "")).test(String(v)));
					case "$options":
						return true;
					case "$in":
						return values.some((v) => (arg as unknown[]).includes(v));
					case "$type":
						return values.some((v) => typeof v === arg);
					case "$ne":
						return values.every((v) => v !== arg);
					default:
						throw new Error(`fake collection does not support ${op}`);
				}
			});
		}
		return values.some((v) => v === condition);
	});
}

function collection(docs: Doc[]) {
	const cursor = (rows: Doc[]) => ({
		sort: (spec: Record<string, 1 | -1>) => {
			const [[field, dir]] = Object.entries(spec);
			const sorted = [...rows].sort(
				(a, b) => (Number(a[field] instanceof Date ? (a[field] as Date).getTime() : 0) -
					Number(b[field] instanceof Date ? (b[field] as Date).getTime() : 0)) * dir,
			);
			return cursor(sorted);
		},
		limit: (count: number) => cursor(rows.slice(0, count)),
		toArray: async () => rows,
	});
	return {
		find: (filter: Doc = {}) => cursor(docs.filter((doc) => matches(doc, filter))),
		findOne: async (filter: Doc = {}) => docs.find((doc) => matches(doc, filter)) ?? null,
	};
}

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

setWalletCollectionsForTests({
	saves: collection([
		{
			_id: "14",
			user_id: 14,
			updatedAt: day(9),
			characters: [
				{ name: "MaxMage", class: "Mage", level: 50, xp: 2_345_678, MasterClass: 8, gold: 900, mammothIdols: 700 },
				{ name: "NewRogue", class: "Rogue", level: 3, gold: 5, mammothIdols: 700 },
			],
		},
		{
			_id: "20",
			user_id: 20,
			updatedAt: day(8),
			characters: [{ name: "Maxine", class: "Paladin", level: 12, gold: 40 }],
		},
		// Old Accounts.json test account: a save, an account, but nobody on Discord owns it.
		{
			_id: "1",
			user_id: 1,
			updatedAt: day(10),
			characters: [{ name: "MaxTester", class: "Mage", level: 50, gold: 999_999 }],
		},
		// A save with no account at all.
		{ _id: "77", user_id: 77, updatedAt: day(7), characters: [{ name: "MaxOrphan", level: 1 }] },
	]),
	accounts: collection([
		{ _id: "user:14", user_id: 14, discordId: "111", discordUsername: "neo" },
		{ _id: "user:20", user_id: 20, discordId: "222", discordUsername: "" },
		{ _id: "user:1", user_id: 1, email: "test@example.com" },
	]),
	profiles: collection([
		{ _id: "111", userId: "111", githubUsername: "neodevils", isSponsor: true },
		{ _id: "999", userId: "999", githubUsername: "stale-snapshot" },
	]),
});

try {
	// Empty search: recent live characters only, test and orphan saves left out.
	const recent = await searchGameWallets("");
	assert.deepEqual(recent.map((c) => c.characterName).sort(), ["MaxMage", "Maxine", "NewRogue"]);
	assert.ok(recent.every((c) => c.owner), "every result carries its owner");

	// Name search: exact/prefix ranking, and still no unlinked characters.
	assert.deepEqual((await searchGameWallets("max")).map((c) => c.characterName), ["MaxMage", "Maxine"]);
	assert.deepEqual((await searchGameWallets("maxine")).map((c) => c.characterName), ["Maxine"]);

	// Discord username and game user id pull the owner's whole roster.
	assert.deepEqual((await searchGameWallets("neo")).map((c) => c.characterName), ["MaxMage", "NewRogue"]);
	assert.deepEqual((await searchGameWallets("20")).map((c) => c.characterName), ["Maxine"]);

	// /player: case-insensitive exact name, never a test account.
	const found = await findLiveCharacter("maxmage");
	assert.equal(found?.characterName, "MaxMage");
	assert.equal(found?.characterMasterClass, 8);
	assert.deepEqual(found?.owner, { discordId: "111", discordUsername: "neo" });
	assert.equal(await findLiveCharacter("MaxTester"), null);
	assert.equal(await findLiveCharacter("MaxOrphan"), null);
	assert.equal(await findLiveCharacter("Max"), null, "no partial matches");

	// Staff pickers: one row per Discord user with their live roster.
	const players = await searchPlayers("max");
	assert.deepEqual(players, [
		{ selector: "profile:111", label: "@neo · MaxMage Lv 50" },
		{ selector: "profile:222", label: "Discord 222 · Maxine Lv 12" },
	]);
	// GitHub usernames still find a player, but only one with a live account.
	assert.deepEqual(await searchPlayers("neodev"), [
		{ selector: "profile:111", label: "@neo · MaxMage Lv 50, NewRogue Lv 3" },
	]);
	assert.deepEqual(await searchPlayers("stale-snapshot"), []);

	// Profiles resolve characters through the game account, not by GitHub-named wallets.
	const profile = await getPlayerProfile("profile:111");
	assert.equal(profile?.githubUsername, "neodevils");
	assert.deepEqual(profile?.wallets.map((w) => w.characterName), ["MaxMage", "NewRogue"]);
	// The save's total experience comes through; a character with no `xp` field reads as 0.
	assert.deepEqual(profile?.wallets.map((w) => w.characterXp), [2_345_678, 0]);
	const byWallet = await getPlayerProfile("wallet:saves:20:Maxine");
	assert.equal(byWallet?.discordUserId, "222");
	// A sponsor profile without a game account keeps its sponsor data (shop credit needs it) and no characters.
	const sponsorOnly = await getPlayerProfile("profile:999");
	assert.equal(sponsorOnly?.githubUsername, "stale-snapshot");
	assert.deepEqual(sponsorOnly?.wallets, []);
	assert.equal(await getPlayerProfile("profile:404"), null);

	// Wallet selectors keep working for the idol tools.
	assert.equal((await findGameWallet("saves:14:NewRogue"))?.characterLevel, 3);

	console.log("liveCharacters.test: ok");
} finally {
	setWalletCollectionsForTests(null);
}
