import {
	CommandBuilder,
	CommandContext,
	IntegrationType,
	InteractionFlags,
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "@minesa-org/mini-interaction";
import type { CommandInteraction, ModalSubmitInteraction } from "@minesa-org/mini-interaction";
import {
	buildIssueBody,
	createBugReportIssue,
	getReportCooldownRemainingMs,
	normalizeIssueTitle,
	recordBugReport,
	type IssueFailureReason,
} from "../utils/githubIssues.js";
import { interactionDiscordId } from "../utils/discordInteractions.js";
import { errorMessage, logError, logWarn } from "../utils/logger.js";

const REPORT_BUG_MODAL_ID = "bug:report-modal";
const TITLE_INPUT_ID = "bug:title";
const DESCRIPTION_INPUT_ID = "bug:description";
const STEPS_INPUT_ID = "bug:steps";

const MIN_TITLE_LENGTH = 4;
const MAX_DESCRIPTION_LENGTH = 2000;
const MIN_DESCRIPTION_LENGTH = 10;

/** A guild name is a nicety for triage, not worth spending the interaction budget on. */
const GUILD_NAME_TIMEOUT_MS = 2_000;

const EPHEMERAL = InteractionFlags.Ephemeral;

/* ------------------------------------------------------------------
 * Pure helpers
 *
 * Exported for tests: none of these touch the network, so the rules that
 * shape a report can be asserted directly.
 * ------------------------------------------------------------------ */

/** Human-facing wait, rounded up so "0 minutes left" never reads as a block. */
export function formatCooldownRemaining(ms: number): string {
	const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
	if (totalMinutes < 60) {
		return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	const hourPart = `${hours} hour${hours === 1 ? "" : "s"}`;
	return minutes > 0 ? `${hourPart} ${minutes} minute${minutes === 1 ? "" : "s"}` : hourPart;
}

/**
 * Validates the modal fields. Returns the field error for the player, or `null` when
 * the report is good to file.
 */
export function validateReportInput(input: {
	title: string;
	description: string;
}): string | null {
	const title = input.title.trim();
	if (title.length < MIN_TITLE_LENGTH) {
		return `Give the bug a title of at least ${MIN_TITLE_LENGTH} characters.`;
	}
	const description = input.description.trim();
	if (description.length < MIN_DESCRIPTION_LENGTH) {
		return `Please describe the bug in at least ${MIN_DESCRIPTION_LENGTH} characters.`;
	}
	return null;
}

/**
 * Turns a GitHub failure into what the player is told. Operational causes are logged
 * separately, so the player never sees a token or a repository name.
 */
export function describeFailure(reason: IssueFailureReason): string {
	switch (reason) {
		case "not-configured":
			return "Bug reporting is not set up on the bot right now. Please tell an admin.";
		case "unauthorized":
		case "forbidden":
		case "not-found":
			return "The bot could not reach the bug tracker. Please tell an admin.";
		case "rate-limited":
			return "The bug tracker is busy right now. Please try again in a few minutes.";
		default:
			return "Something went wrong reaching the bug tracker. Please try again shortly.";
	}
}

/* ------------------------------------------------------------------
 * Modal
 * ------------------------------------------------------------------ */

function reportModal() {
	return new ModalBuilder()
		.setCustomId(REPORT_BUG_MODAL_ID)
		.setTitle("Report a bug")
		.addComponents(
			new LabelBuilder()
				.setLabel("What went wrong?")
				.setDescription("A short summary.")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(TITLE_INPUT_ID)
						.setStyle(TextInputStyle.Short)
						.setMinLength(MIN_TITLE_LENGTH)
						.setMaxLength(120)
						.setRequired(true),
				),
			new LabelBuilder()
				.setLabel("Details")
				.setDescription("What did you expect, and what happened instead?")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(DESCRIPTION_INPUT_ID)
						.setStyle(TextInputStyle.Paragraph)
						.setMinLength(MIN_DESCRIPTION_LENGTH)
						.setMaxLength(MAX_DESCRIPTION_LENGTH)
						.setRequired(true),
				),
			new LabelBuilder()
				.setLabel("Steps to reproduce (optional)")
				.setDescription("What did you do just before it went wrong?")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(STEPS_INPUT_ID)
						.setStyle(TextInputStyle.Paragraph)
						.setMaxLength(MAX_DESCRIPTION_LENGTH)
						.setRequired(false),
				),
		);
}

/* ------------------------------------------------------------------
 * Command + modal handlers
 * ------------------------------------------------------------------ */

