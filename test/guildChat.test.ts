import assert from "node:assert/strict";
import {
	checkGuildChatChannel,
	parseGuildChatLinks,
	setGuildChatLink,
} from "../src/utils/gameGuildChat.js";
import { buildGuildChatResultEmbed } from "../src/commands/guild-chat.js";

/*
 * Guild chat is a Discord lobby linked to the guild's channel, like lobby chat.
 * Worth pinning: a channel Discord cannot link to a lobby (age-restricted, not a
 * text channel, another server) is refused before the game server is asked; the
 * game server's `lobbyId` and `status` are read; and a new link reads as pending
 * on the Guild Master's launcher, never as live, until the server says linked.
 */

const GUILD = "Dragon Slayers";
const CHANNEL = "1400000000000000001";
const SERVER = "1100000000000000000";

const row = (overrides: Record<string, unknown> = {}) => ({
	guildName: GUILD,
	discordGuildId: SERVER,
	channelId: CHANNEL,
	channelName: "guild-chat",
	updatedAt: "2026-11-24T12:00:00.000Z",
	updatedBy: "Neo (<@123456789012345678>)",
	lobbyId: "1700000000000000001",
	status: "pending",
	...overrides,
});

// The server's rows: the lobby and its state ride along; an older server sends neither.
{
	const [pending, old] = parseGuildChatLinks({
		links: [row(), { guildName: "Night Watch", channelId: "1400000000000000002" }],
	});
	assert.equal(pending.lobbyId, "1700000000000000001");
	assert.equal(pending.status, "pending");
	assert.equal(old.lobbyId, null);
	assert.equal(old.status, null, "a server too old to report a status reports none");
	assert.equal(parseGuildChatLinks({ links: [row({ status: "LINKED" })] })[0].status, "linked");
	assert.equal(parseGuildChatLinks({ links: [row({ status: "weird" })] })[0].status, null);
}

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
const originalBotToken = process.env.DISCORD_BOT_TOKEN;

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
	process.env.DISCORD_BOT_TOKEN = "bot-token";

	// The channel checks, against a Discord that answers the bot.
	const channels: Record<string, unknown> = {
		[CHANNEL]: { id: CHANNEL, type: 0, guild_id: SERVER, name: "guild-chat" },
		"1400000000000000003": { id: "1400000000000000003", type: 0, guild_id: SERVER, nsfw: true },
		"1400000000000000004": { id: "1400000000000000004", type: 2, guild_id: SERVER },
		"1400000000000000005": { id: "1400000000000000005", type: 0, guild_id: "1199999999999999999" },
	};
	globalThis.fetch = async (input) => {
		const id = String(input).split("/").pop() ?? "";
		return channels[id]
			? new Response(JSON.stringify(channels[id]), { status: 200 })
			: new Response("{}", { status: 404 });
	};
	const ok = await checkGuildChatChannel(CHANNEL, { guildId: SERVER });
	assert.equal(ok.ok, true, "a plain text channel of this server is linkable");
	const nsfw = await checkGuildChatChannel("1400000000000000003", { guildId: SERVER });
	assert.equal(nsfw.ok, false);
	assert.match(!nsfw.ok ? nsfw.reason : "", /age-restricted/, "Discord does not link an age-restricted channel");
	assert.equal((await checkGuildChatChannel("1400000000000000004", { guildId: SERVER })).ok, false, "not a voice channel");
	assert.equal((await checkGuildChatChannel("1400000000000000005", { guildId: SERVER })).ok, false, "not another server's channel");
	assert.equal((await checkGuildChatChannel("1400000000000000009", { guildId: SERVER })).ok, false, "not one the bot cannot see");

	// The link, as the game server answers it.
	let sent: { url: string; body: any; auth: string } | null = null;
	globalThis.fetch = async (input, init) => {
		sent = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")),
			auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
		};
		return new Response(JSON.stringify({ links: [row()] }), { status: 200 });
	};
	const result = await setGuildChatLink({
		guildName: GUILD,
		guildId: SERVER,
		channelId: CHANNEL,
		channelName: "guild-chat",
		requestedBy: "Neo (<@123456789012345678>)",
	});
	assert.equal(result.outcome, "stored");
	assert.equal(sent!.url, "https://game.example.com/api/admin/guild-chat");
	assert.equal(sent!.auth, "Bearer test-secret");
	assert.equal(sent!.body.requestedBy, "Neo (<@123456789012345678>)", "the server checks the Guild Master named here");

	// A pending link says what it waits for, and does not claim the channel is live.
	const pendingEmbed = buildGuildChatResultEmbed(GUILD, result, { channelId: CHANNEL });
	assert.match(pendingEmbed.description ?? "", /launcher/, "a pending link names the Guild Master's launcher");
	assert.match(pendingEmbed.description ?? "", /Until then nothing reaches the channel/);
	assert.ok(
		JSON.stringify(pendingEmbed).includes("Pending"),
		"the Status field reads pending",
	);
	assert.equal(pendingEmbed.title, "Guild chat link pending", "and the headline does not claim it is linked");

	const legacyEmbed = buildGuildChatResultEmbed(
		GUILD,
		{ outcome: "stored", links: parseGuildChatLinks({ links: [row({ status: undefined, lobbyId: undefined })] }) },
		{ channelId: CHANNEL },
	);
	assert.doesNotMatch(legacyEmbed.description ?? "", /launcher|lobby/, "a server without lobby state is not described as one");
	assert.match(legacyEmbed.description ?? "", /stored/);

	const linkedEmbed = buildGuildChatResultEmbed(
		GUILD,
		{ outcome: "stored", links: parseGuildChatLinks({ links: [row({ status: "linked" })] }) },
		{ channelId: CHANNEL },
	);
	assert.match(linkedEmbed.description ?? "", /talk there as themselves/, "a linked one says how the channel works");
	assert.match(linkedEmbed.description ?? "", /Officer chat stays in game/);
	assert.equal(linkedEmbed.title, "Guild chat linked");

	const unlinkedEmbed = buildGuildChatResultEmbed(GUILD, { outcome: "stored", links: [] }, { channelId: null });
	assert.equal(unlinkedEmbed.title, "Guild chat unlinked");
} finally {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
	if (originalBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
	else process.env.DISCORD_BOT_TOKEN = originalBotToken;
}

console.log("guild chat: channel checks, lobby status and pending replies hold");
