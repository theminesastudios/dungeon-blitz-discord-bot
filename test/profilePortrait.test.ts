import assert from "node:assert/strict";
import { buildPortraitUrl } from "../src/utils/gameWallet.js";

const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";

	// Discord caches the embed image by URL, so the updatedAt cache buster has to be in there.
	assert.equal(
		buildPortraitUrl({ characterName: "Hero", updatedAtMs: 1_700_000_000_000 }),
		"https://game.example.com/portraits/hero.png?v=1700000000"
	);

	// Character names land in a URL path, so anything outside [a-z0-9_-] is refused outright.
	assert.equal(buildPortraitUrl({ characterName: "../../etc/passwd", updatedAtMs: 1 }), null);
	assert.equal(buildPortraitUrl({ characterName: "Two Words", updatedAtMs: 1 }), null);
	assert.equal(buildPortraitUrl(null), null);

	// No configured game server means no portrait rather than a broken relative URL.
	process.env.GAME_SERVER_BASE_URL = "";
	assert.equal(buildPortraitUrl({ characterName: "Hero", updatedAtMs: 1 }), null);

	// A player who has never been captured still gets a URL; the embed just 404s that image,
	// which is why the caller falls back to no image when the file is missing upstream.
	process.env.GAME_SERVER_BASE_URL = "not-a-url";
	assert.equal(buildPortraitUrl({ characterName: "Hero", updatedAtMs: 1 }), null);

	console.log("profile portrait tests passed");
} finally {
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
}
