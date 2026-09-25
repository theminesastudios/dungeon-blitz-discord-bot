import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  InteractionFlags,
  LabelBuilder,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "@minesa-org/mini-interaction";
import { ComponentType, MessageFlags } from "discord-api-types/v10";
import type {
  CommandInteraction,
  MessageActionRowComponent,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "@minesa-org/mini-interaction";
import { waitUntil } from "@vercel/functions";
import {
  applyGrant,
  findGrantCategory,
  formatGrantLine,
  formatGrantValue,
  grantItemLabel,
  GRANT_CATEGORIES,
  listGrantItems,
  type GrantCategoryId,
  type GrantOperation,
  type GrantOutcome,
} from "../utils/gameGrant.js";
import {
  listGameSaveCharacters,
  type GameCharacterOption,
} from "../utils/gameRewards.js";
import { ensureGameItemNames, primeGameItemNames } from "../utils/gameContent.js";
import {
  isAdministrator,
  interactionActorLabel,
} from "../utils/discordInteractions.js";
import { publishGameLog, type GameLogField } from "../utils/gameLogChannel.js";

/* ------------------------------------------------------------------
 * `/admin grant` — give or remove one specific thing on a player's save.
 *
 * The flow is a single ephemeral panel that reveals the next step as choices are made:
 * pick the player, pick the character, pick what it is, pick the exact item, then add or
 * remove. Every choice travels in the component custom ids, so there is no server-side
 * session to lose between clicks. Currency and counted items ask for an amount in a
 * modal; mounts and dyes are one-of-a-kind, so their add/remove applies immediately.
 * ------------------------------------------------------------------ */

const ACCENT = 0x9b59b6;

const GRANT_USER_ID = "grant:user";
const GRANT_CHARACTER_PREFIX = "grant:char:";
const GRANT_CATEGORY_PREFIX = "grant:cat:";
const GRANT_ITEM_PREFIX = "grant:item:";
const GRANT_OP_PREFIX = "grant:op:";
const GRANT_START_ID = "grant:start";
export const GRANT_AMOUNT_MODAL_ID = "grant:amount";
const AMOUNT_INPUT_PREFIX = "grant:amt|";

// Components V2 messages require the flag; the grant panel is always ephemeral.
const CONTAINER_FLAGS = MessageFlags.IsComponentsV2;
const CONTAINER_EPHEMERAL_FLAGS = (MessageFlags.IsComponentsV2 |
  InteractionFlags.Ephemeral) as MessageFlags;

/** Choices made so far. A `charIndex` of -1 means the character is not chosen yet. */
type GrantState = {
  targetId: string;
  charIndex: number;
  categoryId?: GrantCategoryId;
  itemKey?: string;
};

type OpState = GrantState & { categoryId: GrantCategoryId };

function categoryCustomId(state: GrantState): string {
  return `${GRANT_CATEGORY_PREFIX}${state.targetId}:${state.charIndex}`;
}

function itemCustomId(state: OpState): string {
  return `${GRANT_ITEM_PREFIX}${state.targetId}:${state.charIndex}:${state.categoryId}`;
}

function opCustomId(state: OpState, operation: GrantOperation): string {
  return `${GRANT_OP_PREFIX}${operation}:${state.targetId}:${state.charIndex}:${state.categoryId}:${state.itemKey ?? "-"}`;
}

function amountInputCustomId(state: OpState, operation: GrantOperation): string {
  return `${AMOUNT_INPUT_PREFIX}${operation}|${state.targetId}|${state.charIndex}|${state.categoryId}|${state.itemKey ?? "-"}`;
}

/* ------------------------------------------------------------------
 * Custom-id parsers
 * ------------------------------------------------------------------ */

function numericId(value: string): string | null {
  return /^\d+$/.test(value) ? value : null;
}

function parseCategoryState(customId: string): GrantState | null {
  const parts = customId.slice(GRANT_CATEGORY_PREFIX.length).split(":");
  const targetId = numericId(parts[0] ?? "");
  const charIndex = Number(parts[1]);
  if (!targetId || !Number.isInteger(charIndex)) return null;
  return { targetId, charIndex };
}

function parseItemState(customId: string): OpState | null {
  const parts = customId.slice(GRANT_ITEM_PREFIX.length).split(":");
  const targetId = numericId(parts[0] ?? "");
  const charIndex = Number(parts[1]);
  const category = findGrantCategory(parts[2] ?? "");
  if (!targetId || !Number.isInteger(charIndex) || !category) return null;
  return { targetId, charIndex, categoryId: category.id };
}

function parseOpState(
  customId: string,
): (OpState & { operation: GrantOperation }) | null {
  const parts = customId.slice(GRANT_OP_PREFIX.length).split(":");
  const operation = parts[0];
  const targetId = numericId(parts[1] ?? "");
  const charIndex = Number(parts[2]);
  const category = findGrantCategory(parts[3] ?? "");
  const rawItem = parts[4];
  if (
    (operation !== "add" && operation !== "remove") ||
    !targetId ||
    !Number.isInteger(charIndex) ||
    !category
  ) {
    return null;
  }
  return {
    operation,
    targetId,
    charIndex,
    categoryId: category.id,
    ...(rawItem && rawItem !== "-" ? { itemKey: rawItem } : {}),
  };
}

/* ------------------------------------------------------------------
 * Panel rendering
 * ------------------------------------------------------------------ */

function text(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

function separator(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small);
}

function userSelectRow(): ActionRowBuilder<MessageActionRowComponent> {
  // The library has no action-row builder for a user select, so the raw component is
  // supplied directly — ActionRowBuilder accepts API component objects as well as builders.
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents({
    type: ComponentType.UserSelect,
    custom_id: GRANT_USER_ID,
    placeholder: "Search and pick the player…",
    min_values: 1,
    max_values: 1,
  } as MessageActionRowComponent);
}

function startOverRow(): ActionRowBuilder<MessageActionRowComponent> {
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents(
    new ButtonBuilder()
      .setCustomId(GRANT_START_ID)
      .setLabel("Give or remove another")
      .setStyle(ButtonStyle.Secondary),
  );
}

function categorySelectRow(
  state: GrantState,
): ActionRowBuilder<MessageActionRowComponent> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(categoryCustomId(state))
    .setPlaceholder("What should it be?")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(
      GRANT_CATEGORIES.map((category) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(category.label)
          .setValue(category.id)
          .setEmoji(category.emoji)
          .setDefault(category.id === state.categoryId),
      ),
    );
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function characterSelectRow(
  state: GrantState,
  characters: GameCharacterOption[],
): ActionRowBuilder<MessageActionRowComponent> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${GRANT_CHARACTER_PREFIX}${state.targetId}`)
    .setPlaceholder("Which character?")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(
      characters.map((character, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(character.name.slice(0, 100))
          .setValue(String(index))
          .setDescription(
            [`Level ${character.level}`, character.class, character.locked ? "locked" : ""]
              .filter(Boolean)
              .join(" · ")
              .slice(0, 100),
          ),
      ),
    );
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function itemSelectRow(state: OpState): ActionRowBuilder<MessageActionRowComponent> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(itemCustomId(state))
    .setPlaceholder("Which one?")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(
      listGrantItems(state.categoryId)
        .slice(0, 25)
        .map((option) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(option.label.slice(0, 100))
            .setValue(option.key)
            .setDescription(option.description.slice(0, 100))
            .setDefault(option.key === state.itemKey),
        ),
    );
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function operationRow(state: OpState): ActionRowBuilder<MessageActionRowComponent> {
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents(
    new ButtonBuilder()
      .setCustomId(opCustomId(state, "add"))
      .setLabel("Add")
      .setEmoji({ name: "➕" })
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(opCustomId(state, "remove"))
      .setLabel("Remove")
      .setEmoji({ name: "➖" })
      .setStyle(ButtonStyle.Danger),
  );
}

function targetLine(state: GrantState, characters: GameCharacterOption[]): string {
  const character = state.charIndex >= 0 ? characters[state.charIndex] : undefined;
  return [
    `**Player** <@${state.targetId}>`,
    `**Character** ${
      character ? `${character.name} · Lv ${character.level}` : "not chosen yet"
    }`,
  ].join("\n");
}

/** Renders the panel for the choices made so far, revealing the next step. */
async function renderPanel(
  state: GrantState,
  notice?: string,
): Promise<ContainerBuilder> {
  // Names come from the game server. The panel is built before the interaction is
  // acknowledged, so this only *starts* the load — by the time the operator reaches the
  // item list it has landed, and a picker that cannot name its items still lists every id.
  primeGameItemNames();

  const container = new ContainerBuilder().setAccentColor(ACCENT);
  container.addComponent(text("## 🎁 Grant an item"));
  container.addComponent(
    text("-# Give or remove one specific thing on a player's game save."),
  );
  container.addComponent(separator());

  if (!state.targetId) {
    container.addComponent(text("**Step 1 · Pick the player**"));
    container.addComponent(userSelectRow());
    if (notice) container.addComponent(text(`-# ${notice}`));
    container.addComponent(separator());
    container.addComponent(startOverRow());
    return container;
  }

  const characters = await listGameSaveCharacters(state.targetId).catch(() => []);
  if (characters.length === 0) {
    container.addComponent(
      text(
        `**Player** <@${state.targetId}>\n-# No game character was found. They need a linked account with a save — run \`/account create\` and play once in-game.`,
      ),
    );
    container.addComponent(separator());
    container.addComponent(startOverRow());
    return container;
  }

  // A single character is unambiguous; only ask when there is a choice to make.
  if (state.charIndex < 0 && characters.length === 1) state.charIndex = 0;

  container.addComponent(
    text(["**Step 1 · The player**", targetLine(state, characters)].join("\n")),
  );

  if (state.charIndex < 0) {
    container.addComponent(separator());
    container.addComponent(text("**Step 2 · Pick the character**"));
    container.addComponent(characterSelectRow(state, characters));
    container.addComponent(separator());
    container.addComponent(startOverRow());
    return container;
  }

  container.addComponent(separator());
  container.addComponent(text("**Step 2 · What should it be?**"));
  container.addComponent(categorySelectRow(state));

  const category = state.categoryId ? findGrantCategory(state.categoryId) : null;
  if (!category) {
    container.addComponent(separator());
    container.addComponent(startOverRow());
    return container;
  }

  const items = listGrantItems(category.id);
  if (category.shape !== "currency" && !state.itemKey && items.length === 1) {
    state.itemKey = items[0].key;
  }

  if (category.shape !== "currency" && !state.itemKey) {
    container.addComponent(separator());
    container.addComponent(text("**Step 3 · Pick the exact item**"));
    container.addComponent(itemSelectRow(state as OpState));
    container.addComponent(separator());
    container.addComponent(startOverRow());
    return container;
  }

  const chosen = state.itemKey
    ? ` **${grantItemLabel(category.id, state.itemKey)}**`
    : "";
  container.addComponent(separator());
  container.addComponent(
    text(
      [
        "**Step 3 · Add or remove**",
        `-# ${category.emoji} ${category.label}${chosen}`,
        notice ? `-# ${notice}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  container.addComponent(operationRow(state as OpState));
  container.addComponent(separator());
  container.addComponent(startOverRow());
  return container;
}

function resultContainer(
  outcome: Extract<GrantOutcome, { status: "ok" }>,
  discordId: string,
  actor: string,
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(
    outcome.operation === "add" ? 0x2ecc71 : 0xe74c3c,
  );
  container.addComponent(
    text(
      `## ${outcome.operation === "add" ? "✅ Grant applied" : "➖ Removal applied"}`,
    ),
  );
  container.addComponent(separator());
  container.addComponent(
    text(
      [
        `**Player** <@${discordId}>\n**Character** ${outcome.characterName}`,
        formatGrantLine(outcome),
        `-# ${outcome.category.label} now reads **${formatGrantValue(outcome)}**`,
      ].join("\n"),
    ),
  );
  container.addComponent(separator());
  container.addComponent(text(`-# by ${actor}`));
  container.addComponent(startOverRow());
  return container;
}

