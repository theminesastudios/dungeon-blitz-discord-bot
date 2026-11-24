import {
	CommandBuilder,
	CommandContext,
} from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionActorLabel, interactionDiscordId, isAdministrator } from "../utils/discordInteractions.js";
import { GameServerAdminError } from "../utils/gameMaintenance.js";
import { getGameAccountByDiscordId } from "../utils/gameAccount.js";
import { findGuildLedByUser } from "../utils/gameWallet.js";
import {
	checkGuildChatChannel,
	fetchGuildChatLinks,
	findGuildChatLink,
	parseGuildChatLinks,
	setGuildChatLink,
	type GuildChatLink,
	type GuildChatLinkResult,
} from "../utils/gameGuildChat.js";
import { parseLobbyChatArgument } from "../utils/gameLobbyChat.js";

/**
 * `/guild-chat` — links one in-game guild's chat to a Discord channel.
 *
 * The caller must be both: an administrator of the Discord guild the command is
 * run in (the channel is theirs to offer), and the leader of the in-game guild
 * whose chat is being linked — read off their linked account's save, where
 * `guild.rank` 0 is Guild Master. That is what lets players share their own
 * guild chats: any Discord server admin who leads an in-game guild can pipe
 * their guild's chat into their community, not just our staff.
 *
 *   /guild-chat              — show the channel the guild's chat is linked to
 *   /guild-chat #guild-chat  — link the guild's chat to that channel
 *   /guild-chat none         — unlink
 *
 * A link is a Discord lobby for the guild, linked to the channel the way lobby
 * chat's lobby is: members who play from the launcher talk in the channel as
 * themselves, and the channel's messages reach the guild in game tagged
 * `[Discord]`. Discord lets only a user link a lobby, so a new link is pending
 * until the Guild Master opens the game from the launcher, signed in with this
 * Discord account. A channel is checked against Discord before the server is
 * asked: a text channel in this server that the bot can see and that is not
 * age-restricted.
 */

const LINKED_COLOR = 0x2ecc71;
const UNLINKED_COLOR = 0x95a5a6;
const ERROR_COLOR = 0xe74c3c;
const UNKNOWN_COLOR = 0xf1c40f;

/**
 * Shown when the chosen channel carries role or member permission overrides.
 * Discord enforces those only in the Discord client: every member of the linked
 * guild reads the relayed lines in game whatever the channel is set to.
 */
const IN_GAME_ACCESS_WARNING =
	"That channel has role or member restrictions in Discord. Those apply in the Discord client only — every member of the guild reads and writes it in game, whatever the channel is set to.";

/** What a pending link is waiting for, said where the reply shows one. */
const PENDING_LINK_NOTE =
	"Waiting for the Guild Master: open Dungeon Blitz from the launcher, signed in with this Discord account, and the launcher links the guild's lobby to the channel. Until then nothing reaches the channel.";

function statusLabel(link: GuildChatLink | null): string {
	if (!link?.channelId) return "Not linked";
	if (link.status === "pending") return "Pending — the Guild Master's launcher links it";
	if (link.status === "linked") return "Linked";
	return "Stored";
}

function oneLine(value: string | null | undefined, limit = 1_024): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "—";
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function formatTimestamp(value: string | null | undefined): string {
	const raw = String(value ?? "").trim();
	if (!raw) return "Never";
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) return oneLine(raw, 80);
	return `<t:${Math.floor(parsed / 1000)}:f>`;
}

/** The state panel both the read and the write answer with. */
function buildGuildChatStateEmbed(
	guildName: string,
	link: GuildChatLink | null,
	options: { title: string; color?: number; description?: string; footer?: { text: string } },
) {
	const linked = Boolean(link?.channelId);
	return {
		color: options.color ?? (linked ? LINKED_COLOR : UNLINKED_COLOR),
		title: options.title,
		...(options.description ? { description: options.description } : {}),
		...(options.footer ? { footer: options.footer } : {}),
		fields: [
			{ name: "In-game guild", value: oneLine(guildName, 200), inline: false },
			{
				name: "Linked channel",
				value: link?.channelId
					? `<#${link.channelId}>${link.channelName ? ` (${oneLine(link.channelName, 200)})` : ""}`
					: "Not linked",
				inline: false,
			},
			...(link
				? [
						{ name: "Status", value: statusLabel(link), inline: false },
						{
							name: "Changed",
							value: `${formatTimestamp(link.updatedAt)}${link.updatedBy ? ` by ${oneLine(link.updatedBy, 200)}` : ""}`,
							inline: false,
						},
					]
				: []),
		],
	};
}

