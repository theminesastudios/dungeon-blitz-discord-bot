import { CommandBuilder, InteractionFlags } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionDiscordId } from "../utils/discordInteractions.js";
import { errorMessage, logInfo, logWarn } from "../utils/logger.js";
import {
	DEFAULT_LINES,
	MAX_LINES,
	editOriginalWithFile,
	fetchServerLogs,
	renderLogsMessage,
	renderLogsText,
	type LogStreamChoice,
} from "../utils/gameServerLogs.js";

/**
 * `/diagnose logs` — read the end of the live game server's pm2 logs from Discord.
 *
 * Read-only: it asks the game server for log lines (filtered by a plain substring) and shows
 * them; nothing is executed there. Even so, logs name players and e-mail addresses, so the
 * command answers only the Discord accounts listed in DIAGNOSE_USER_IDS (by default the owner's)
 * and always ephemerally.
 */

const DEFAULT_ALLOWED_USER_IDS = ["285118390031351809"];

export function allowedDiagnoseUsers(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const configured = String(env.DIAGNOSE_USER_IDS ?? "")
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter((id) => /^\d{5,25}$/.test(id));
	return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_USER_IDS);
}

function parseStream(value: string | null): LogStreamChoice {
	return value === "error" || value === "out" ? value : "both";
}

async function handleLogs(interaction: CommandInteraction): Promise<unknown> {
	const filter = (interaction.options.getString("filter", false) ?? "").trim();
	const requestedLines = interaction.options.getNumber("lines", false);
	const lines = Math.min(MAX_LINES, Math.max(1, Math.floor(requestedLines ?? DEFAULT_LINES)));
	const stream = parseStream(interaction.options.getString("stream", false));
	const user = interactionDiscordId(interaction);

	interaction.deferReply({ flags: InteractionFlags.Ephemeral });
	try {
		const logs = await fetchServerLogs({ filter, lines, stream });
		const message = renderLogsMessage(logs);
		logInfo("diagnose", "logs", { user, filter, lines, stream, inline: message.fitsInline });
		if (message.fitsInline) {
			return interaction.editReply({ content: message.content, allowed_mentions: { parse: [] } } as never);
		}
		const raw = interaction as unknown as { application_id?: string; token?: string };
		const applicationId = String(raw.application_id ?? process.env.DISCORD_APPLICATION_ID ?? "").trim();
		const token = String(raw.token ?? "").trim();
		try {
			await editOriginalWithFile({
				applicationId,
				token,
				content: message.content,
				fileName: `${logs.pm2App}-logs.txt`,
				fileText: renderLogsText(logs),
			});
			return undefined;
		} catch (error) {
			// The newest lines are still worth having when the upload fails.
			logWarn("diagnose", "attachment_failed", { user, error: errorMessage(error) });
			return interaction.editReply({
				content: `${message.content.slice(0, 1_800)}\n-# The full log could not be attached: ${errorMessage(error)}`,
			});
		}
	} catch (error) {
		logWarn("diagnose", "logs_failed", { user, error: errorMessage(error) });
		return interaction.editReply({ content: `⚠️ **Could not read the logs:** ${errorMessage(error)}` });
	}
}

export const diagnoseCommand = {
	data: new CommandBuilder()
		.setName("diagnose")
		.setDescription("Read the live game server's logs (owner only)")
		.setDefaultMemberPermissions(8n)
		.addSubcommand((sub) =>
			sub
				.setName("logs")
				.setDescription("The last lines of the game server's pm2 logs")
				.addStringOption((option) =>
					option
						.setName("filter")
						.setDescription("Only lines containing this text (e.g. Login, Router, an e-mail)")
						.setMaxLength(100)
						.setRequired(false),
				)
				.addNumberOption((option) =>
					option
						.setName("lines")
						.setDescription(`How many lines per log (default ${DEFAULT_LINES}, at most ${MAX_LINES})`)
						.setMinValue(1)
						.setMaxValue(MAX_LINES)
						.setRequired(false),
				)
				.addStringOption((option) =>
					option
						.setName("stream")
						.setDescription("Which log (default both)")
						.addChoices(
							{ name: "both", value: "both" },
							{ name: "errors", value: "error" },
							{ name: "output", value: "out" },
						)
						.setRequired(false),
				),
		),
	handler: async (interaction: CommandInteraction) => {
		const user = interactionDiscordId(interaction);
		if (!allowedDiagnoseUsers().has(user)) {
			logWarn("diagnose", "refused", { user });
			return interaction.reply({
				content: "This command is not available to you.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		const subcommand = interaction.options.getSubcommand(false);
		if (subcommand === "logs") {
			return handleLogs(interaction);
		}
		return interaction.reply({ content: "Unknown subcommand.", flags: InteractionFlags.Ephemeral });
	},
};
