import assert from "node:assert/strict";
import {
	checkLobbyChatChannel,
	parseLobbyChatArgument,
	parseLobbyChatState,
	fetchGameLobbyChat,
	setGameLobbyChat,
} from "../src/utils/gameLobbyChat.js";
import {
	buildLobbyChatStateEmbed,
	formatLinkedChannelTimestamp,
} from "../src/commands/lobby-chat.js";

/*
 * Two things are worth pinning here, because both fail silently from Discord's
 * side: the option has to be read the way an administrator actually types it
 * (a `#channel` mention, a pasted id, or `none`), and a channel id has to be
 * checked with Discord before the game is told to bridge lobby chat into it.
 * The game-server call itself is asserted so the setting really is pushed, not
 * just remembered by the bot.
 */

// The option: mentions, raw ids, the clearing words, and the empty read.
assert.deepEqual(parseLobbyChatArgument(null), { kind: "show" });
assert.deepEqual(parseLobbyChatArgument(""), { kind: "show" });
assert.deepEqual(parseLobbyChatArgument("  "), { kind: "show" });
assert.deepEqual(parseLobbyChatArgument("<#1551118889503432765>"), {
	kind: "channel",
	channelId: "1551118889503432765",
});
assert.deepEqual(parseLobbyChatArgument("1551118889503432765"), {
	kind: "channel",
	channelId: "1551118889503432765",
});
assert.deepEqual(parseLobbyChatArgument("none"), { kind: "clear" });
assert.deepEqual(parseLobbyChatArgument("NONE"), { kind: "clear" });
assert.deepEqual(parseLobbyChatArgument("off"), { kind: "clear" });
assert.deepEqual(parseLobbyChatArgument("#lobby"), { kind: "invalid" });
assert.deepEqual(parseLobbyChatArgument("<#123>"), { kind: "invalid" });

// The game server answers in its own shape; only a real snowflake is a channel.
assert.deepEqual(
	parseLobbyChatState({
		guild_id: "880000000000000001",
		channel_id: "1551118889503432765",
		channel_name: "lobby-chat",
		updated_at: "2026-09-30T10:00:00.000Z",
		requestedBy: "admin (<@1>)",
	}),
	{
		guildId: "880000000000000001",
		channelId: "1551118889503432765",
		channelName: "lobby-chat",
		updatedAt: "2026-09-30T10:00:00.000Z",
		updatedBy: "admin (<@1>)",
	},
);
assert.deepEqual(parseLobbyChatState({ channelId: "not-a-channel" }).channelId, null);
assert.deepEqual(parseLobbyChatState(null), {
	guildId: null,
	channelId: null,
	channelName: null,
	updatedAt: null,
	updatedBy: null,
});