function errorContainer(message: string): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(0xe74c3c);
  container.addComponent(text("## ⚠️ Grant failed"));
  container.addComponent(separator());
  container.addComponent(text(message));
  container.addComponent(separator());
  container.addComponent(startOverRow());
  return container;
}

function outcomeToPanel(
  outcome: GrantOutcome,
  discordId: string,
  actor: string,
): { container: ContainerBuilder; failed: boolean } {
  switch (outcome.status) {
    case "ok":
      return { container: resultContainer(outcome, discordId, actor), failed: false };
    case "no-account":
      return {
        container: errorContainer(
          "That player has no linked Dungeon Blitz account, so there is no save to change.",
        ),
        failed: true,
      };
    case "no-character":
      return {
        container: errorContainer(
          `Game user ${outcome.userId} has no save yet. Have them play once in-game, then try again.`,
        ),
        failed: true,
      };
    case "character-not-found":
      return {
        container: errorContainer(
          "That character is no longer on the save. Pick another character and try again.",
        ),
        failed: true,
      };
    case "insufficient":
      return {
        container: errorContainer(
          `Not enough to remove: the save holds **${outcome.available.toLocaleString()}** and the request was **${outcome.requested.toLocaleString()}**.`,
        ),
        failed: true,
      };
    case "invalid":
      return { container: errorContainer(outcome.reason), failed: true };
  }
}

