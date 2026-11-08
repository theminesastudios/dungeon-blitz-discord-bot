import {
	CommandBuilder,
	InteractionFlags,
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "@minesa-org/mini-interaction";
import type { CommandInteraction, ModalSubmitInteraction } from "@minesa-org/mini-interaction";
import { interactionActorLabel, isAdministrator } from "../utils/discordInteractions.js";
import { requestGameServerAdmin } from "../utils/gameMaintenance.js";
import { errorMessage, logError } from "../utils/logger.js";

const MAILBOX_MODAL_ID = "mailbox:post-modal";
const TITLE_INPUT_ID = "mailbox:title";
const BODY_INPUT_ID = "mailbox:body";

export const MAILBOX_TITLE_MAX = 80;
export const MAILBOX_BODY_MAX = 4_000;

const EPHEMERAL = InteractionFlags.Ephemeral;

export type MailboxPostResult = {
	ok: true;
	id: number;
	title: string;
	date: string;
	body: string;
	recipients: number;
};

export function postGameMailbox(input: {
	title: string;
	body: string;
	requestedBy: string;
}): Promise<MailboxPostResult> {
	return requestGameServerAdmin<MailboxPostResult>(
		"/api/admin/mailbox",
		{ title: input.title.trim(), body: input.body.trim(), requestedBy: input.requestedBy },
		"the mailbox note",
	);
}

function mailboxModal() {
	return new ModalBuilder()
		.setCustomId(MAILBOX_MODAL_ID)
		.setTitle("Send to the keep mailbox")
		.addComponents(
			new LabelBuilder()
				.setLabel("Title")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(TITLE_INPUT_ID)
						.setStyle(TextInputStyle.Short)
						.setMaxLength(MAILBOX_TITLE_MAX)
						.setRequired(true),
				),
			new LabelBuilder()
				.setLabel("Message")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(BODY_INPUT_ID)
						.setStyle(TextInputStyle.Paragraph)
						.setMaxLength(MAILBOX_BODY_MAX)
						.setRequired(true),
				),
		);
}

async function handleMailbox(interaction: CommandInteraction) {
	if (!isAdministrator(interaction)) {
		return interaction.reply({ content: "Administrator permission is required.", flags: EPHEMERAL });
	}
	return interaction.showModal(mailboxModal());
}

async function handleMailboxSubmit(interaction: ModalSubmitInteraction) {
	if (!isAdministrator(interaction)) {
		return interaction.reply({ content: "Administrator permission is required.", flags: EPHEMERAL });
	}
	const title = (interaction.getTextFieldValue(TITLE_INPUT_ID) ?? "").trim();
	const body = (interaction.getTextFieldValue(BODY_INPUT_ID) ?? "").trim();
	if (!title || !body) {
		return interaction.reply({ content: "Title and message are required.", flags: EPHEMERAL });
	}

	interaction.deferReply({ flags: EPHEMERAL });
	try {
		const result = await postGameMailbox({
			title,
			body,
			requestedBy: interactionActorLabel(interaction),
		});
		return interaction.editReply({
			embeds: [
				{
					color: 0x2ecc71,
					title: `📬 Mailbox note #${result.id} sent`,
					description: `**${result.title}** — ${result.date}\n\n${result.body.slice(0, 3_500)}`,
					footer: { text: `${result.recipients} online player(s) notified` },
				},
			],
		});
	} catch (error) {
		logError("mailbox", "Mailbox note failed", { error: errorMessage(error) });
		return interaction.editReply({ content: `❌ Not sent: ${errorMessage(error)}` });
	}
}

export const mailboxCommand = {
	data: new CommandBuilder()
		.setName("mailbox")
		.setDescription("Send a note to the in-game keep mailbox")
		.setDefaultMemberPermissions(8n),
	handler: (interaction: CommandInteraction) => handleMailbox(interaction),
};

export const mailboxModalHandler = {
	customId: MAILBOX_MODAL_ID,
	handler: (interaction: ModalSubmitInteraction) => handleMailboxSubmit(interaction),
};