// The reply panel is what an administrator reads, linked or not.
const linkedEmbed = buildLobbyChatStateEmbed(
	parseLobbyChatState({ channelId: "1551118889503432765", channelName: "lobby-chat" }),
	{ title: "✅ Lobby chat channel linked" },
);
assert.equal(linkedEmbed.title, "✅ Lobby chat channel linked");
assert.match(String(linkedEmbed.fields[0].value), /<#1551118889503432765>/);
assert.match(String(linkedEmbed.fields[0].value), /lobby-chat/);
const unlinkedEmbed = buildLobbyChatStateEmbed(parseLobbyChatState({}));
assert.match(String(unlinkedEmbed.fields[0].value), /Not linked/);
assert.equal(String(unlinkedEmbed.fields[3].value), "Never");
assert.equal(
	formatLinkedChannelTimestamp("2026-09-30T10:00:00.000Z"),
	`<t:${Math.floor(Date.parse("2026-09-30T10:00:00.000Z") / 1000)}:f>`,
);
assert.equal(formatLinkedChannelTimestamp(null), "Never");

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
const originalBotToken = process.env.DISCORD_BOT_TOKEN;

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
	process.env.DISCORD_BOT_TOKEN = "bot-token";

	let gameUrl = "";
	let gameAuthorization = "";
	let gameBody = "";
	globalThis.fetch = async (input, init) => {
		gameUrl = String(input);
		gameAuthorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
		gameBody = String(init?.body ?? "");
		return new Response(
			JSON.stringify({
				ok: true,
				guildId: "880000000000000001",
				channelId: JSON.parse(gameBody || "{}").channelId ?? null,
				channelName: "lobby-chat",
				updatedAt: "2026-09-30T10:00:00.000Z",
				updatedBy: "admin (<@1>)",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const set = await setGameLobbyChat({
		guildId: "880000000000000001",
		channelId: "1551118889503432765",
		channelName: "lobby-chat",
		requestedBy: "admin (<@1>)",
	});
	assert.equal(gameUrl, "https://game.example.com/api/admin/lobby-chat");
	assert.equal(gameAuthorization, "Bearer test-secret");
	assert.deepEqual(JSON.parse(gameBody), {
		guildId: "880000000000000001",
		channelId: "1551118889503432765",
		channelName: "lobby-chat",
		requestedBy: "admin (<@1>)",
	});
	assert.equal(set.channelId, "1551118889503432765");

	const read = await fetchGameLobbyChat();
	assert.equal(gameUrl, "https://game.example.com/api/admin/lobby-chat");
	assert.equal(read.channelName, "lobby-chat");

	const cleared = await setGameLobbyChat({ guildId: null, channelId: null });
	assert.deepEqual(JSON.parse(gameBody), {
		guildId: null,
		channelId: null,
		channelName: null,
		requestedBy: null,
	});
	// Whatever the game server stores is what the panel then shows.
	assert.equal(cleared.channelId, null);
	assert.equal(cleared.channelName, "lobby-chat");

	// Discord is asked about the channel before the game is, and a text channel in the
	// right guild is the only one that can be linked.
	let discordRequest = "";
	globalThis.fetch = async (input, init) => {
		discordRequest = String(input);
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bot bot-token");
		return new Response(
			JSON.stringify({
				id: "1551118889503432765",
				name: "lobby-chat",
				type: 0,
				guild_id: "880000000000000001",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	const checked = await checkLobbyChatChannel("1551118889503432765", {
		guildId: "880000000000000001",
	});
	assert.equal(discordRequest, "https://discord.com/api/v10/channels/1551118889503432765");
	assert.deepEqual(checked, {
		ok: true,
		channelId: "1551118889503432765",
		channelName: "lobby-chat",
		guildId: "880000000000000001",
	});

	// A channel in another server is refused: the game is linked to one guild's lobby chat.
	const wrongGuild = await checkLobbyChatChannel("1551118889503432765", {
		guildId: "990000000000000002",
	});
	assert.equal(wrongGuild.ok, false);
	assert.match(wrongGuild.ok ? "" : wrongGuild.reason, /different server/);

	// A voice channel cannot carry lobby chat.
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ id: "1551118889503432765", name: "Lounge", type: 2, guild_id: "880000000000000001" }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	const voice = await checkLobbyChatChannel("1551118889503432765", {
		guildId: "880000000000000001",
	});
	assert.equal(voice.ok, false);
	assert.match(voice.ok ? "" : voice.reason, /not a text channel/);

	// A channel the bot cannot see answers 404, which is reported as such rather than as a typo.
	globalThis.fetch = async () => new Response("{}", { status: 404 });
	const hidden = await checkLobbyChatChannel("1551118889503432765", {
		guildId: "880000000000000001",
	});
	assert.equal(hidden.ok, false);
	assert.match(hidden.ok ? "" : hidden.reason, /did not return that channel/);

	// A game server that refuses the change is surfaced with its own wording.
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: "unknown route" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	let refusal = "";
	try {
		await setGameLobbyChat({ guildId: null, channelId: "1551118889503432765" });
	} catch (error) {
		refusal = error instanceof Error ? error.message : String(error);
	}
	assert.match(refusal, /Game server rejected the linked lobby chat channel \(404\)/);
	assert.match(refusal, /unknown route/);
} finally {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
	if (originalBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
	else process.env.DISCORD_BOT_TOKEN = originalBotToken;
}