function reportGrant(fields: GameLogField[], failed: boolean) {
  const promise = publishGameLog({
    event: failed ? "admin-grant-failed" : "admin-grant",
    title: failed ? "⚠️ Manual grant failed" : "🎁 Manual grant applied",
    fields,
  });
  try {
    waitUntil(promise);
  } catch {
    void promise.catch(() => {});
  }
}

/** Applies a grant and returns the panel to show plus a log-ready summary. */
async function executeGrant(
  input: {
    targetId: string;
    charIndex: number;
    categoryId: GrantCategoryId;
    itemKey?: string;
    operation: GrantOperation;
    amount: number;
  },
  actor: string,
): Promise<{ container: ContainerBuilder; failed: boolean; logFields: GameLogField[] }> {
  const category = findGrantCategory(input.categoryId);
  // The confirmations name the granted item, so make sure the catalogue is loaded.
  await ensureGameItemNames();
  const characters = await listGameSaveCharacters(input.targetId).catch(() => []);
  const character = characters[input.charIndex];
  const baseFields: GameLogField[] = [
    { name: "Player", value: `<@${input.targetId}>`, inline: true },
    {
      name: "Item",
      value: category ? `${category.emoji} ${category.label}` : input.categoryId,
      inline: true,
    },
    ...(input.itemKey
      ? [{ name: "Specific", value: grantItemLabel(input.categoryId, input.itemKey), inline: true }]
      : []),
  ];

  if (!character) {
    return {
      container: errorContainer(
        "That player has no game character to change. They need a linked account with a save.",
      ),
      failed: true,
      logFields: [...baseFields, { name: "Result", value: "no character" }],
    };
  }

  const outcome = await applyGrant({
    discordId: input.targetId,
    characterName: character.name,
    categoryId: input.categoryId,
    itemKey: input.itemKey,
    operation: input.operation,
    amount: input.amount,
  });
  const { container, failed } = outcomeToPanel(outcome, input.targetId, actor);
  const summary =
    outcome.status === "ok"
      ? `${formatGrantLine(outcome)} on ${outcome.characterName} (now ${formatGrantValue(outcome)})`
      : `failed (${outcome.status})`;
  return {
    container,
    failed,
    logFields: [
      ...baseFields,
      { name: "Character", value: character.name, inline: true },
      { name: "Result", value: summary },
      { name: "By", value: actor },
    ],
  };
}

