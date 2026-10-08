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
	handleLobbyChat,
} from "../src/commands/lobby-chat.js";

/*
 * What is worth pinning here: the option has to be read the way an administrator
 * actually types it (a `#channel` mention, a pasted id, or `none`); a channel
 * Discord cannot link is refused before the game server is asked; and the reply
 * only says lobby chat moved when the game server answered 200. A 409/502 names
 * the channel lobby chat is still in, and a timeout claims neither outcome.
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

const GUILD_ID = "880000000000000001";
const NEW_CHANNEL = "1551118889503432765";
const OLD_CHANNEL = "1440000000000000009";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
const originalBotToken = process.env.DISCORD_BOT_TOKEN;

type Embed = {
	title?: string;
	description?: string;
	fields?: { name: string; value: string }[];
	footer?: { text: string };
};

type GameAnswer = { status: number; body?: unknown } | "timeout";

/**
 * Runs the real handler with a fake interaction. Discord's channel read answers
 * with `channel`; the game server answers with `game`. Every request is recorded
 * in order, alongside the defer, so the test can see what reached which service.
 */
async function runLobbyChat(
	option: string | null,
	channel: Record<string, unknown> | null,
	game: GameAnswer,
) {
	const events: string[] = [];
	const gameRequests: { authorization: string; body: string }[] = [];
	const timeouts: number[] = [];
	let edited: { embeds?: Embed[] } | null = null;

	AbortSignal.timeout = (ms: number) => {
		timeouts.push(ms);
		return originalTimeout.call(AbortSignal, ms);
	};
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.startsWith("https://discord.com/api/v10/channels/")) {
			events.push("discord:channel");
			return new Response(JSON.stringify(channel), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		assert.equal(url, "https://game.example.com/api/admin/lobby-chat");
		events.push(`game:${init?.method ?? "GET"}`);
		gameRequests.push({
			authorization: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
			body: String(init?.body ?? ""),
		});
		if (game === "timeout") {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		}
		return new Response(game.body === undefined ? "" : JSON.stringify(game.body), {
			status: game.status,
			headers: { "content-type": "application/json" },
		});
	};

	const interaction = {
		guild_id: GUILD_ID,
		member: { permissions: "8", nick: null, user: { id: "1", username: "admin" } },
		options: { getString: () => option },
		reply: async () => {
			events.push("reply");
		},
		deferReply: async (payload: { flags?: number }) => {
			assert.equal(payload.flags, 64, "the deferred reply is ephemeral");
			events.push("defer");
		},
		editReply: async (payload: { embeds?: Embed[] }) => {
			edited = payload;
		},
	};
	try {
		await handleLobbyChat(interaction as never);
	} finally {
		AbortSignal.timeout = originalTimeout;
	}
	const embed = (edited as { embeds?: Embed[] } | null)?.embeds?.[0] ?? {};
	const text = [
		embed.title,
		embed.description,
		...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
	].join("\n");
	return { events, gameRequests, timeouts, embed, text };
}

