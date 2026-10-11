import {
  ButtonBuilder,
  ButtonStyle,
  CommandBuilder,
  ContainerBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "@minesa-org/mini-interaction";
import type {
  CommandInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "@minesa-org/mini-interaction";
import {
  getGameAccountByDiscordId,
  getHomeUpgradeNotices,
  GameAccountConflictError,
  setHomeUpgradeNotices,
  updateGameAccountPassword,
  type PublicGameAccount,
} from "../utils/gameAccount.js";
import { createAccountOAuthUrl } from "../utils/accountOAuth.js";
import { interactionDiscordId } from "../utils/discordInteractions.js";
import {
  buildPortraitUrl,
  listSaveCharacters,
  type GameWalletSummary,
} from "../utils/gameWallet.js";
import { characterPlaytimeKey, formatPlaytime } from "../utils/playtime.js";
import {
  characterSubtitle,
  currentQuest,
  formatQuest,
} from "../utils/characterDisplay.js";
import {
  deleteGameCharacter,
  renameGameCharacter,
  RENAME_COST_IDOLS,
  validateCharacterName,
} from "../utils/gameCharacterAdmin.js";
import {
  COLORS,
  buttonRow,
  divider,
  errorNotice,
  formatNumber,
  notice,
  section,
  text,
  thumbnail,
  v2,
  v2Update,
} from "../ui/containers.js";
import { classEmoji, componentEmoji, emoji } from "../ui/emojis.js";

/*
 * `/account view` is the player's one-stop panel: their current character up top, every
 * character with a View button, and the account settings (password, upgrade DMs) as buttons.
 * Every follow-up happens on that ephemeral message, so the player never needs another
 * command. Rename and Delete each ask "are you sure?" in a separate ephemeral message, and
 * every action re-reads the account when it runs — a stale panel can never act on a character
 * that was already renamed, deleted, or moved off the account.
 */

const ID = {
  home: "account:home",
  view: "account:view:",
  rename: "account:rename:",
  renameModal: "account:rename-modal:",
  renameConfirm: "account:rename-yes:",
  delete: "account:delete:",
  deleteConfirm: "account:delete-yes:",
  dismiss: "account:dismiss",
  password: "account:password:",
  notifications: "account:notifications",
} as const;
export const ACCOUNT_IDS = ID;

const INITIAL_PASSWORD_MODAL_ID = "account:initial-password-modal";
const RESET_PASSWORD_MODAL_ID = "account:reset-password-modal";
const PASSWORD_INPUT_ID = "account:password";
const PASSWORD_CONFIRM_INPUT_ID = "account:password-confirm";
const NEW_NAME_INPUT_ID = "account:new-name";

/** Discord allows 40 components per message; the roster stops well before that. */
const MAX_LISTED_CHARACTERS = 10;

const NO_ACCOUNT_TEXT =
  "No Dungeon Blitz account is linked to your Discord account yet. Create one with `/account create`.";
const UNVERIFIED_TEXT = "Your Discord account could not be verified.";

/** Character names travel in custom ids; encoding keeps a stray `:` from splitting them. */
function encodeName(name: string): string {
  return encodeURIComponent(name);
}

function decodeName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The `<name>` (or `<old>:<new>`) tail of a custom id after its prefix. */
export function customIdNames(customId: string, prefix: string): string[] {
  return customId.slice(prefix.length).split(":").map(decodeName).filter(Boolean);
}

type AccountState = {
  account: PublicGameAccount;
  characters: GameWalletSummary[];
  notices: boolean;
};

async function loadAccountState(discordId: string): Promise<AccountState | null> {
  const account = await getGameAccountByDiscordId(discordId);
  if (!account) return null;
  const [characters, notices] = await Promise.all([
    listSaveCharacters(account.userId),
    getHomeUpgradeNotices(discordId),
  ]);
  return { account, characters, notices: notices !== false };
}

/** The character played most recently; highest level when the save never recorded play. */
export function pickCurrentCharacter(characters: GameWalletSummary[]): GameWalletSummary | null {
  let current: GameWalletSummary | null = null;
  for (const character of characters) {
    if (
      !current ||
      character.lastPlayedMs > current.lastPlayedMs ||
      (character.lastPlayedMs === current.lastPlayedMs &&
        character.characterLevel > current.characterLevel)
    ) {
      current = character;
    }
  }
  return current;
}

function findCharacter(state: AccountState, name: string): GameWalletSummary | null {
  const wanted = name.trim().toLowerCase();
  return state.characters.find((c) => c.characterName.toLowerCase() === wanted) ?? null;
}

/** Idols are account-wide, so any character's balance is the account's. */
function accountIdols(characters: GameWalletSummary[]): number {
  return characters.reduce((max, c) => Math.max(max, c.mammothIdols), 0);
}

function characterPlaytime(state: AccountState, character: GameWalletSummary): string {
  return formatPlaytime(state.account.characterPlaytimeMs[characterPlaytimeKey(character.characterName)]);
}

/* ------------------------------------------------------------------ panels */

export function buildDashboard(state: AccountState, displayName: string): ContainerBuilder {
  const { account, characters } = state;
  const current = pickCurrentCharacter(characters);
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.brand)
    .addComponent(text(`## ${emoji("ui_character")} ${displayName}`))
    .addComponent(
      text(
        `-# Game user ${account.userId} · ${emoji("cur_idol")} ${formatNumber(accountIdols(characters))} Mammoth Idols · Playtime ${formatPlaytime(account.playtimeMs)}`,
      ),
    )
    .addComponent(divider());

  if (current) {
    const heading = `**Current character**\n### ${classEmoji(current.characterClass)} ${current.characterName}\n${characterSubtitle(current)}`;
    const portrait = buildPortraitUrl(current);
    container.addComponent(
      portrait
        ? section(heading, thumbnail(portrait, current.characterName))
        : text(heading),
    );
  } else {
    container.addComponent(
      text("**No characters yet**\n-# Sign in to Dungeon Blitz and create your first hero."),
    );
  }

  if (characters.length > 0) {
    container.addComponent(divider()).addComponent(text(`**Characters** · ${characters.length}`));
    for (const character of characters.slice(0, MAX_LISTED_CHARACTERS)) {
      container.addComponent(
        section(
          `${classEmoji(character.characterClass)} **${character.characterName}**\n${characterSubtitle(character)}`,
          new ButtonBuilder()
            .setStyle(ButtonStyle.Secondary)
            .setLabel("View")
            .setCustomId(`${ID.view}${encodeName(character.characterName)}`),
        ),
      );
    }
    if (characters.length > MAX_LISTED_CHARACTERS) {
      container.addComponent(
        text(`-# …and ${characters.length - MAX_LISTED_CHARACTERS} more`),
      );
    }
  }

  container.addComponent(divider()).addComponent(
    buttonRow(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel(account.passwordConfigured ? "Reset password" : "Set password")
        .setCustomId(`${ID.password}${account.passwordConfigured ? "reset" : "initial"}`),
      new ButtonBuilder()
        .setStyle(state.notices ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setLabel(state.notices ? "Upgrade DMs: On" : "Upgrade DMs: Off")
        .setCustomId(ID.notifications),
    ),
  );
  if (!account.passwordConfigured) {
    container.addComponent(
      text("-# Set a password to sign in to the game with your Discord email."),
    );
  }
  return container;
}

export function buildCharacterDetail(state: AccountState, character: GameWalletSummary): ContainerBuilder {
  const heading = `## ${classEmoji(character.characterClass)} ${character.characterName}\n${characterSubtitle(character)}`;
  const portrait = buildPortraitUrl(character);
  const balances = [
    `${emoji("cur_gold")} Gold **${formatNumber(character.gold)}** · ${emoji("cur_idol")} Mammoth Idols **${formatNumber(character.mammothIdols)}**`,
    `${emoji("cur_dragon_key")} Dragon Keys **${formatNumber(character.dragonKeys)}** · ${emoji("cur_dragon_ore")} Dragon Ore **${formatNumber(character.dragonOre)}**`,
    `${emoji("cur_silver_sigil")} Silver Sigils **${formatNumber(character.silverSigils)}** · ${emoji("cur_royal_sigil")} Royal Sigils **${formatNumber(character.royalSigils)}**`,
  ];
  return new ContainerBuilder()
    .setAccentColor(COLORS.brand)
    .addComponent(portrait ? section(heading, thumbnail(portrait, character.characterName)) : text(heading))
    .addComponent(divider())
    .addComponent(text(balances.join("\n")))
    .addComponent(
      text(
        `${emoji("ui_quest")} ${formatQuest(currentQuest(character.missions))}\n-# Playtime ${characterPlaytime(state, character)}`,
      ),
    )
    .addComponent(divider())
    .addComponent(
      buttonRow(
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Back").setCustomId(ID.home),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Primary)
          .setLabel(`Rename · ${RENAME_COST_IDOLS} idols`)
          .setEmoji(componentEmoji("ui_rename"))
          .setCustomId(`${ID.rename}${encodeName(character.characterName)}`),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Danger)
          .setLabel("Delete")
          .setEmoji(componentEmoji("ui_delete"))
          .setCustomId(`${ID.delete}${encodeName(character.characterName)}`),
      ),
    );
}

function dismissButton(label = "Cancel") {
  return new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(label).setCustomId(ID.dismiss);
}

export function buildRenameConfirm(character: GameWalletSummary, newName: string, idols: number): ContainerBuilder {
  const affordable = idols >= RENAME_COST_IDOLS;
  return notice(
    affordable ? COLORS.warning : COLORS.danger,
    "Rename this character?",
    [
      `**${character.characterName}** → **${newName}**`,
      `${emoji("cur_idol")} Costs **${RENAME_COST_IDOLS}** Mammoth Idols · you have **${formatNumber(idols)}**`,
      "-# Log out of the game first — a character cannot be renamed while you are signed in.",
    ],
    [
      buttonRow(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Primary)
          .setLabel(`Rename for ${RENAME_COST_IDOLS} idols`)
          .setDisabled(!affordable)
          .setCustomId(`${ID.renameConfirm}${encodeName(character.characterName)}:${encodeName(newName)}`),
        dismissButton(),
      ),
    ],
  );
}

