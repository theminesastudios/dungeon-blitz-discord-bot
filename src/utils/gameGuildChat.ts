/**
 * The Discord channel an in-game guild's chat is linked to, for `/guild-chat`.
 *
 * Guild chat works the way lobby chat does (Discord "Linked Channels"): the game
 * server keeps a Discord lobby for the guild, linked to the channel, and each
 * member's launcher talks in that lobby as the member — their lines land in the
 * channel under their own name, and the channel's messages reach the guild in
 * game tagged `[Discord]`. Officer chat never leaves the game.
 *
 * `POST /api/admin/guild-chat` makes the guild's lobby and gives the Guild Master
 * `CanLinkLobby` in it. Discord lets only a user link a lobby to a channel, not
 * a bot, and the channel is in the caller's own server, so the link is finished
 * by the Guild Master's launcher: the link answers `status: "pending"` until the
 * Guild Master opens the game from the launcher, then `"linked"`. Which channel is
 * linkable is checked here, with Discord, before the server is asked; the server
 * checks it again.
 *
 * Who may link is settled here and on the game server: the command reads the
 * caller's save and only sends the name of the in-game guild one of their
 * characters leads (`guild.rank` 0, Guild Master), and the game server checks the
 * Discord account in `requestedBy` leads that guild before it makes the lobby.
 */

import {
	fetchGameServerAdmin,
	postGameServerAdmin,
} from "./gameMaintenance.js";
import { hasDiscordSideRestrictions } from "./gameLobbyChat.js";

const GUILD_CHAT_PATH = "/api/admin/guild-chat";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** A channel read must not hold an interaction open while Discord stalls. */
const DISCORD_READ_TIMEOUT_MS = 6_000;

/** The only channel type Discord links to a lobby: `ChannelType.GuildText`. */
const GUILD_TEXT_CHANNEL_TYPE = 0;

/**
 * The game server checks the channel and makes the guild's lobby with Discord
 * before it answers, so a link takes longer than the other admin routes.
 */
const GUILD_CHAT_LINK_TIMEOUT_MS = 20_000;

/** One stored link, as the game server reports it. */
export type GuildChatLink = {
	guildName: string;
	discordGuildId: string | null;
	channelId: string;
	channelName: string | null;
	updatedAt: string;
	updatedBy: string | null;
	/** The guild's Discord lobby on the game server. */
	lobbyId: string | null;
	/**
	 * `pending` until the Guild Master's launcher links the lobby to the channel;
	 * null from a game server too old to report it.
	 */
	status: "linked" | "pending" | null;
};

export type GuildChatLinkResult =
	| { outcome: "stored"; links: GuildChatLink[] }
	| { outcome: "failed"; status: number | null; error: string }
	| { outcome: "unknown"; reason: string };

function optionalString(value: unknown): string | null {
	const text = String(value ?? "").trim();
	return text ? text : null;
}

function isSnowflake(value: string): boolean {
	return /^\d{5,32}$/.test(value);
}

function parseLinkStatus(value: unknown): GuildChatLink["status"] {
	const status = String(value ?? "").trim().toLowerCase();
	return status === "linked" || status === "pending" ? status : null;
}

function parseGuildChatLink(raw: unknown): GuildChatLink | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const guildName = optionalString(record.guildName ?? record.guild_name);
	const channelId = optionalString(record.channelId ?? record.channel_id);
	if (!guildName || !channelId || !isSnowflake(channelId)) return null;
	return {
		guildName,
		discordGuildId: optionalString(record.discordGuildId ?? record.discord_guild_id ?? record.guildId),
		channelId,
		channelName: optionalString(record.channelName ?? record.channel_name),
		updatedAt: optionalString(record.updatedAt ?? record.updated_at) ?? "",
		updatedBy: optionalString(record.updatedBy ?? record.updated_by ?? record.requestedBy),
		lobbyId: optionalString(record.lobbyId ?? record.lobby_id),
		status: parseLinkStatus(record.status),
	};
}

export function parseGuildChatLinks(payload: unknown): GuildChatLink[] {
	const raw = (payload ?? {}) as { links?: unknown };
	return (Array.isArray(raw.links) ? raw.links : [])
		.map(parseGuildChatLink)
		.filter((link): link is GuildChatLink => link !== null);
}

/** Case/spacing-insensitive match on the in-game guild name, as the game keys it. */
export function findGuildChatLink(links: GuildChatLink[], guildName: string): GuildChatLink | null {
	const key = guildName.trim().replace(/\s+/g, " ").toLowerCase();
	return (
		links.find(
			(link) => link.guildName.trim().replace(/\s+/g, " ").toLowerCase() === key,
		) ?? null
	);
}

export async function fetchGuildChatLinks(): Promise<GuildChatLink[]> {
	const payload = await fetchGameServerAdmin<unknown>(
		GUILD_CHAT_PATH,
		"the guild chat channel links",
	);
	return parseGuildChatLinks(payload);
}