async function handleReportBug(interaction: CommandInteraction) {
	const discordId = interactionDiscordId(interaction);

	// Checked up front so someone on cooldown is told before filling in the form. The
	// submit handler re-checks, because a modal can sit open past the cooldown.
	const remaining = await getReportCooldownRemainingMs(discordId);
	if (remaining > 0) {
		return interaction.reply({
			content: `You can report another bug in ${formatCooldownRemaining(remaining)}. If the one you already filed is still broken, reply to the confirmation you got instead.`,
			flags: EPHEMERAL,
		});
	}

	return interaction.showModal(reportModal());
}

async function handleReportBugSubmit(interaction: ModalSubmitInteraction) {
	const title = interaction.getTextFieldValue(TITLE_INPUT_ID) ?? "";
	const description = interaction.getTextFieldValue(DESCRIPTION_INPUT_ID) ?? "";
	const steps = interaction.getTextFieldValue(STEPS_INPUT_ID) ?? "";

	const problem = validateReportInput({ title, description });
	if (problem) {
		return interaction.reply({ content: problem, flags: EPHEMERAL });
	}

	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return interaction.reply({
			content: "Your Discord account could not be verified.",
			flags: EPHEMERAL,
		});
	}

	// Authoritative cooldown check: the form may have been open for a long time.
	const remaining = await getReportCooldownRemainingMs(discordId);
	if (remaining > 0) {
		return interaction.reply({
			content: `You can report another bug in ${formatCooldownRemaining(remaining)}.`,
			flags: EPHEMERAL,
		});
	}

	// Acknowledge before any network call so a slow GitHub can never blow the
	// 3-second window and leave the player on an endless "thinking…".
	interaction.deferReply({ flags: EPHEMERAL });

	const guildId = String(interaction.guild_id ?? "").trim() || null;
	const username = String(interaction.user?.username ?? "").trim();

	try {
		const issueTitle = normalizeIssueTitle(title);
		const result = await createBugReportIssue({
			title: issueTitle,
			body: buildIssueBody({
				reporterId: discordId,
				reporterUsername: username || null,
				guildName: await fetchGuildName(guildId),
				guildId,
				description: description.trim(),
				steps: steps.trim(),
				submittedAt: new Date(),
			}),
		});

		if (!result.ok) {
			// not-configured and a permission failure are operator problems, not player
			// problems, so they get a log line and nothing is echoed back to Discord.
			if (result.reason === "not-configured" || result.reason === "forbidden" || result.reason === "not-found") {
				logError("report-bug", "Could not file report", {
					reason: result.reason,
					detail: result.detail,
				});
			} else {
				logWarn("report-bug", "Report could not be filed", {
					reason: result.reason,
					detail: result.detail,
				});
			}
			return interaction.editReply({ content: describeFailure(result.reason) });
		}

		await recordBugReport(discordId, {
			number: result.number,
			url: result.url,
			title: issueTitle,
		});

		// The number rather than the link: the tracker is private, so a player following
		// the URL would only meet a 403.
		return interaction.editReply({
			content: `Thanks — logged as **#${result.number}**. The team will take a look. Quote that number if you follow up.`,
		});
	} catch (error) {
		logError("report-bug", "Unexpected failure while filing a report", {
			error: errorMessage(error),
		});
		return interaction.editReply({ content: describeFailure("unavailable") });
	}
}

/**
 * Best-effort guild name for triage. Returns null on any failure — the report is
 * still worth filing without it.
 */
async function fetchGuildName(guildId: string | null): Promise<string | null> {
	const token = process.env.DISCORD_BOT_TOKEN?.trim();
	if (!guildId || !token) return null;

	try {
		const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
			headers: { Authorization: `Bot ${token}` },
			signal: AbortSignal.timeout(GUILD_NAME_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as { name?: unknown };
		const name = String(payload.name ?? "").trim();
		return name || null;
	} catch {
		return null;
	}
}

export const reportBugCommand = {
	data: new CommandBuilder()
		.setContexts([CommandContext.Guild])
		.setIntegrationTypes([IntegrationType.GuildInstall])
		.setName("report-bug")
		.setDescription("Report a bug to the team")
		.setDMPermission(false),
	handler: (interaction: CommandInteraction) => handleReportBug(interaction),
};

export const reportBugModal = {
	customId: REPORT_BUG_MODAL_ID,
	handler: (interaction: ModalSubmitInteraction) => handleReportBugSubmit(interaction),
};
