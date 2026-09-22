import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	CommandContext,
	IntegrationType,
} from "@minesa-org/mini-interaction";
import type { APIButtonComponent } from "discord-api-types/v10";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionDiscordId } from "../utils/discordInteractions.js";
import { getGameAccountByDiscordId } from "../utils/gameAccount.js";
import {
	DISCORD_CONNECTIONS,
	createAuthorizeOAuthUrl,
	findDiscordConnection,
	isDiscordConnectionChoice,
	type DiscordConnection,
} from "../utils/discordConnections.js";

/**
 * `/authorize` is how a player connects their Discord account to the game's Discord surfaces:
 * the Game Stats widget on their profile, and the Social SDK's friends, rich presence, lobbies
 * and chat.
 *
 * Each link is owner-bound and single-use: the signed `state` carries the invoker's Discord id,
 * so a shared link cannot be completed by anyone else, and only the connections the player
 * picked are asked for. Authorizing is what a player who linked before the widget existed has to
 * do once, and it is also how they refresh after the operator enables game stats — Discord has
 * to be shown the new scopes on its own consent screen, which is why every link sends
 * `prompt=consent`.
 */

const CONNECTION_EMOJI: Record<string, string> = {
	widget: "🎮",
	presence: "👥",
	lobbies: "💬",
	everything: "✅",
};

const WIDGET_STEPS =
	"After you authorize, add it in Discord: open your profile → **Add Widget** → **Dungeon Blitz** → **Add to profile**.";

function connectionEmoji(connection: DiscordConnection): string {
	return CONNECTION_EMOJI[connection.id] ?? "•";
}

function connectionBlock(connection: DiscordConnection): string {
	return `**${connectionEmoji(connection)} ${connection.label}**\n${connection.detail}`;
}

function buttonLabel(connection: DiscordConnection): string {
	return `${connectionEmoji(connection)} ${connection.label}`;
}

/**
 * What the player already has, read from their own account. A missing game account is normal —
 * friends, presence and lobbies do not need one — but the widget needs a save to show, so say
 * which command fixes it. The account store is only consulted for display, so an unreachable
 * database must not stop the player from getting their links.
 */
async function linkedAccountLine(discordId: string): Promise<string | null> {
	try {
		const account = await getGameAccountByDiscordId(discordId);
		if (!account) {
			return "-# No game account is linked yet, and the Game Stats widget needs one. Run **/account create** first — friends, presence and lobbies work without it.";
		}
		const connections =
			account.connections.length > 0 ? account.connections.join(", ") : "none yet";
		return `-# Linked game account **${account.userId}** · widget data: **${account.widgetState ?? "not published yet"}** · connections authorized: ${connections}`;
	} catch (error) {
		console.error("[authorize] Could not read the linked account:", error);
		return null;
	}
}

export const authorizeCommand = {
	data: new CommandBuilder()
		.setContexts([CommandContext.Guild])
		.setIntegrationTypes([IntegrationType.GuildInstall])
		.setName("authorize")
		.setDescription(
			"Connect your Discord account to Dungeon Blitz (profile widget, friends, lobbies)",
		)
		.addStringOption((option) =>
			option
				.setName("connection")
				.setDescription("Only this connection (leave empty to see them all)")
				.setRequired(false)
				// Choice names must be a single unspaced word: CommandBuilder validates them against
				// Discord's command-name rules, which allow letters, digits, `-` and `_` only. The
				// pretty labels live in the message body instead.
				.addChoices(
					{ name: "widget", value: "widget" },
					{ name: "presence", value: "presence" },
					{ name: "lobbies", value: "lobbies" },
					{ name: "everything", value: "everything" },
				),
		),
	handler: async (interaction: CommandInteraction) => {
		const discordId = interactionDiscordId(interaction);
		if (!discordId) {
			return interaction.reply({
				content: "Your Discord account could not be verified.",
				flags: 64,
			});
		}

		const requested = interaction.options.getString("connection", false)?.trim() ?? "";
		if (requested && !isDiscordConnectionChoice(requested)) {
			return interaction.reply({
				content: "That is not one of the connections Dungeon Blitz offers.",
				flags: 64,
			});
		}

		interaction.deferReply({ flags: 64 });

		try {
			const targets = requested
				? [findDiscordConnection(requested)!]
				: [...DISCORD_CONNECTIONS];
			// Built one at a time so the widget switch is read once and every link agrees on it.
			const links: Array<{ target: DiscordConnection; url: string; widgetScopeEnabled: boolean }> =
				[];
			for (const target of targets) {
				const link = await createAuthorizeOAuthUrl(discordId, target.id);
				links.push({ target, ...link });
			}

			const widgetScopeEnabled = links[0]?.widgetScopeEnabled ?? false;
			const blocks = links.map((link) => connectionBlock(link.target));
			const lines = [
				requested
					? blocks.join("\n\n")
					: `**Connect Dungeon Blitz to your Discord account**\n\n${blocks.join("\n\n")}`,
				links.some((link) => link.target.id === "widget" || link.target.id === "everything")
					? WIDGET_STEPS
					: "",
				(await linkedAccountLine(discordId)) ?? "",
				widgetScopeEnabled
					? ""
					: "-# Game Stats widgets are not enabled for this application yet, so the widget link will not ask for widget access.",
				"-# Links are private to you and expire after 10 minutes. Disconnect any time in Discord: **Settings → Authorized Apps → Dungeon Blitz → Deauthorize**.",
			].filter(Boolean);

			const row = new ActionRowBuilder<APIButtonComponent>();
			for (const link of links) {
				row.addComponents(
					new ButtonBuilder()
						.setStyle(ButtonStyle.Link)
						.setLabel(buttonLabel(link.target))
						.setURL(link.url),
				);
			}

			return interaction.editReply({
				content: lines.join("\n\n"),
				components: [row],
			});
		} catch (error) {
			console.error("[authorize] Could not build the authorization links:", error);
			return interaction.editReply({
				content:
					"Authorization links could not be created right now. Please try again later.",
			});
		}
	},
};