/* ------------------------------------------------------------------
 * Handlers
 * ------------------------------------------------------------------ */

function deny(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  return interaction.reply({
    content: "Administrator permission is required.",
    flags: InteractionFlags.Ephemeral,
  });
}

export async function handleGrant(interaction: CommandInteraction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({
      content: "Administrator permission is required.",
      flags: InteractionFlags.Ephemeral,
    });
  }
  const container = await renderPanel({ targetId: "", charIndex: -1 });
  return interaction.reply({
    components: [container],
    flags: CONTAINER_EPHEMERAL_FLAGS,
  });
}

async function handleUserSelection(interaction: MessageComponentInteraction) {
  if (!isAdministrator(interaction)) return deny(interaction);
  const targetId = String(interaction.getUsers()[0]?.user?.id ?? "").trim();
  const container = await renderPanel(
    { targetId: /^\d+$/.test(targetId) ? targetId : "", charIndex: -1 },
    targetId ? undefined : "Pick a player from the menu.",
  );
  return interaction.update({ components: [container], flags: CONTAINER_FLAGS });
}

async function handleCharacterSelection(
  interaction: MessageComponentInteraction,
  targetId: string,
) {
  if (!isAdministrator(interaction)) return deny(interaction);
  const index = Number(interaction.getStringValues()[0] ?? "0");
  const container = await renderPanel({
    targetId,
    charIndex: Number.isInteger(index) && index >= 0 ? index : 0,
  });
  return interaction.update({ components: [container], flags: CONTAINER_FLAGS });
}

