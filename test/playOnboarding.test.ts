import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GAME_PLAY_URL, DISCORD_LOGIN_HINT, renderGamePlayLink } from "../src/utils/gamePlay.js";

process.env.DISCORD_APPLICATION_ID ||= "1";
process.env.DISCORD_CLIENT_SECRET ||= "test-secret";

const { buildPasswordSuccess } = await import("../src/commands/account.js");

for (const initial of [true, false]) {
	const payload = buildPasswordSuccess("player@example.com", initial).toJSON();
	const serialized = JSON.stringify(payload);
	assert.match(serialized, initial ? /Password set/ : /Password reset/);
	assert.ok(serialized.includes(DISCORD_LOGIN_HINT));
	const row = payload.components.at(-1) as { components: Array<{ style: number; label: string; url: string }> };
	assert.equal(row.components[0].style, 5);
	assert.equal(row.components[0].label, "Play in browser");
	assert.equal(row.components[0].url, GAME_PLAY_URL);
}

const callback = readFileSync(new URL("../api/discord-oauth-callback.ts", import.meta.url), "utf8");
assert.match(callback, /showPlayLink = false/);
assert.match(callback, /renderGamePlayLink\(showPlayLink\)/);
assert.match(callback, /message,\s+true\s+\);/);
assert.equal(renderGamePlayLink(false), "");
assert.ok(renderGamePlayLink(true).includes(`href="${GAME_PLAY_URL}"`));
assert.ok(renderGamePlayLink(true).includes(">Play in browser</a>"));
assert.ok(renderGamePlayLink(true).includes(DISCORD_LOGIN_HINT));

console.log("playOnboarding.test: ok");