export function buildGuildChatResultEmbed(
	guildName: string,
	result: GuildChatLinkResult,
	options: { channelId?: string | null; restrictedInDiscord?: boolean } = {},
) {
	if (result.outcome === "stored") {
		const link = findGuildChatLink(result.links, guildName);
		const unlinked = options.channelId === null || (options.channelId === undefined && !link);
		const pending = !unlinked && link?.status === "pending";
		const description = unlinked
			? `${guildName}'s chat is no longer linked to a Discord channel; its Discord lobby was removed.`
			: pending
				? `${guildName} has a Discord lobby for <#${link!.channelId}>. ${PENDING_LINK_NOTE}`
				: link?.status === "linked"
					? `${guildName}'s chat is linked to <#${link.channelId}>: members who play from the launcher talk there as themselves, and the channel's messages reach the guild in game tagged \`[Discord]\`. Officer chat stays in game.`
					: // A game server too old to report the lobby's state: say only what it stored.
						`The game server stored <#${link!.channelId}> for ${guildName}'s chat.`;
		return buildGuildChatStateEmbed(guildName, link, {
			title: unlinked
				? "Guild chat unlinked"
				: pending
					? "Guild chat link pending"
					: link?.status === "linked"
						? "Guild chat linked"
						: "Guild chat link stored",
			color: unlinked ? UNLINKED_COLOR : pending ? UNKNOWN_COLOR : LINKED_COLOR,
			description,
			...(link?.channelId && options.restrictedInDiscord ? { footer: { text: IN_GAME_ACCESS_WARNING } } : {}),
		});
	}

	if (result.outcome === "unknown") {
		return {
			color: UNKNOWN_COLOR,
			title: "Guild chat link: outcome unknown",
			description: `${result.reason} The link may or may not have been stored. Run \`/guild-chat\` with no channel to see the link in use before trying again.`,
		};
	}

	return {
		color: ERROR_COLOR,
		title: "Guild chat not linked",
		description: `The game server refused${result.status ? ` (${result.status})` : ""}: ${result.error.slice(0, 3_500)}`,
	};
}

/** The in-game guild the invoking player leads, or the refusal to show instead. */
async function ledGuildOrReply(interaction: CommandInteraction) {
	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return { error: "Your Discord account could not be read from this interaction." };
	}
	const account = await getGameAccountByDiscordId(discordId).catch(() => null);
	if (!account) {
		return {
			error:
				"Your Discord account is not linked to a game account, so no guild you lead can be found. Create or link one with `/account` first.",
		};
	}
	const led = await findGuildLedByUser(account.userId).catch(() => null);
	if (!led) {
		return {
			error:
				"You do not lead an in-game guild — only the guild's leader can link its chat. Officers and members cannot.",
		};
	}
	return { led };
}

export async function handleGuildChat(interaction: CommandInteraction) {
	if (!interaction.guild_id) {
		return interaction.reply({
			content: "Guild chat can only be linked from inside a server.",
			flags: 64,
		});
	}
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
				"Give a channel as `#channel-name`, `<#123456789012345678>` or its id, or `none` to unlink. Leave the option empty to see the channel in use now.",
			flags: 64,
		});
	}

	interaction.deferReply({ flags: 64 });

	const leadership = await ledGuildOrReply(interaction);
	if ("error" in leadership) {
		return interaction.editReply({
			embeds: [
				{
					color: ERROR_COLOR,
					title: "Guild chat",
					description: leadership.error,
				},
			],
		});
	}
	const { guildName } = leadership.led;
	const guildId = String(interaction.guild_id ?? "").trim();

	if (argument.kind === "show") {
		try {
			const links = await fetchGuildChatLinks();
			const link = findGuildChatLink(links, guildName);
			return interaction.editReply({
				embeds: [
					buildGuildChatStateEmbed(guildName, link, {
						title: "Linked guild chat channel",
						...(link
							? link.status === "pending"
								? { description: PENDING_LINK_NOTE }
								: {}
							: { description: "Link a channel and members who play from the launcher talk there as themselves, both ways." }),
					}),
				],
			});
		} catch (error) {
			const missing = error instanceof GameServerAdminError && error.status === 404;
			return interaction.editReply({
				embeds: [
					{
						color: ERROR_COLOR,
						title: "Guild chat channel",
						description: missing
							? "The game server has no `/api/admin/guild-chat` route yet; it needs the guild-chat update deployed before links can be read."
							: `The game server could not be read: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			});
		}
	}

	let channelName: string | null = null;
	let restrictedInDiscord = false;
	if (argument.kind === "channel") {
		const check = await checkGuildChatChannel(argument.channelId, { guildId });
		if (!check.ok) {
			return interaction.editReply({
				embeds: [
					{
						color: ERROR_COLOR,
						title: "Guild chat not linked",
						description: `${check.reason} Nothing was sent to the game server.`,
					},
				],
			});
		}
		channelName = check.channelName;
		restrictedInDiscord = check.restrictedInDiscord;
	}

	const result = await setGuildChatLink({
		guildName,
		guildId: guildId || null,
		channelId: argument.kind === "channel" ? argument.channelId : null,
		channelName,
		requestedBy: interactionActorLabel(interaction),
	});
	return interaction.editReply({
		embeds: [
			buildGuildChatResultEmbed(guildName, result, {
				channelId: argument.kind === "channel" ? argument.channelId : null,
				restrictedInDiscord,
			}),
		],
	});
}

/* ------------------------------------------------------------------
 * The command itself
 * ------------------------------------------------------------------ */

/**
 * Registered globally (scripts/register.ts) like `/lobby-chat`: the leader of an
 * in-game guild links its chat into whichever Discord server they administer.
 * `contexts: [Guild]` keeps it out of DMs, where there is no channel to link.
 */
export const guildChatCommand = {
	data: new CommandBuilder()
		.setName("guild-chat")
		.setDescription("Link the chat of the in-game guild you lead to a channel in this server")
		.setDefaultMemberPermissions(8n)
		.setContexts([CommandContext.Guild])
		.addStringOption((option) =>
			option
				.setName("channel")
				.setDescription(
					"Channel to link (#channel, <#id> or an id), `none` to unlink, or empty to show the current one",
				)
				.setRequired(false),
		),
	handler: handleGuildChat,
};
