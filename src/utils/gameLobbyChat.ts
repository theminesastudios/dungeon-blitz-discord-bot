/**
 * The Discord channel the game's lobby chat is linked to.
 *
 * The game server links its Discord lobby to one channel (Discord "Linked
 * Channels"), and players' lobby messages then appear there as themselves. Only
 * the game server can make that link — it holds the lobby and the `CanLinkLobby`
 * admin's sign-in — so the bot is the operator's way of asking for it, exactly
 * like `/admin maintenance`. The bot never posts lobby chat into the channel
 * itself and creates nothing there.
 *
 * The move is therefore pushed, not cached: `POST /api/admin/lobby-chat` with
 * the shared admin secret, read back with the matching `GET`. The server links
 * the lobby with Discord before it answers, so only its `200` means the channel
 * moved; a `409`/`502` carries the channel lobby chat is still in. A channel
 * Discord cannot link is caught here first: the channel has to exist, be a guild
 * text channel, belong to the guild the command was run in, and not be
 * age-restricted.
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
	postGameServerAdmin,
} from "./gameMaintenance.js";

const LOBBY_CHAT_PATH = "/api/admin/lobby-chat";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** A channel read must not hold an interaction open while Discord stalls. */
const DISCORD_READ_TIMEOUT_MS = 6_000;

/** The only channel type Discord links to a lobby: `ChannelType.GuildText`. */
const GUILD_TEXT_CHANNEL_TYPE = 0;

/**
 * The server refreshes its lobby admin's token and calls Discord before it
 * answers, so a move takes longer than the other admin routes.
 */
const LOBBY_CHAT_MOVE_TIMEOUT_MS = 20_000;

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

	if (Number(channel.type) !== GUILD_TEXT_CHANNEL_TYPE) {
		return {
			ok: false,
			reason:
				"That is not a text channel. Discord can only link a lobby to a normal server text channel (not announcement, voice, forum or thread).",
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

/** What came of asking the game server to move lobby chat. */
export type LobbyChatMoveResult =
	| { outcome: "moved"; state: GameLobbyChatState }
	| {
			outcome: "failed";
			/** `null` when nothing was sent (the bot is missing its secret). */
			status: number | null;
			/** The game server's `error` text, verbatim when it sent one. */
			error: string;
			/**
			 * The state the server says is still in use, when its answer carried one
			 * (`409`/`502` do). `null` when the answer had no state at all.
			 */
			current: GameLobbyChatState | null;
	  }
	| { outcome: "unknown"; reason: string };

function hasStateFields(payload: unknown): boolean {
	return (
		Boolean(payload) &&
		typeof payload === "object" &&
		("channelId" in (payload as object) || "channel_id" in (payload as object))
	);
}

function failureText(status: number, payload: unknown, rawBody: string): string {
	const error =
		payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
	const text = typeof error === "string" ? error.trim() : "";
	if (text) return text;
	if (status === 404) {
		return "The game server has no POST /api/admin/lobby-chat route (it answered 404 with no error text).";
	}
	if (rawBody.trim().startsWith("<")) {
		return `The game server answered ${status} with an HTML page instead of JSON, so the request did not reach the lobby-chat route.`;
	}
	return `The game server answered ${status} with no error text.`;
}

/**
 * Asks the game server to link its lobby to a channel. `channelId: null` returns
 * it to the server's default channel.
 *
 * Only `200` is a move: the server answers it after Discord accepted the link,
 * with the channel now in use. Every other status is a failure that leaves the
 * channel where it was, and `409`/`502` say which one that is. No answer at all
 * (a timeout, a dropped connection) is reported as unknown, because the server
 * may have linked the lobby after the bot stopped waiting.
 *
 * Nothing is retried: a `409`/`502` needs a person to fix the server or the
 * channel, and the server rate-limits this route.
 */
export async function setGameLobbyChat(options: {
	guildId: string | null;
	channelId: string | null;
	channelName?: string | null;
	requestedBy?: string | null;
}): Promise<LobbyChatMoveResult> {
	const body = {
		guildId: options.guildId,
		channelId: options.channelId,
		channelName: options.channelName ?? null,
		requestedBy: options.requestedBy ?? null,
	};

	let answer: Awaited<ReturnType<typeof postGameServerAdmin>>;
	try {
		answer = await postGameServerAdmin(LOBBY_CHAT_PATH, body, LOBBY_CHAT_MOVE_TIMEOUT_MS);
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		if (name === "TimeoutError" || name === "AbortError") {
			return {
				outcome: "unknown",
				reason: `The game server did not answer within ${LOBBY_CHAT_MOVE_TIMEOUT_MS / 1000} s.`,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		// The secret is checked before anything is sent, so this one is a plain failure.
		if (/DISCORD_MAINTENANCE_API_SECRET/.test(message)) {
			return { outcome: "failed", status: null, error: message, current: null };
		}
		return {
			outcome: "unknown",
			reason: `The request to the game server failed before an answer arrived: ${message}`,
		};
	}

	const { status, payload, rawBody } = answer;
	if (status === 200) {
		if (!payload || typeof payload !== "object") {
			return {
				outcome: "unknown",
				reason: "The game server answered 200, but its reply could not be read.",
			};
		}
		return { outcome: "moved", state: parseLobbyChatState(payload) };
	}

	return {
		outcome: "failed",
		status,
		error: failureText(status, payload, rawBody),
		current: hasStateFields(payload) ? parseLobbyChatState(payload) : null,
	};
}