const textChannel = { id: NEW_CHANNEL, name: "lobby-chat", type: 0, guild_id: GUILD_ID };

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
	process.env.DISCORD_BOT_TOKEN = "bot-token";

	// 200: the server linked the lobby. The reply shows the channel the server
	// returned, and the request is the same shape as before, with a string id.
	{
		const run = await runLobbyChat(`<#${NEW_CHANNEL}>`, textChannel, {
			status: 200,
			body: {
				guildId: GUILD_ID,
				channelId: NEW_CHANNEL,
				channelName: "lobby-chat-from-server",
				updatedAt: "2026-10-08T10:00:00.000Z",
				updatedBy: "admin (<@1>)",
			},
		});
		assert.deepEqual(run.events, ["defer", "discord:channel", "game:POST"]);
		assert.equal(run.gameRequests.length, 1);
		assert.equal(run.gameRequests[0].authorization, "Bearer test-secret");
		const body = JSON.parse(run.gameRequests[0].body);
		assert.deepEqual(body, {
			guildId: GUILD_ID,
			channelId: NEW_CHANNEL,
			channelName: "lobby-chat",
			requestedBy: "<@1>",
		});
		assert.equal(typeof body.channelId, "string");
		assert.ok(
			run.timeouts.some((ms) => ms >= 20_000),
			`the POST waits at least 20 s (timeouts: ${run.timeouts.join(", ")})`,
		);
		assert.match(run.embed.title ?? "", /moved/);
		assert.equal(
			run.embed.description,
			`Lobby linked to <#${NEW_CHANNEL}>. Players now speak there as themselves through the game.`,
		);
		assert.match(run.text, /lobby-chat-from-server/);
	}

	// `none` sends channelId: null and reports the server's answer as the move.
	{
		const run = await runLobbyChat("none", null, {
			status: 200,
			body: { guildId: GUILD_ID, channelId: OLD_CHANNEL, channelName: "general" },
		});
		assert.deepEqual(run.events, ["defer", "game:POST"]);
		assert.equal(JSON.parse(run.gameRequests[0].body).channelId, null);
		assert.match(run.text, new RegExp(`Lobby linked to <#${OLD_CHANNEL}>`));
	}

	// 409: nothing moved. The server's error is shown as sent, the old channel is
	// named, the setup hint is given, and the request is not retried.
	{
		const error = "No Discord lobby is set up on the server (no saved CanLinkLobby sign-in).";
		const run = await runLobbyChat(NEW_CHANNEL, textChannel, {
			status: 409,
			body: { guildId: GUILD_ID, channelId: OLD_CHANNEL, channelName: "general", error },
		});
		assert.equal(run.gameRequests.length, 1);
		assert.match(run.embed.title ?? "", /not moved/);
		assert.ok(run.text.includes(error), "the server's error text is shown verbatim");
		const stillIn = run.embed.fields?.find((field) => /still in/.test(field.name));
		assert.match(stillIn?.value ?? "", new RegExp(`<#${OLD_CHANNEL}>`));
		assert.ok(
			run.text.includes(
				"A server admin must run `node --env-file=.env tools/linkedDiscordLobby.js link --lobby <lobbyId>` on the game server once.",
			),
		);
		assert.doesNotMatch(run.text, /Lobby linked to/);
		assert.doesNotMatch(run.text, new RegExp(`<#${NEW_CHANNEL}>`));
	}

	// 502: Discord refused the link; the error and the Discord hint are shown.
	{
		const error = "Discord refused to link the lobby: 403 Missing Permissions";
		const run = await runLobbyChat(NEW_CHANNEL, textChannel, {
			status: 502,
			body: { guildId: GUILD_ID, channelId: OLD_CHANNEL, channelName: "general", error },
		});
		assert.equal(run.gameRequests.length, 1);
		assert.match(run.embed.title ?? "", /not moved/);
		assert.ok(run.text.includes(error));
		assert.match(run.text, new RegExp(`<#${OLD_CHANNEL}>`));
		assert.match(run.text, /Discord refused the link\. Check that the channel is a normal/);
		assert.match(run.text, /View Channel, Send Messages and Manage Channels/);
		assert.doesNotMatch(run.text, /Lobby linked to/);
	}

	// A failure without state (429 here) still says it failed, and does not
	// invent a channel: it points at the read instead.
	{
		const run = await runLobbyChat(NEW_CHANNEL, textChannel, {
			status: 429,
			body: { error: "Too many lobby-chat changes; try again later." },
		});
		assert.match(run.embed.title ?? "", /not moved/);
		assert.ok(run.text.includes("Too many lobby-chat changes; try again later."));
		assert.match(run.text, /Unchanged/);
		assert.doesNotMatch(run.text, /Lobby linked to|linkedDiscordLobby/);
	}

	// Timeout: the outcome is unknown, and the reply says so without claiming either.
	{
		const run = await runLobbyChat(NEW_CHANNEL, textChannel, "timeout");
		assert.equal(run.gameRequests.length, 1);
		assert.match(run.embed.title ?? "", /unknown/);
		assert.match(run.text, /`\/admin lobby-chat` with no channel/);
		assert.doesNotMatch(run.text, /Lobby linked to|not moved/);
	}

	// Discord cannot link these, so the game server is never asked.
	for (const [label, channel, reason] of [
		["announcement", { ...textChannel, type: 5 }, /not a text channel/],
		["voice", { ...textChannel, type: 2 }, /not a text channel/],
		["age-restricted", { ...textChannel, nsfw: true }, /age-restricted/],
	] as const) {
		const run = await runLobbyChat(NEW_CHANNEL, channel, { status: 200, body: {} });
		assert.deepEqual(run.events, ["defer", "discord:channel"], `${label} channel never reaches the game server`);
		assert.match(run.embed.title ?? "", /not moved/);
		assert.match(run.text, reason);
	}

	// The channel check on its own: a text channel in the right guild passes.
	let discordRequest = "";
	globalThis.fetch = async (input, init) => {
		discordRequest = String(input);
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bot bot-token");
		return new Response(JSON.stringify(textChannel), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const checked = await checkLobbyChatChannel(NEW_CHANNEL, { guildId: GUILD_ID });
	assert.equal(discordRequest, `https://discord.com/api/v10/channels/${NEW_CHANNEL}`);
	assert.deepEqual(checked, {
		ok: true,
		channelId: NEW_CHANNEL,
		channelName: "lobby-chat",
		guildId: GUILD_ID,
		restrictedInDiscord: false,
	});

	// A channel in another server is refused: the lobby is linked in one guild.
	const wrongGuild = await checkLobbyChatChannel(NEW_CHANNEL, { guildId: "990000000000000002" });
	assert.equal(wrongGuild.ok, false);
	assert.match(wrongGuild.ok ? "" : wrongGuild.reason, /different server/);

	// A channel the bot cannot see answers 404, which is reported as such rather than as a typo.
	globalThis.fetch = async () => new Response("{}", { status: 404 });
	const hidden = await checkLobbyChatChannel(NEW_CHANNEL, { guildId: GUILD_ID });
	assert.equal(hidden.ok, false);
	assert.match(hidden.ok ? "" : hidden.reason, /did not return that channel/);

	// The read is unchanged: GET, same secret, same state document.
	let readUrl = "";
	globalThis.fetch = async (input) => {
		readUrl = String(input);
		return new Response(JSON.stringify({ channelId: OLD_CHANNEL, channelName: "general" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const read = await fetchGameLobbyChat();
	assert.equal(readUrl, "https://game.example.com/api/admin/lobby-chat");
	assert.equal(read.channelId, OLD_CHANNEL);

	// A route the game server does not have is a failure, never a move.
	globalThis.fetch = async () =>
		new Response("<html>Cannot POST</html>", { status: 404, headers: { "content-type": "text/html" } });
	const missing = await setGameLobbyChat({ guildId: null, channelId: NEW_CHANNEL });
	assert.equal(missing.outcome, "failed");
	assert.match(missing.outcome === "failed" ? missing.error : "", /no POST \/api\/admin\/lobby-chat route/);
} finally {
	globalThis.fetch = originalFetch;
	AbortSignal.timeout = originalTimeout;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
	if (originalBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
	else process.env.DISCORD_BOT_TOKEN = originalBotToken;
}