export async function setGuildChatLink(options: {
	guildName: string;
	guildId: string | null;
	channelId: string | null;
	channelName?: string | null;
	requestedBy?: string | null;
}): Promise<GuildChatLinkResult> {
	const body = {
		guildName: options.guildName,
		guildId: options.guildId,
		channelId: options.channelId,
		channelName: options.channelName ?? null,
		requestedBy: options.requestedBy ?? null,
	};

	let answer: Awaited<ReturnType<typeof postGameServerAdmin>>;
	try {
		answer = await postGameServerAdmin(GUILD_CHAT_PATH, body, GUILD_CHAT_LINK_TIMEOUT_MS);
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const message = error instanceof Error ? error.message : String(error);
		if (name === "TimeoutError" || name === "AbortError") {
			return { outcome: "unknown", reason: "The game server did not answer in time." };
		}
		if (/DISCORD_MAINTENANCE_API_SECRET/.test(message)) {
			return { outcome: "failed", status: null, error: message };
		}
		return {
			outcome: "unknown",
			reason: `The request to the game server failed before an answer arrived: ${message}`,
		};
	}

	const { status, payload, rawBody } = answer;
	if (status === 200) {
		const links = parseGuildChatLinks(payload);
		// A store that cannot be read back cannot be confirmed: an unlink drops the
		// guild's row, but a link request must come back with it. Reporting 'stored'
		// on an empty or unreadable list would claim the channel is live when it
		// may not be.
		if (options.channelId && !findGuildChatLink(links, options.guildName)) {
			return {
				outcome: "unknown",
				reason:
					"The game server answered 200 but the link was not in the response, so it cannot be confirmed.",
			};
		}
		return { outcome: "stored", links };
	}
	const detail =
		payload && typeof payload === "object" && "error" in payload
			? String((payload as { error?: unknown }).error ?? "unknown error")
			: rawBody.trim().startsWith("<")
				? "the game server has no route at this path; it needs the guild-chat route deployed first"
				: "invalid response";
	return { outcome: "failed", status, error: detail };
}

/* ------------------------------------------------------------------
 * Checking the channel with Discord before the game is told about it
 * ------------------------------------------------------------------ */

type DiscordChannel = {
	id?: unknown;
	name?: unknown;
	type?: unknown;
	guild_id?: unknown;
	nsfw?: unknown;
	permission_overwrites?: unknown;
};

export type GuildChatChannelCheck =
	| {
			ok: true;
			channelId: string;
			channelName: string;
			/**
			 * The channel has role or member permission overrides. Those apply in the
			 * Discord client only: every guild member reads and writes the linked
			 * channel in game.
			 */
			restrictedInDiscord: boolean;
	  }
	| { ok: false; reason: string };

/**
 * Confirms the channel is one Discord links to a lobby: a text channel in the
 * guild the command was run in, that the bot can see, and not age-restricted.
 * Discord answers `404` both for an id that does not exist and for one the bot
 * cannot see, so the reason names both rather than claiming the id is wrong.
 */
export async function checkGuildChatChannel(
	channelId: string,
	options: { guildId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GuildChatChannelCheck> {
	const env = options.env ?? process.env;
	const botToken = String(env.DISCORD_BOT_TOKEN ?? "").trim();
	if (!botToken) {
		return {
			ok: false,
			reason:
				"The bot deployment has no DISCORD_BOT_TOKEN, so it cannot confirm the channel with Discord.",
		};
	}

	let channel: DiscordChannel;
	try {
		const response = await fetch(
			`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`,
			{
				headers: { Authorization: `Bot ${botToken}`, Accept: "application/json" },
				signal: AbortSignal.timeout(DISCORD_READ_TIMEOUT_MS),
			},
		);
		if (response.status === 404) {
			return {
				ok: false,
				reason:
					"Discord did not return that channel for the bot: the id is wrong, or the bot cannot see the channel.",
			};
		}
		if (!response.ok) {
			return {
				ok: false,
				reason: `Discord answered ${response.status} when reading that channel; retry once the API is reachable.`,
			};
		}
		channel = (await response.json()) as DiscordChannel;
	} catch (error) {
		return {
			ok: false,
			reason: `Discord could not be reached to check the channel: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	if (Number(channel.type) !== GUILD_TEXT_CHANNEL_TYPE) {
		return {
			ok: false,
			reason:
				"That is not a text channel. Guild chat can only be linked to a normal server text channel (not announcement, voice, forum or thread).",
		};
	}

	const channelGuildId = optionalString(channel.guild_id);
	if (!channelGuildId) {
		return { ok: false, reason: "That is not a channel in a server; guild chat needs a guild channel." };
	}

	const expectedGuildId = String(options.guildId ?? "").trim();
	if (expectedGuildId && channelGuildId !== expectedGuildId) {
		return {
			ok: false,
			reason: "That channel belongs to a different server than the one this command was run in.",
		};
	}

	if (channel.nsfw === true) {
		return {
			ok: false,
			reason:
				"That channel is marked age-restricted, and Discord does not allow an age-restricted channel to be linked to a lobby. Link a channel that is not age-restricted.",
		};
	}

	return {
		ok: true,
		channelId: optionalString(channel.id) ?? channelId,
		channelName: optionalString(channel.name) ?? channelId,
		restrictedInDiscord: hasDiscordSideRestrictions(channel.permission_overwrites),
	};
}
