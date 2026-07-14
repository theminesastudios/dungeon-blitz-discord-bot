import assert from "node:assert/strict";
import { getVerifiedDiscordOAuthUser } from "../src/utils/discordOAuthUser.js";

const originalFetch = globalThis.fetch;

try {
	let requestedUrl = "";
	let authorization = "";
	globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
		return new Response(JSON.stringify({
			id: "123",
			username: "player",
			global_name: "Player",
			email: "player@example.com",
			verified: true,
			avatar: "avatar-hash",
		}), { status: 200, headers: { "content-type": "application/json" } });
	};

	const user = await getVerifiedDiscordOAuthUser("oauth-token");
	assert.equal(requestedUrl, "https://discord.com/api/v10/users/@me");
	assert.equal(authorization, "Bearer oauth-token");
	assert.equal(user.email, "player@example.com");
	assert.equal(user.verified, true);

	globalThis.fetch = async () => new Response(JSON.stringify({
		id: "123",
		username: "player",
		email: null,
	}), { status: 200, headers: { "content-type": "application/json" } });
	const missingEmail = await getVerifiedDiscordOAuthUser("oauth-token");
	assert.equal(missingEmail.email, null);
	assert.equal(missingEmail.verified, false);

	console.log("discordOAuthUser.test: ok");
} finally {
	globalThis.fetch = originalFetch;
}
