import assert from "node:assert/strict";
import {
	characterPlaytimeKey,
	formatCharacterPlaytimeLines,
	formatPlaytime,
} from "../src/utils/playtime.js";

// The same key the game server writes (characterPlaytimeKey in its Database.ts).
assert.equal(characterPlaytimeKey(" Tela.Hair$ "), "tela%2Ehair%24");
assert.equal(characterPlaytimeKey("100%"), "100%25");

assert.equal(formatPlaytime(undefined), "—");
assert.equal(formatPlaytime(0), "—");
assert.equal(formatPlaytime(2 * 3_600_000 + 15 * 60_000), "2h 15m");
assert.equal(formatPlaytime(3 * 86_400_000 + 4 * 3_600_000), "3d 4h");

const characters = [
	{ characterName: "Telahair", characterClass: "mage", characterLevel: 50 },
	{ characterName: "Alt", characterClass: "rogue", characterLevel: 12 },
];
assert.equal(
	formatCharacterPlaytimeLines(characters, { telahair: 90 * 60_000 }),
	"**Telahair** · Lv 50 mage — 1h 30m\n**Alt** · Lv 12 rogue — —",
);
assert.equal(formatCharacterPlaytimeLines([], {}), "No characters yet.");

const many = Array.from({ length: 60 }, (_, index) => ({
	characterName: `Character${index}`,
	characterClass: "paladin",
	characterLevel: 50,
}));
const capped = formatCharacterPlaytimeLines(many, {});
assert.ok(capped.length <= 1024, "a field stays within Discord's limit");
assert.match(capped, /…and \d+ more$/);

console.log("playtime: ok");