export function buildDeleteConfirm(character: GameWalletSummary): ContainerBuilder {
  return notice(
    COLORS.danger,
    "Delete this character?",
    [
      `${classEmoji(character.characterClass)} **${character.characterName}**`,
      characterSubtitle(character),
      "",
      "This removes the character, its gear and its progress from your account. **It cannot be undone from Discord.**",
      "-# Log out of the game first — a character cannot be deleted while you are signed in.",
    ],
    [
      buttonRow(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Danger)
          .setLabel(`Delete ${character.characterName}`)
          .setCustomId(`${ID.deleteConfirm}${encodeName(character.characterName)}`),
        dismissButton("Keep it"),
      ),
    ],
  );
}

/* ------------------------------------------------------------------ helpers */

function interactionDisplayName(
  interaction: CommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
): string {
  const raw = interaction as unknown as {
    member?: { nick?: string | null; user?: { global_name?: string | null; username?: string } };
    user?: { global_name?: string | null; username?: string };
  };
  const user = raw.member?.user ?? raw.user;
  return raw.member?.nick || user?.global_name || user?.username || "Your account";
}

function passwordModal(customId: string, title: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new LabelBuilder()
        .setLabel("New password")
        .setDescription("A 6-128 character password for signing in to Dungeon Blitz.")
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

function renameModal(character: string) {
  return new ModalBuilder()
    .setCustomId(`${ID.renameModal}${encodeName(character)}`)
    .setTitle(`Rename ${character}`.slice(0, 45))
    .addComponents(
      new LabelBuilder()
        .setLabel("New name")
        .setDescription(`3-16 letters or digits. Costs ${RENAME_COST_IDOLS} Mammoth Idols.`)
        .setComponent(
          new TextInputBuilder()
            .setCustomId(NEW_NAME_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(16)
            .setRequired(true),
        ),
    );
}

/* ------------------------------------------------------------------ command */

async function handleCreate(interaction: CommandInteraction, discordId: string) {
  const oauthUrl = await createAccountOAuthUrl(discordId);
  return interaction.reply(
    v2(
      notice(
        COLORS.brand,
        "Create your Dungeon Blitz account",
        [
          "1. **Verify with Discord** — the account uses your verified Discord email address.",
          "2. Come back here and **Set password**.",
          "-# Already verified? Open `/account view` to see your characters.",
        ],
        [
          buttonRow(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Verify with Discord").setURL(oauthUrl),
            new ButtonBuilder()
              .setStyle(ButtonStyle.Primary)
              .setLabel("Set password")
              .setCustomId(`${ID.password}initial`),
          ),
        ],
      ),
    ),
  );
}

async function handleView(interaction: CommandInteraction, discordId: string) {
  interaction.deferReply({ flags: 64 });
  try {
    const state = await loadAccountState(discordId);
    if (!state) {
      return interaction.editReply(v2(notice(COLORS.muted, "No account yet", NO_ACCOUNT_TEXT)));
    }
    return interaction.editReply(v2(buildDashboard(state, interactionDisplayName(interaction))));
  } catch (error) {
    console.error("[account] Account view failed:", error);
    return interaction.editReply(
      errorNotice("Account information could not be loaded right now. Please try again later."),
    );
  }
}

export const accountCommand = {
  data: new CommandBuilder()
    .setName("account")
    .setDescription("Your Dungeon Blitz account")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("Your characters, password and notification settings"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a game account with your verified Discord email"),
    ),
  handler: async (interaction: CommandInteraction) => {
    const discordId = interactionDiscordId(interaction);
    if (!discordId) return interaction.reply(errorNotice(UNVERIFIED_TEXT));
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === "create") return handleCreate(interaction, discordId);
    return handleView(interaction, discordId);
  },
};

/* ------------------------------------------------------------------ components */

/**
 * Runs a panel action against the account as it is right now. The panel the button sits on
 * may be minutes old, so nothing it showed is trusted.
 */
async function withAccount(
  interaction: MessageComponentInteraction,
  run: (state: AccountState, discordId: string) => Promise<unknown>,
) {
  const discordId = interactionDiscordId(interaction);
  if (!discordId) return interaction.reply(errorNotice(UNVERIFIED_TEXT));
  interaction.deferUpdate();
  try {
    const state = await loadAccountState(discordId);
    if (!state) {
      return interaction.editReply(v2Update(notice(COLORS.muted, "No account yet", NO_ACCOUNT_TEXT)));
    }
    return await run(state, discordId);
  } catch (error) {
    console.error("[account] Panel action failed:", error);
    return interaction.editReply(
      v2Update(notice(COLORS.danger, "Something went wrong", "Your account could not be loaded right now. Please try again later.")),
    );
  }
}

const characterGone = (name: string) =>
  v2Update(
    notice(COLORS.muted, "Character not found", `**${name}** is no longer on your account.`, [
      buttonRow(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Back").setCustomId(ID.home)),
    ]),
  );

export const accountHomeButton = {
  customId: ID.home,
  handler: (interaction: MessageComponentInteraction) =>
    withAccount(interaction, (state) =>
      interaction.editReply(v2Update(buildDashboard(state, interactionDisplayName(interaction)))),
    ),
};

export const accountViewButton = {
  customId: `${ID.view}*`,
  handler: (interaction: MessageComponentInteraction) => {
    const [name = ""] = customIdNames(interaction.data.custom_id, ID.view);
    return withAccount(interaction, (state) => {
      const character = findCharacter(state, name);
      if (!character) return interaction.editReply(characterGone(name));
      return interaction.editReply(v2Update(buildCharacterDetail(state, character)));
    });
  },
};

export const accountNotificationsButton = {
  customId: ID.notifications,
  handler: (interaction: MessageComponentInteraction) =>
    withAccount(interaction, async (state, discordId) => {
      // Flip what is stored now, not what the panel showed: the panel may be stale.
      const next = !state.notices;
      await setHomeUpgradeNotices(discordId, next);
      return interaction.editReply(
        v2Update(buildDashboard({ ...state, notices: next }, interactionDisplayName(interaction))),
      );
    }),
};

export const accountRenameButton = {
  customId: `${ID.rename}*`,
  handler: async (interaction: MessageComponentInteraction) => {
    // A modal has to be the first response, so ownership is checked when it is submitted.
    const [name = ""] = customIdNames(interaction.data.custom_id, ID.rename);
    return interaction.showModal(renameModal(name));
  },
};

export const accountRenameModal = {
  customId: `${ID.renameModal}*`,
  handler: async (interaction: ModalSubmitInteraction) => {
    const discordId = interactionDiscordId(interaction);
    if (!discordId) return interaction.reply(errorNotice(UNVERIFIED_TEXT));
    const [oldName = ""] = customIdNames(interaction.data.custom_id, ID.renameModal);
    const validated = validateCharacterName(interaction.getTextFieldValue(NEW_NAME_INPUT_ID) ?? "");
    if (!validated.ok) {
      return interaction.reply(v2(notice(COLORS.danger, "That name will not work", validated.reason)));
    }
    if (validated.name.toLowerCase() === oldName.toLowerCase()) {
      return interaction.reply(v2(notice(COLORS.muted, "Same name", "Pick a name that is different from the current one.")));
    }

    interaction.deferReply({ flags: 64 });
    try {
      const state = await loadAccountState(discordId);
      const character = state ? findCharacter(state, oldName) : null;
      if (!state || !character) {
        return interaction.editReply(v2(notice(COLORS.muted, "Character not found", `**${oldName}** is no longer on your account.`)));
      }
      return interaction.editReply(
        v2(buildRenameConfirm(character, validated.name, accountIdols(state.characters))),
      );
    } catch (error) {
      console.error("[account] Rename preview failed:", error);
      return interaction.editReply(errorNotice("Your account could not be loaded right now. Please try again later."));
    }
  },
};

export const accountRenameConfirmButton = {
  customId: `${ID.renameConfirm}*`,
  handler: (interaction: MessageComponentInteraction) => {
    const [oldName = "", newName = ""] = customIdNames(interaction.data.custom_id, ID.renameConfirm);
    return withAccount(interaction, async (state, discordId) => {
      const character = findCharacter(state, oldName);
      if (!character) return interaction.editReply(characterGone(oldName));
      const validated = validateCharacterName(newName);
      if (!validated.ok) {
        return interaction.editReply(v2Update(notice(COLORS.danger, "That name will not work", validated.reason)));
      }
      const result = await renameGameCharacter({
        userId: state.account.userId,
        characterName: character.characterName,
        newName: validated.name,
        requestedByDiscordId: discordId,
      });
      if (!result.ok) {
        return interaction.editReply(v2Update(notice(COLORS.danger, "Rename failed", result.message)));
      }
      return interaction.editReply(
        v2Update(
          notice(COLORS.success, "Character renamed", [
            `**${result.oldName}** is now **${result.newName}**.`,
            `${emoji("cur_idol")} ${formatNumber(result.idolsBefore)} → **${formatNumber(result.idolsAfter)}** Mammoth Idols`,
            "-# Open `/account view` again to see the updated roster.",
          ]),
        ),
      );
    });
  },
};

export const accountDeleteButton = {
  customId: `${ID.delete}*`,
  handler: async (interaction: MessageComponentInteraction) => {
    const discordId = interactionDiscordId(interaction);
    if (!discordId) return interaction.reply(errorNotice(UNVERIFIED_TEXT));
    const [name = ""] = customIdNames(interaction.data.custom_id, ID.delete);
    interaction.deferReply({ flags: 64 });
    try {
      const state = await loadAccountState(discordId);
      const character = state ? findCharacter(state, name) : null;
      if (!character) {
        return interaction.editReply(v2(notice(COLORS.muted, "Character not found", `**${name}** is no longer on your account.`)));
      }
      return interaction.editReply(v2(buildDeleteConfirm(character)));
    } catch (error) {
      console.error("[account] Delete preview failed:", error);
      return interaction.editReply(errorNotice("Your account could not be loaded right now. Please try again later."));
    }
  },
};

export const accountDeleteConfirmButton = {
  customId: `${ID.deleteConfirm}*`,
  handler: (interaction: MessageComponentInteraction) => {
    const [name = ""] = customIdNames(interaction.data.custom_id, ID.deleteConfirm);
    return withAccount(interaction, async (state, discordId) => {
      const character = findCharacter(state, name);
      if (!character) return interaction.editReply(characterGone(name));
      const result = await deleteGameCharacter({
        userId: state.account.userId,
        characterName: character.characterName,
        requestedByDiscordId: discordId,
      });
      if (!result.ok) {
        return interaction.editReply(v2Update(notice(COLORS.danger, "Delete failed", result.message)));
      }
      return interaction.editReply(
        v2Update(
          notice(COLORS.muted, "Character deleted", [
            `**${result.characterName}** was removed from your account.`,
            `-# ${result.remaining} character${result.remaining === 1 ? "" : "s"} left · open \`/account view\` again to see the roster.`,
          ]),
        ),
      );
    });
  },
};

export const accountDismissButton = {
  customId: ID.dismiss,
  handler: (interaction: MessageComponentInteraction) =>
    interaction.update(v2Update(notice(COLORS.muted, "Cancelled", "Nothing was changed."))),
};

export const accountPasswordButton = {
  customId: `${ID.password}*`,
  handler: async (interaction: MessageComponentInteraction) => {
    const initial = interaction.data.custom_id.endsWith("initial");
    return interaction.showModal(
      initial
        ? passwordModal(INITIAL_PASSWORD_MODAL_ID, "Your initial Dungeon Blitz password")
        : passwordModal(RESET_PASSWORD_MODAL_ID, "Reset Dungeon Blitz password"),
    );
  },
};

async function handlePasswordModal(interaction: ModalSubmitInteraction, initialOnly: boolean) {
  const discordId = interactionDiscordId(interaction);
  if (!discordId) return interaction.reply(errorNotice(UNVERIFIED_TEXT));
  const password = interaction.getTextFieldValue(PASSWORD_INPUT_ID) ?? "";
  const confirmation = interaction.getTextFieldValue(PASSWORD_CONFIRM_INPUT_ID) ?? "";
  if (password !== confirmation) {
    return interaction.reply(v2(notice(COLORS.danger, "Passwords do not match", "Type the same password in both boxes.")));
  }

  interaction.deferReply({ flags: 64 });
  try {
    const result = await updateGameAccountPassword(discordId, password, { initialOnly });
    if (result.status === "not-found") {
      return interaction.editReply(
        v2(notice(COLORS.muted, "Verify first", "Complete the Discord verification from `/account create` first.")),
      );
    }
    if (result.status === "already-configured") {
      return interaction.editReply(
        v2(notice(COLORS.muted, "Password already set", "Use **Reset password** on `/account view` to change it.")),
      );
    }
    return interaction.editReply(
      v2(
        notice(
          COLORS.success,
          initialOnly ? "Password set" : "Password reset",
          `You can sign in to the game with **${result.account.email}**.`,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof GameAccountConflictError) {
      return interaction.editReply(v2(notice(COLORS.danger, "Password not changed", error.message)));
    }
    console.error("[account] Password update failed:", error);
    return interaction.editReply(
      errorNotice("Your password could not be updated right now. Please try again later."),
    );
  }
}

export const initialPasswordModal = {
  customId: INITIAL_PASSWORD_MODAL_ID,
  handler: (interaction: ModalSubmitInteraction) => handlePasswordModal(interaction, true),
};

export const resetPasswordModal = {
  customId: RESET_PASSWORD_MODAL_ID,
  handler: (interaction: ModalSubmitInteraction) => handlePasswordModal(interaction, false),
};

/** Components and modals the dispatcher routes to this command. */
export const accountComponents = [
  accountHomeButton,
  accountViewButton,
  accountNotificationsButton,
  accountRenameButton,
  accountRenameConfirmButton,
  accountDeleteButton,
  accountDeleteConfirmButton,
  accountDismissButton,
  accountPasswordButton,
];

export const accountModals = [accountRenameModal, initialPasswordModal, resetPasswordModal];
