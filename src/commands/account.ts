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
import { waitUntil } from "@vercel/functions";
import {
  getGameAccountByDiscordId,
  GameAccountConflictError,
  updateGameAccountPassword,
} from "../utils/gameAccount.js";
import { createAccountOAuthUrl } from "../utils/accountOAuth.js";
import {
  canManageGuild,
  interactionActorLabel,
  interactionDiscordId,
} from "../utils/discordInteractions.js";
import { findGameUserIdForDiscord } from "../utils/gameRewards.js";
import {
  BAN_DURATION_CHOICES,
  banDurationSeconds,
  banGamePlayer,
  formatBanDuration,
  unbanGamePlayer,
  type BanDurationChoice,
} from "../utils/gameModeration.js";
import { publishGameLog, type GameLogField } from "../utils/gameLogChannel.js";

export const INITIAL_PASSWORD_BUTTON_ID = "account:set-initial-password";
export const INITIAL_PASSWORD_MODAL_ID = "account:initial-password-modal";
export const RESET_PASSWORD_MODAL_ID = "account:reset-password-modal";
const PASSWORD_INPUT_ID = "account:password";
const PASSWORD_CONFIRM_INPUT_ID = "account:password-confirm";

const ACCOUNT_COLOR = 0x5865f2;
const BAN_COLOR = 0xe74c3c;
const UNBAN_COLOR = 0x2ecc71;

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
          "Complete the Discord OAuth link from `/account create` first.",
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

/** Reports a moderation action to the operator log without holding up the reply. */
function reportModeration(event: string, title: string, fields: GameLogField[]) {
  const promise = publishGameLog({ event, title, fields });
  try {
    waitUntil(promise);
  } catch {
    void promise.catch(() => {});
  }
}

async function resolveGameUser(discordId: string): Promise<number | null> {
  try {
    return await findGameUserIdForDiscord(discordId);
  } catch (error) {
    console.error("[account] Game account lookup failed:", error);
    return null;
  }
}

/**
 * `/account ban` and `/account unban` are the moderation half of the command. The bot
 * resolves the Discord member to their linked game user and asks the game server to
 * enforce or lift the ban — the game server is the only process that can refuse a login
 * and drop a live session.
 */
