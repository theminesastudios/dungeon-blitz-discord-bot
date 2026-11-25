import {
	CommandBuilder,
	CommandContext,
} from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { handleGuildChat } from "./guild-chat.js";
import { handleLobbyChat } from "./lobby-chat.js";

/**
 * `/lobby` — links the game's chats to a channel in this Discord server.
 *
 *   /lobby guild [channel]  — the chat of the in-game guild the caller leads
 *   /lobby world [channel]  — the game's world (lobby) chat
 *
 * Both take a channel as `#channel`, `<#id>` or an id, `none` to unlink, or nothing to
 * show the channel in use now.
 *
 * The command is global, so it is offered in every server the bot is added to, and
 * Administrator-gated as a whole (`default_member_permissions` cannot differ per
 * subcommand). Each handler checks the Administrator bit again at run time, because a
 * server can widen who sees the command in Integrations. `/lobby guild` also requires
 * the caller's Discord account to be linked to a game account (`/account create`) and
 * one of its characters to be the guild's Guild Master (`guild.rank` 0, the game's
 * GuildHandler.RANK_GUILD_MASTER); officers and members are refused before the game
 * server is asked.
 *
 * `contexts: [Guild]` keeps it out of DMs, where there is no channel to link.
 */

const CHANNEL_OPTION_DESCRIPTION =
	"Channel to link (#channel, <#id> or an id), `none` to unlink, or empty to show the current one";

export async function handleLobby(interaction: CommandInteraction) {
	switch (interaction.options.getSubcommand(true)) {
		case "guild":
			return handleGuildChat(interaction);
		case "world":
			return handleLobbyChat(interaction);
		default:
			return interaction.reply({ content: "Unknown subcommand.", flags: 64 });
	}
}

export const lobbyCommand = {
	data: new CommandBuilder()
		.setName("lobby")
		.setDescription("Link the game's guild or world chat to a channel in this server")
		.setDefaultMemberPermissions(8n)
		.setContexts([CommandContext.Guild])
		.addSubcommand((subcommand) =>
			subcommand
				.setName("guild")
				.setDescription("Link the chat of the in-game guild you lead (Guild Master only)")
				.addStringOption((option) =>
					option
						.setName("channel")
						.setDescription(CHANNEL_OPTION_DESCRIPTION)
						.setRequired(false),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("world")
				.setDescription("Link the game's world (lobby) chat")
				.addStringOption((option) =>
					option
						.setName("channel")
						.setDescription(CHANNEL_OPTION_DESCRIPTION)
						.setRequired(false),
				),
		),
	handler: handleLobby,
};