async function handleCategorySelection(
  interaction: MessageComponentInteraction,
  state: GrantState,
) {
  if (!isAdministrator(interaction)) return deny(interaction);
  const selected = interaction.getStringValues()[0];
  const category = selected ? findGrantCategory(selected) : null;
  const container = await renderPanel({
    ...state,
    categoryId: category?.id,
    itemKey: undefined,
  });
  return interaction.update({ components: [container], flags: CONTAINER_FLAGS });
}

async function handleItemSelection(
  interaction: MessageComponentInteraction,
  state: OpState,
) {
  if (!isAdministrator(interaction)) return deny(interaction);
  const itemKey = interaction.getStringValues()[0];
  const container = await renderPanel({ ...state, itemKey });
  return interaction.update({ components: [container], flags: CONTAINER_FLAGS });
}

async function handleOperation(
  interaction: MessageComponentInteraction,
  state: OpState,
  operation: GrantOperation,
) {
  if (!isAdministrator(interaction)) return deny(interaction);
  const category = findGrantCategory(state.categoryId);
  if (!category) {
    return interaction.update({
      components: [errorContainer("Pick an item type first.")],
      flags: CONTAINER_FLAGS,
    });
  }

  // One-of-a-kind items need no amount: the click is the whole instruction.
  if (category.shape === "list") {
    const result = await executeGrant(
      { ...state, operation, amount: 1 },
      interactionActorLabel(interaction),
    );
    reportGrant(result.logFields, result.failed);
    return interaction.update({
      components: [result.container],
      flags: CONTAINER_FLAGS,
    });
  }

  return interaction.showModal(amountModal(state, operation));
}

async function handleAmountSubmit(interaction: ModalSubmitInteraction) {
  if (!isAdministrator(interaction)) return deny(interaction);

  const parsed = readAmountInput(interaction);
  if (!parsed) {
    return interaction.reply({
      components: [
        errorContainer("The amount could not be read. Start the flow again."),
      ],
      flags: CONTAINER_EPHEMERAL_FLAGS,
    });
  }

  const amount = Number(parsed.value.replace(/[^\d]/g, ""));
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return interaction.reply({
      components: [errorContainer("Enter a positive whole number.")],
      flags: CONTAINER_EPHEMERAL_FLAGS,
    });
  }

  const result = await executeGrant(
    { ...parsed.state, operation: parsed.operation, amount },
    interactionActorLabel(interaction),
  );
  reportGrant(result.logFields, result.failed);
  return interaction.reply({
    components: [result.container],
    flags: CONTAINER_EPHEMERAL_FLAGS,
  });
}

async function handleStartOver(interaction: MessageComponentInteraction) {
  if (!isAdministrator(interaction)) return deny(interaction);
  const container = await renderPanel({ targetId: "", charIndex: -1 });
  return interaction.update({ components: [container], flags: CONTAINER_FLAGS });
}

/* ------------------------------------------------------------------
 * Amount modal
 * ------------------------------------------------------------------ */

