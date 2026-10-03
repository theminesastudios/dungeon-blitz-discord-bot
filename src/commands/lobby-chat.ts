import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionActorLabel, isAdministrator } from "../utils/discordInteractions.js";
import {
	checkLobbyChatChannel,
	fetchGameLobbyChat,
	parseLobbyChatArgument,
	setGameLobbyChat,
	type GameLobbyChatState,
} from "../utils/gameLobbyChat.js";

/**
 * `/admin lobby-chat` — chooses the Discord channel the game's lobby chat is
 * bridged into.
 *
 * The Social SDK links in-game lobby chat to one Discord channel, and leaving it
 * on the server's general chat buries lobby conversation under everything else.
 * The game process owns the setting, so the command pushes it straight to the
 * game server over the shared admin secret (`POST /api/admin/lobby-chat`) rather
 * than keeping a copy the game would never read.
 *
 *   /admin lobby-chat              — show what is linked right now
 *   /admin lobby-chat #lobby-chat  — link the lobby chat to that channel
 *   /admin lobby-chat none         — unlink, so the game falls back to its own default
 *
 * A channel is checked against Discord before the game is told about it, because
 * a typo would otherwise be stored as a live setting that no lobby chat ever
 * appears in.
 */

const LINKED_COLOR = 0x2ecc71;
const UNLINKED_COLOR = 0x95a5a6;
const ERROR_COLOR = 0xe74c3c;

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
				"Give a channel as `#channel-name`, `<#123456789012345678>` or its id, or `none` to unlink the lobby chat. Leave the option empty to see what is linked.",
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
					{
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
						title: "💬 Lobby chat channel not changed",
						description: check.reason,
					},
				],
			});
		}
		channelName = check.channelName;
		restrictedInDiscord = check.restrictedInDiscord;
	}

	const requestedBy = interactionActorLabel(interaction);
	try {
		const state = await setGameLobbyChat({
			guildId: guildId || null,
			channelId: argument.kind === "channel" ? argument.channelId : null,
			channelName,
			requestedBy,
		});
		return interaction.editReply({
			embeds: [
				buildLobbyChatStateEmbed(state, {
					title:
						argument.kind === "channel"
							? "✅ Lobby chat channel linked"
							: "✅ Lobby chat channel unlinked",
					color: argument.kind === "channel" ? LINKED_COLOR : UNLINKED_COLOR,
					description:
						argument.kind === "channel"
							? "Lobby chat from the game now appears in the channel above. Players already in a lobby keep the channel they joined with until they re-join."
							: "The game is no longer linked to a channel and falls back to its own default.",
					...(argument.kind === "channel" && restrictedInDiscord
						? { footer: { text: IN_GAME_ACCESS_WARNING } }
						: {}),
				}),
			],
		});
	} catch (error) {
		return interaction.editReply({
			embeds: [
				{
					color: ERROR_COLOR,
					title: "💬 Lobby chat channel not changed",
					description: `The game server rejected the change: ${
						error instanceof Error ? error.message : String(error)
					}`,
				},
			],
		});
	}
}
