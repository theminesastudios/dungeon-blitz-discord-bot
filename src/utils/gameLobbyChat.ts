/**
 * The Discord channel the game's lobby chat is linked to.
 *
 * Discord's Social SDK bridges in-game lobby chat into one Discord channel, and
 * which one it is has to match the channel people actually want to read — the
 * game's own lobby room rather than the server's general chat. The Social SDK
 * reads that setting from the game process, so the game server owns it; the bot
 * is the operator's way of changing it, exactly like `/admin maintenance`.
 *
 * The setting is therefore pushed, not cached: `POST /api/admin/lobby-chat`
 * with the shared admin secret, answered with the state the server stored, and
 * read back with the matching `GET`. A channel that never reaches the game
 * process is worse than no channel at all, so the bot checks the snowflake
 * against Discord before sending it: the channel has to exist, be a guild text
 * channel, belong to the guild the command was run in, and be linkable at all.
 *
 * Two Discord rules are checked here rather than left to fail in the game:
 * an age-restricted channel cannot be linked to a lobby, and a channel with
 * role or member overrides is *not* private to the lobby — Discord only
 * enforces those permissions in the Discord client, so every lobby member can
 * read and write a linked channel in game whatever the channel's permissions
 * say. The second is not a reason to refuse, but it is reported, because it is
 * the answer to "can I hide this channel from people who are not players".
 */

import {
	fetchGameServerAdmin,
	requestGameServerAdmin,
} from "./gameMaintenance.js";

const LOBBY_CHAT_PATH = "/api/admin/lobby-chat";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** A channel read must not hold an interaction open while Discord stalls. */
const DISCORD_READ_TIMEOUT_MS = 6_000;

/** Discord channel types a lobby chat can be bridged into. */
const LINKABLE_CHANNEL_TYPES = new Set([0, 5]); // 0 = guild text, 5 = announcement

/** What the game server reports about the linked lobby chat channel. */
export type GameLobbyChatState = {
	guildId: string | null;
	channelId: string | null;
	channelName: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
};

type RawLobbyChatState = {
	guildId?: unknown;
	guild_id?: unknown;
	channelId?: unknown;
	channel_id?: unknown;
	channelName?: unknown;
	channel_name?: unknown;
	name?: unknown;
	updatedAt?: unknown;
	updated_at?: unknown;
	updatedBy?: unknown;
	updated_by?: unknown;
	requestedBy?: unknown;
};

function optionalString(value: unknown): string | null {
	const text = String(value ?? "").trim();
	return text ? text : null;
}

/**
 * The game server is free to answer with camelCase or snake_case and to add
 * fields; only the five values the reply renders are read, and a channel id
 * that is not a snowflake is treated as "no channel" rather than passed on.
 */
export function parseLobbyChatState(payload: unknown): GameLobbyChatState {
	const raw = (payload ?? {}) as RawLobbyChatState;
	const channelId = optionalString(raw.channelId ?? raw.channel_id);
	return {
		guildId: optionalString(raw.guildId ?? raw.guild_id),
		channelId: channelId && isSnowflake(channelId) ? channelId : null,
		channelName: optionalString(raw.channelName ?? raw.channel_name ?? raw.name),
		updatedAt: optionalString(raw.updatedAt ?? raw.updated_at),
		updatedBy: optionalString(raw.updatedBy ?? raw.updated_by ?? raw.requestedBy),
	};
}

function isSnowflake(value: string): boolean {
	return /^\d{5,32}$/.test(value);
}

/* ------------------------------------------------------------------
 * The command's argument
 * ------------------------------------------------------------------ */

export type LobbyChatArgument =
	| { kind: "show" }
	| { kind: "clear" }
	| { kind: "channel"; channelId: string }
	| { kind: "invalid" };

/** Words that mean "stop linking a channel", so the game falls back to its own default. */
const CLEAR_WORDS = new Set(["none", "off", "clear", "unset", "default"]);

/**
 * Reads the one option the command takes, which is deliberately forgiving:
 * administrators paste `#lobby` mentions (`<#123…>`), a raw id copied from
 * developer mode, or the word `none` to unlink. Anything else is refused here,
 * before a request is sent, with the accepted forms spelled out.
 */
