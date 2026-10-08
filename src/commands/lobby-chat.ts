import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionActorLabel, isAdministrator } from "../utils/discordInteractions.js";
import { GameServerAdminError } from "../utils/gameMaintenance.js";
import {
	checkLobbyChatChannel,
	fetchGameLobbyChat,
	parseLobbyChatArgument,
	setGameLobbyChat,
	type GameLobbyChatState,
	type LobbyChatMoveResult,
} from "../utils/gameLobbyChat.js";

/**
 * `/admin lobby-chat` — moves the game's lobby chat to a Discord channel.
 *
 * The game server links its Discord lobby to the channel (Discord "Linked
 * Channels"), so players speak there as themselves through the game. The server
 * owns the lobby and the relay; the bot only asks for the move over the shared
 * admin secret (`POST /api/admin/lobby-chat`) and never posts lobby chat into the
 * channel itself.
 *
 *   /admin lobby-chat              — show the channel in use right now
 *   /admin lobby-chat #lobby-chat  — link the lobby to that channel
 *   /admin lobby-chat none         — return to the server's default channel
 *
 * A channel is checked against Discord before the server is asked, because
 * Discord cannot link one that is not a plain text channel or is age-restricted.
 * The reply only says the channel moved when the server answered `200`, which it
 * does after Discord accepted the link.
 */

const LINKED_COLOR = 0x2ecc71;
const UNLINKED_COLOR = 0x95a5a6;
const ERROR_COLOR = 0xe74c3c;
const UNKNOWN_COLOR = 0xf1c40f;

/** `409`: the server has no lobby, or no saved sign-in from its `CanLinkLobby` admin. */
export const LOBBY_SETUP_HINT =
	"A server admin must run `node --env-file=.env tools/linkedDiscordLobby.js link --lobby <lobbyId>` on the game server once.";

/** `502`: Discord itself refused the link. */
export const DISCORD_REFUSED_HINT =
	"Discord refused the link. Check that the channel is a normal (not age-restricted) text channel, isn't linked to another lobby, and that the lobby admin has View Channel, Send Messages and Manage Channels there.";

/** Discord's embed field limit; the state never comes close, this only guards a long name. */
const FIELD_VALUE_LIMIT = 1_024;

/**
 * Shown when the chosen channel carries role or member permission overrides.
 * Discord enforces those permissions only in the Discord client: everyone in a
 * linked lobby reads and writes the channel in game whatever the channel is set
 * to, so an operator linking a restricted channel is told that plainly rather
 * than discovering it in the first lobby chat.
 */
const IN_GAME_ACCESS_WARNING =
	"That channel has role or member restrictions in Discord. Those apply in the Discord client only — every player in a linked lobby can read and write it in game, whatever the channel is set to.";

function oneLine(value: string | null, limit = FIELD_VALUE_LIMIT): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "—";
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Timestamps are stored as ISO strings; an unreadable one is shown as sent. */
export function formatLinkedChannelTimestamp(value: string | null): string {
	const raw = String(value ?? "").trim();
	if (!raw) return "Never";
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) return oneLine(raw, 80);
	return `<t:${Math.floor(parsed / 1000)}:f>`;
}

/**
 * The state panel both the read and the write answer with, so an administrator
 * sees the same shape whether they asked what is linked or just changed it.
 */
export function buildLobbyChatStateEmbed(
	state: GameLobbyChatState,
	options: {
		title: string;
		color?: number;
		description?: string;
		footer?: { text: string };
	} = {
		title: "💬 Lobby chat channel",
	},
) {
	const linked = Boolean(state.channelId);
	const changedBy = oneLine(state.updatedBy, 200);
	return {
		color: options.color ?? (linked ? LINKED_COLOR : UNLINKED_COLOR),
		title: options.title,
		...(options.description ? { description: options.description } : {}),
		...(options.footer ? { footer: options.footer } : {}),
		fields: [
			{
				name: "Linked channel",
				value: state.channelId
					? `<#${state.channelId}>${state.channelName ? ` (${oneLine(state.channelName, 200)})` : ""}`
					: "Not linked — the game uses its own default",
				inline: false,
			},
			{
				name: "Channel ID",
				value: oneLine(state.channelId),
				inline: true,
			},
			{
				name: "Guild ID",
				value: oneLine(state.guildId),
				inline: true,
			},
			{
				name: "Changed",
				value: linked || state.updatedAt
					? `${formatLinkedChannelTimestamp(state.updatedAt)}${changedBy !== "—" ? ` by ${changedBy}` : ""}`
					: "Never",
				inline: false,
			},
		],
	};
}

