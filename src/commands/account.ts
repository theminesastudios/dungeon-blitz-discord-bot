import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CommandBuilder,
  CommandContext,
  IntegrationType,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "@minesa-org/mini-interaction";
import type { APIButtonComponent } from "discord-api-types/v10";
import type { MessageComponentInteraction } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import type { ModalSubmitInteraction } from "@minesa-org/mini-interaction";
import {
  getGameAccountByDiscordId,
  GameAccountConflictError,
  updateGameAccountPassword,
} from "../utils/gameAccount.js";
import { createAccountOAuthUrl } from "../utils/accountOAuth.js";
import { interactionDiscordId } from "../utils/discordInteractions.js";

export const INITIAL_PASSWORD_BUTTON_ID = "account:set-initial-password";
export const INITIAL_PASSWORD_MODAL_ID = "account:initial-password-modal";
export const RESET_PASSWORD_MODAL_ID = "account:reset-password-modal";
const PASSWORD_INPUT_ID = "account:password";
const PASSWORD_CONFIRM_INPUT_ID = "account:password-confirm";

function passwordModal(customId: string, title: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new LabelBuilder()
        .setLabel("New password")
        .setDescription(
          "A 6-128 character password for signing in to Dungeon Blitz.",
        )
        .setComponent(
          new TextInputBuilder()
            .setCustomId(PASSWORD_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setMinLength(6)
            .setMaxLength(128)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Confirm password")
        .setComponent(
          new TextInputBuilder()
            .setCustomId(PASSWORD_CONFIRM_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setMinLength(6)
            .setMaxLength(128)
            .setRequired(true),
        ),
    );
}

async function handlePasswordModal(
  interaction: ModalSubmitInteraction,
  initialOnly: boolean,
) {
  const discordId = interactionDiscordId(interaction);
  if (!discordId) {
    return interaction.reply({
      content: "Your Discord account could not be verified.",
      flags: 64,
    });
  }
  const password = interaction.getTextFieldValue(PASSWORD_INPUT_ID) ?? "";
  const confirmation =
    interaction.getTextFieldValue(PASSWORD_CONFIRM_INPUT_ID) ?? "";
  if (password !== confirmation) {
    return interaction.reply({
      content: "The passwords do not match.",
      flags: 64,
    });
  }

  interaction.deferReply({ flags: 64 });
  try {
    const result = await updateGameAccountPassword(discordId, password, {
      initialOnly,
    });
    if (result.status === "not-found") {
      return interaction.editReply({
        content:
          "Complete the Discord OAuth link from `/create-account` first.",
      });
    }
    if (result.status === "already-configured") {
      return interaction.editReply({
        content:
          "Your initial password is already set. Use `/account reset-password` to change it.",
      });
    }
    return interaction.editReply({
      content: initialOnly
        ? `Your initial password has been set. You can sign in to the game with **${result.account.email}**.`
        : `Your password has been reset. You can sign in to the game with **${result.account.email}**.`,
    });
  } catch (error) {
    if (error instanceof GameAccountConflictError) {
      return interaction.editReply({ content: error.message });
    }
    console.error("[account] Password update failed:", error);
    return interaction.editReply({
      content:
        "Your password could not be updated right now. Please try again later.",
    });
  }
}

export const accountCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("account")
    .setDescription("Manage your Dungeon Blitz account")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription(
          "Create a game account with your verified Discord email",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("reset-password")
        .setDescription("Reset your Dungeon Blitz password"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View your linked Dungeon Blitz account"),
    ),
  handler: async (interaction: CommandInteraction) => {
    const discordId = interactionDiscordId(interaction);
    if (!discordId) {
      return interaction.reply({
        content: "Your Discord account could not be verified.",
        flags: 64,
      });
    }
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "create") {
      const oauthUrl = createAccountOAuthUrl(discordId);
      const row = new ActionRowBuilder<APIButtonComponent>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Verify with Discord")
          .setURL(oauthUrl),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Primary)
          .setLabel("Set initial password")
          .setCustomId(INITIAL_PASSWORD_BUTTON_ID),
      );
      return interaction.reply({
        content: [
          "Complete Discord OAuth verification to create your Dungeon Blitz account.",
          "The account will use your **verified Discord email address**.",
          "After OAuth is complete, return to this message and select **Set initial password**.",
        ].join("\n"),
        components: [row],
        flags: 64,
      });
    }

    if (subcommand === "reset-password") {
      return interaction.showModal(
        passwordModal(RESET_PASSWORD_MODAL_ID, "Reset Dungeon Blitz password"),
      );
    }

    interaction.deferReply({ flags: 64 });
    try {
      const account = await getGameAccountByDiscordId(discordId);
      if (!account) {
        return interaction.editReply({
          content:
            "No Dungeon Blitz account is linked to your Discord account. Create one with `/create-account`.",
        });
      }
      return interaction.editReply({
        embeds: [
          {
            color: 0x5865f2,
            title: "Your Dungeon Blitz account",
            fields: [
              { name: "Email", value: account.email },
              { name: "User ID", value: String(account.userId), inline: true },
              {
                name: "Password",
                value: account.passwordConfigured
                  ? "Set"
                  : "Waiting for initial password",
                inline: true,
              },
            ],
          },
        ],
      });
    } catch (error) {
      console.error("[account] Account view failed:", error);
      return interaction.editReply({
        content:
          "Account information could not be loaded right now. Please try again later.",
      });
    }
  },
};

export const initialPasswordButton = {
  customId: INITIAL_PASSWORD_BUTTON_ID,
  handler: async (interaction: MessageComponentInteraction) => {
    interaction.showModal(
      passwordModal(
        INITIAL_PASSWORD_MODAL_ID,
        "Your initial Dungeon Blitz password",
      ),
    );
  },
};

export const initialPasswordModal = {
  customId: INITIAL_PASSWORD_MODAL_ID,
  handler: (interaction: ModalSubmitInteraction) =>
    handlePasswordModal(interaction, true),
};

export const resetPasswordModal = {
  customId: RESET_PASSWORD_MODAL_ID,
  handler: (interaction: ModalSubmitInteraction) =>
    handlePasswordModal(interaction, false),
};