async function handleBan(interaction: CommandInteraction) {
  if (!canManageGuild(interaction)) {
    return interaction.reply({
      content:
        "You need the **Manage Server** permission to ban a player from the game.",
      flags: 64,
    });
  }

  const target = interaction.options.getUser("target", true);
  const durationChoice = interaction.options.getString(
    "duration",
    true,
  ) as BanDurationChoice;
  const reason = interaction.options.getString("reason", false)?.trim() || undefined;
  const actorId = interactionDiscordId(interaction);
  const targetId = String(target?.user?.id ?? "").trim();
  if (!targetId) {
    return interaction.reply({
      content: "Pick a valid Discord member to ban.",
      flags: 64,
    });
  }
  if (actorId && targetId === actorId) {
    return interaction.reply({
      content: "You cannot ban yourself.",
      flags: 64,
    });
  }

  const durationSeconds = banDurationSeconds(durationChoice);
  const durationLabel = formatBanDuration(durationSeconds);

  interaction.deferReply({ flags: 64 });
  try {
    const userId = await resolveGameUser(targetId);
    if (userId === null) {
      return interaction.editReply({
        content: `<@${targetId}> has no linked Dungeon Blitz account, so there is nothing to ban.`,
      });
    }

    const result = await banGamePlayer({
      userId,
      durationSeconds,
      reason,
      bannedByDiscordId: actorId,
    });

    reportModeration("game-ban", `🔨 Game ban applied — ${durationLabel}`, [
      { name: "Player", value: `<@${targetId}>`, inline: true },
      { name: "Game user", value: String(result.userId), inline: true },
      { name: "Duration", value: durationLabel, inline: true },
      ...(reason ? [{ name: "Reason", value: reason }] : []),
      { name: "By", value: interactionActorLabel(interaction) },
      ...(result.sessionsClosed !== undefined
        ? [
            {
              name: "Sessions closed",
              value: String(result.sessionsClosed),
              inline: true,
            },
          ]
        : []),
    ]);

    const endsAt = result.expiresAt ? Date.parse(result.expiresAt) : NaN;
    return interaction.editReply({
      embeds: [
        {
          color: BAN_COLOR,
          title: "🔨 Player banned from Dungeon Blitz",
          description: `<@${targetId}> cannot sign in${
            durationSeconds === null
              ? " until the ban is lifted."
              : ` until the ban expires.`
          }`,
          fields: [
            { name: "Game user", value: String(result.userId), inline: true },
            { name: "Duration", value: durationLabel, inline: true },
            ...(Number.isFinite(endsAt)
              ? [
                  {
                    name: "Expires",
                    value: `<t:${Math.floor(endsAt / 1000)}:R>`,
                    inline: true,
                  },
                ]
              : []),
            ...(reason ? [{ name: "Reason", value: reason }] : []),
          ],
          footer: { text: `Banned by ${interactionActorLabel(interaction)}` },
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[account] Ban failed:", error);
    reportModeration("game-ban-error", "⚠️ Game ban failed", [
      { name: "Player", value: `<@${targetId}>`, inline: true },
      { name: "Duration", value: durationLabel, inline: true },
      { name: "Error", value: message.slice(0, 1000) },
    ]);
    return interaction.editReply({
      content: `The ban could not be applied: ${message}`,
    });
  }
}

async function handleUnban(interaction: CommandInteraction) {
  if (!canManageGuild(interaction)) {
    return interaction.reply({
      content:
        "You need the **Manage Server** permission to lift a game ban.",
      flags: 64,
    });
  }

  const target = interaction.options.getUser("target", true);
  const reason = interaction.options.getString("reason", false)?.trim() || undefined;
  const actorId = interactionDiscordId(interaction);
  const targetId = String(target?.user?.id ?? "").trim();
  if (!targetId) {
    return interaction.reply({
      content: "Pick a valid Discord member to unban.",
      flags: 64,
    });
  }

  interaction.deferReply({ flags: 64 });
  try {
    const userId = await resolveGameUser(targetId);
    if (userId === null) {
      return interaction.editReply({
        content: `<@${targetId}> has no linked Dungeon Blitz account.`,
      });
    }

    const result = await unbanGamePlayer({
      userId,
      unbannedByDiscordId: actorId,
    });

    reportModeration("game-unban", "✅ Game ban lifted", [
      { name: "Player", value: `<@${targetId}>`, inline: true },
      { name: "Game user", value: String(result.userId), inline: true },
      ...(reason ? [{ name: "Reason", value: reason }] : []),
      { name: "By", value: interactionActorLabel(interaction) },
    ]);

    return interaction.editReply({
      embeds: [
        {
          color: UNBAN_COLOR,
          title: "✅ Game ban lifted",
          description: `<@${targetId}> can sign in to Dungeon Blitz again.`,
          fields: [
            { name: "Game user", value: String(result.userId), inline: true },
            ...(reason ? [{ name: "Reason", value: reason }] : []),
          ],
          footer: { text: `Lifted by ${interactionActorLabel(interaction)}` },
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[account] Unban failed:", error);
    reportModeration("game-unban-error", "⚠️ Game unban failed", [
      { name: "Player", value: `<@${targetId}>`, inline: true },
      { name: "Error", value: message.slice(0, 1000) },
    ]);
    return interaction.editReply({
      content: `The ban could not be lifted: ${message}`,
    });
  }
}

export const accountCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("account")
    .setDescription("Manage your Dungeon Blitz account")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription(
          "Create a game account with your verified Discord email",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View your linked Dungeon Blitz account"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("reset-password")
        .setDescription("Reset your Dungeon Blitz password"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ban")
        .setDescription("Ban a player from the game for a limited time (staff)")
        .addUserOption((option) =>
          option
            .setName("target")
            .setDescription("The Discord member to ban")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("How long the ban lasts")
            .addChoices(...BAN_DURATION_CHOICES)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Shown to the player and stored in the operator log")
            .setMaxLength(200)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("unban")
        .setDescription("Lift a player's game ban (staff)")
        .addUserOption((option) =>
          option
            .setName("target")
            .setDescription("The Discord member to unban")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Optional note stored in the operator log")
            .setMaxLength(200)
            .setRequired(false),
        ),
    ),
  handler: async (interaction: CommandInteraction) => {
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "ban") return handleBan(interaction);
    if (subcommand === "unban") return handleUnban(interaction);

    const discordId = interactionDiscordId(interaction);
    if (!discordId) {
      return interaction.reply({
        content: "Your Discord account could not be verified.",
        flags: 64,
      });
    }

    if (subcommand === "create") {
      const oauthUrl = await createAccountOAuthUrl(discordId);
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
            "No Dungeon Blitz account is linked to your Discord account. Create one with `/account create`.",
        });
      }
      return interaction.editReply({
        embeds: [
          {
            color: ACCOUNT_COLOR,
            title: "Your Dungeon Blitz account",
            fields: [
              { name: "Email", value: account.email },
              { name: "Game user", value: String(account.userId), inline: true },
              {
                name: "Password",
                value: account.passwordConfigured
                  ? "Set ✅"
                  : "Waiting for initial password ⏳",
                inline: true,
              },
              {
                name: "Connections",
                value:
                  account.connections.length > 0
                    ? account.connections.join(", ")
                    : "None authorized yet — see `/authorize`",
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