export function parseLobbyChatArgument(raw: string | null | undefined): LobbyChatArgument {
	const value = String(raw ?? "").trim();
	if (!value) return { kind: "show" };
	if (CLEAR_WORDS.has(value.toLowerCase())) return { kind: "clear" };

	const mention = value.match(/^<#(\d{5,32})>$/);
	if (mention) return { kind: "channel", channelId: mention[1] };

	if (isSnowflake(value)) return { kind: "channel", channelId: value };

	return { kind: "invalid" };
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

export type LobbyChatChannelCheck =
	| {
			ok: true;
			channelId: string;
			channelName: string;
			guildId: string | null;
			/**
			 * The channel has role or member permission overrides, so Discord treats
			 * it as private in the Discord client. It is *not* private to a lobby:
			 * Discord does not apply channel permissions to in-game access.
			 */
			restrictedInDiscord: boolean;
	  }
	| { ok: false; reason: string };

/** Discord permission bits a lobby chat cares about. */
const VIEW_CHANNEL = 1024n; // 1 << 10
const SEND_MESSAGES = 2048n; // 1 << 11

function permissionBits(value: unknown): bigint {
	const numeric = Number(value ?? 0);
	return Number.isFinite(numeric) && numeric > 0 ? BigInt(Math.floor(numeric)) : 0n;
}

/**
 * Whether the channel carries Discord-side read/write restrictions.
 *
 * Discord's own `isViewableAndWriteableByAllMembers` is not exposed by the REST
 * channel object, so this reads the permission overwrites instead: any override
 * that denies viewing or sending marks the channel restricted. That deliberately
 * over-reports — an override that is later re-granted still counts — because the
 * consequence of under-reporting is quietly exposing a channel, while the
 * consequence of over-reporting is one extra warning line. A channel with no
 * overrides at all is reported as unrestricted; the guild's own `@everyone`
 * permissions are not read, so this stays "no per-role restrictions" rather than
 * a claim that every member can see it.
 */
export function hasDiscordSideRestrictions(overwrites: unknown): boolean {
	if (!Array.isArray(overwrites)) return false;
	return overwrites.some((entry) => {
		const deny = permissionBits(
			(entry && typeof entry === "object" ? (entry as { deny?: unknown }).deny : null),
		);
		return (deny & (VIEW_CHANNEL | SEND_MESSAGES)) !== 0n;
	});
}

/**
 * Confirms the channel is one the lobby chat can actually be linked to. Discord
 * answers `404` both for an id that does not exist and for one the bot cannot
 * see, so the reason names both rather than claiming the id is wrong.
 */
export async function checkLobbyChatChannel(
	channelId: string,
	options: { guildId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LobbyChatChannelCheck> {
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

	const type = Number(channel.type);
	if (!LINKABLE_CHANNEL_TYPES.has(type)) {
		return {
			ok: false,
			reason:
				"That is not a text channel. Lobby chat can only be linked to a guild text or announcement channel.",
		};
	}

	const channelGuildId = optionalString(channel.guild_id);
	if (!channelGuildId) {
		return {
			ok: false,
			reason: "That is not a channel in a server; lobby chat needs a guild channel.",
		};
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
		guildId: channelGuildId,
		restrictedInDiscord: hasDiscordSideRestrictions(channel.permission_overwrites),
	};
}

/* ------------------------------------------------------------------
 * The game server routes
 * ------------------------------------------------------------------ */

export function fetchGameLobbyChat(): Promise<GameLobbyChatState> {
	return fetchGameServerAdmin<unknown>(
		LOBBY_CHAT_PATH,
		"the linked lobby chat channel",
	).then(parseLobbyChatState);
}

/**
 * Pushes the new link to the game process. `channelId: null` clears it, which is
 * how the game returns to whatever channel it links by default.
 *
 * The route answers with the state it stored rather than a bare acknowledgement,
 * so the panel shows what the game actually holds instead of what was asked for.
 */
export function setGameLobbyChat(options: {
	guildId: string | null;
	channelId: string | null;
	channelName?: string | null;
	requestedBy?: string | null;
}): Promise<GameLobbyChatState> {
	const action = options.channelId
		? "the linked lobby chat channel"
		: "clearing the linked lobby chat channel";
	return requestGameServerAdmin<unknown>(
		LOBBY_CHAT_PATH,
		{
			guildId: options.guildId,
			channelId: options.channelId,
			channelName: options.channelName ?? null,
			requestedBy: options.requestedBy ?? null,
		},
		action,
		{ requireOk: false },
	).then(parseLobbyChatState);
}