function amountModal(state: OpState, operation: GrantOperation) {
  const category = findGrantCategory(state.categoryId)!;
  const question =
    category.shape === "stack"
      ? `How many ${category.unit}?`
      : `How much ${category.unit}?`;
  return new ModalBuilder()
    .setCustomId(GRANT_AMOUNT_MODAL_ID)
    .setTitle(
      `${operation === "add" ? "Add" : "Remove"} ${category.label}`.slice(0, 45),
    )
    .addComponents(
      new LabelBuilder()
        .setLabel(question.slice(0, 45))
        .setDescription("A positive whole number.".slice(0, 100))
        .setComponent(
          new TextInputBuilder()
            .setCustomId(amountInputCustomId(state, operation))
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(12)
            .setRequired(true),
        ),
    );
}

/**
 * Reads the amount out of a modal submit, including the flow state carried on the input's
 * custom id. Modals cannot route on a dynamic id, so the id itself is the session.
 */
function readAmountInput(
  interaction: ModalSubmitInteraction,
): { state: OpState; operation: GrantOperation; value: string } | null {
  const matches: Array<{ customId: string; value: string }> = [];

  const visit = (component: unknown): void => {
    if (!component || typeof component !== "object") return;
    const record = component as {
      custom_id?: unknown;
      value?: unknown;
      components?: unknown;
      component?: unknown;
    };
    const customId = typeof record.custom_id === "string" ? record.custom_id : "";
    if (customId.startsWith(AMOUNT_INPUT_PREFIX) && typeof record.value === "string") {
      matches.push({ customId, value: record.value });
      return;
    }
    if (Array.isArray(record.components)) {
      for (const child of record.components) visit(child);
    }
    if (record.component) visit(record.component);
  };

  for (const top of (interaction.data?.components ?? []) as unknown[]) visit(top);
  const input = matches[0];
  if (!input) return null;

  const parts = input.customId.slice(AMOUNT_INPUT_PREFIX.length).split("|");
  const operation = parts[0];
  const targetId = numericId(parts[1] ?? "");
  const charIndex = Number(parts[2]);
  const category = findGrantCategory(parts[3] ?? "");
  const rawItem = parts[4];
  if (
    (operation !== "add" && operation !== "remove") ||
    !targetId ||
    !Number.isInteger(charIndex) ||
    !category
  ) {
    return null;
  }

  return {
    operation,
    value: input.value,
    state: {
      targetId,
      charIndex,
      categoryId: category.id,
      ...(rawItem && rawItem !== "-" ? { itemKey: rawItem } : {}),
    },
  };
}

/* ------------------------------------------------------------------
 * Registration
 * ------------------------------------------------------------------ */

export const grantUserSelect = {
  customId: GRANT_USER_ID,
  handler: (interaction: MessageComponentInteraction) => handleUserSelection(interaction),
};

export const grantCharacterSelect = {
  customId: `${GRANT_CHARACTER_PREFIX}*`,
  handler: (interaction: MessageComponentInteraction) =>
    handleCharacterSelection(
      interaction,
      interaction.data.custom_id.slice(GRANT_CHARACTER_PREFIX.length),
    ),
};

export const grantCategorySelect = {
  customId: `${GRANT_CATEGORY_PREFIX}*`,
  handler: (interaction: MessageComponentInteraction) => {
    const state = parseCategoryState(interaction.data.custom_id);
    if (!state) return deny(interaction);
    return handleCategorySelection(interaction, state);
  },
};

export const grantItemSelect = {
  customId: `${GRANT_ITEM_PREFIX}*`,
  handler: (interaction: MessageComponentInteraction) => {
    const state = parseItemState(interaction.data.custom_id);
    if (!state) return deny(interaction);
    return handleItemSelection(interaction, state);
  },
};

export const grantOperationButtons = {
  customId: `${GRANT_OP_PREFIX}*`,
  handler: (interaction: MessageComponentInteraction) => {
    const parsed = parseOpState(interaction.data.custom_id);
    if (!parsed) return deny(interaction);
    const { operation, ...state } = parsed;
    return handleOperation(interaction, state, operation);
  },
};

export const grantStartButton = {
  customId: GRANT_START_ID,
  handler: (interaction: MessageComponentInteraction) => handleStartOver(interaction),
};

export const grantAmountModal = {
  customId: GRANT_AMOUNT_MODAL_ID,
  handler: (interaction: ModalSubmitInteraction) => handleAmountSubmit(interaction),
};