/** The server's error text as sent, cut only if it would overflow the embed. */
function verbatim(text: string, limit = 3_500): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function stillInChannel(current: GameLobbyChatState | null): string {
	if (!current) return "Unchanged. Run `/admin lobby-chat` with no channel to see which channel is in use.";
	if (!current.channelId) return "The server's default channel";
	return `<#${current.channelId}>${current.channelName ? ` (${oneLine(current.channelName, 200)})` : ""}`;
}

/**
 * The reply to a move. Only `moved` — the server's `200` — says the channel
 * changed; a failure names the channel lobby chat is still in, and an unknown
 * outcome claims neither.
 */
export function buildLobbyChatMoveEmbed(
	result: LobbyChatMoveResult,
	options: { restrictedInDiscord?: boolean } = {},
) {
	if (result.outcome === "moved") {
		const { state } = result;
		return buildLobbyChatStateEmbed(state, {
			title: "✅ Lobby chat moved",
			color: state.channelId ? LINKED_COLOR : UNLINKED_COLOR,
			description: state.channelId
				? `Lobby linked to <#${state.channelId}>. Players now speak there as themselves through the game.`
				: "Lobby chat is back on the game server's default channel.",
			...(state.channelId && options.restrictedInDiscord
				? { footer: { text: IN_GAME_ACCESS_WARNING } }
				: {}),
		});
	}

	if (result.outcome === "unknown") {
		return {
			color: UNKNOWN_COLOR,
			title: "⚠️ Lobby chat move: outcome unknown",
			description: `${result.reason} The server may or may not have moved lobby chat. Run \`/admin lobby-chat\` with no channel to see which channel is in use before trying again.`,
		};
	}

	const hint =
		result.status === 409 ? LOBBY_SETUP_HINT : result.status === 502 ? DISCORD_REFUSED_HINT : null;
	return {
		color: ERROR_COLOR,
		title: "❌ Lobby chat not moved",
		description: `The move failed${result.status ? ` (${result.status})` : ""}: ${verbatim(result.error)}`,
		fields: [
			{ name: "Lobby chat is still in", value: stillInChannel(result.current), inline: false },
			...(hint ? [{ name: "How to fix it", value: hint, inline: false }] : []),
		],
	};
}

export async function handleLobbyChat(interaction: CommandInteraction) {
	if (!isAdministrator(interaction)) {
		return interaction.reply({
			content: "Administrator permission is required.",
			flags: 64,
		});
	}

	const argument = parseLobbyChatArgument(interaction.options.getString("channel", false));

	if (argument.kind === "invalid") {
		return interaction.reply({
			content:
				"Give a channel as `#channel-name`, `<#123456789012345678>` or its id, or `none` to return to the server's default channel. Leave the option empty to see the channel in use now.",
			flags: 64,
		});
	}

	const guildId = String(interaction.guild_id ?? "").trim();
	interaction.deferReply({ flags: 64 });

	if (argument.kind === "show") {
		try {
			const state = await fetchGameLobbyChat();
			return interaction.editReply({
				embeds: [
					buildLobbyChatStateEmbed(state, {
						title: "💬 Linked lobby chat channel",
					}),
				],
			});
		} catch (error) {
			return interaction.editReply({
				embeds: [
					error instanceof GameServerAdminError && error.status === 404
						? {
								color: ERROR_COLOR,
								title: "💬 The game server has no lobby-chat route",
								description:
									"The game server answered 404 for `GET /api/admin/lobby-chat`, so there is no stored setting to read back: that route has to be added to the game server first. The channel the game is linked to right now comes from the game server's own configuration.",
							}
						: {
								color: ERROR_COLOR,
								title: "💬 Lobby chat channel",
								description: `The game server could not be read: ${
									error instanceof Error ? error.message : String(error)
								}`,
							},
				],
			});
		}
	}

	let channelName: string | null = null;
	let restrictedInDiscord = false;
	if (argument.kind === "channel") {
		const check = await checkLobbyChatChannel(argument.channelId, { guildId });
		if (!check.ok) {
			return interaction.editReply({
				embeds: [
					{
						color: ERROR_COLOR,
						title: "❌ Lobby chat not moved",
						description: `${check.reason} Nothing was sent to the game server.`,
					},
				],
			});
		}
		channelName = check.channelName;
		restrictedInDiscord = check.restrictedInDiscord;
	}

	const result = await setGameLobbyChat({
		guildId: guildId || null,
		channelId: argument.kind === "channel" ? argument.channelId : null,
		channelName,
		requestedBy: interactionActorLabel(interaction),
	});
	return interaction.editReply({
		embeds: [buildLobbyChatMoveEmbed(result, { restrictedInDiscord })],
	});
}
