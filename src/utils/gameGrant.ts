import type { Document } from "mongodb";
import {
  CONSUMABLE_ID_BY_KIND,
  EXCLUSIVE_MOUNT_IDS,
  LEGENDARY_DYE_IDS,
  NON_EXCLUSIVE_MOUNT_IDS,
  type ConsumableId,
} from "./sponsorPacks.js";
import {
  mutateGameCharacter,
  type CharacterMutation,
  type CharacterMutationOutcome,
  type CurrencyField,
} from "./gameRewards.js";
import { DYE_NAMES, MOUNT_NAMES, dyeLabel, mountLabel } from "./gameItemNames.js";

/* ------------------------------------------------------------------
 * Grant catalogue
 *
 * Everything the staff grant tool can hand out, in one place. The game owns the
 * content data, so ids are the truthful key and the names themselves come from
 * the game server (`src/utils/gameContent.ts`) into the registry both this module
 * and the shop read — `src/utils/gameItemNames.ts`. A mount with no name yet
 * renders as `Mount #<id>` instead of showing a blank.
 * ------------------------------------------------------------------ */

// Re-exported because this module is the documented place to look up the grant
// catalogue; the names themselves live in the shared registry.
export { DYE_NAMES, MOUNT_NAMES, dyeLabel, mountLabel };

export const ALL_MOUNT_IDS: readonly number[] = [
  ...NON_EXCLUSIVE_MOUNT_IDS,
  ...EXCLUSIVE_MOUNT_IDS,
];

function isExclusiveMount(id: number): boolean {
  return (EXCLUSIVE_MOUNT_IDS as readonly number[]).includes(id);
}

export type GrantCategoryId =
  | "gold"
  | "mammothIdols"
  | "dragonKeys"
  | "dragonOre"
  | "silverSigils"
  | "royalSigils"
  | "mount"
  | "dye"
  | "lockbox"
  | "consumable";

export type GrantShape = "currency" | "list" | "stack";

export type GrantCategory = {
  id: GrantCategoryId;
  label: string;
  emoji: string;
  /** How the value lives in the save, which decides what the flow asks for next. */
  shape: GrantShape;
  /** Currency categories only. */
  currencyField?: CurrencyField;
  /** Short unit used in messages, e.g. "gold" or "Trove Chests". */
  unit: string;
  /** True for one-of-a-kind items that are added or removed rather than counted. */
  single?: boolean;
};

export const GRANT_CATEGORIES: GrantCategory[] = [
  { id: "gold", label: "Gold", emoji: "💰", shape: "currency", currencyField: "gold", unit: "gold" },
  {
    id: "mammothIdols",
    label: "Mammoth Idols",
    emoji: "🔮",
    shape: "currency",
    currencyField: "mammothIdols",
    unit: "Mammoth Idols",
  },
  {
    id: "dragonKeys",
    label: "Dragon Keys",
    emoji: "🗝️",
    shape: "currency",
    currencyField: "DragonKeys",
    unit: "Dragon Keys",
  },
  {
    id: "dragonOre",
    label: "Dragon Ore",
    emoji: "⛏️",
    shape: "currency",
    currencyField: "DragonOre",
    unit: "Dragon Ore",
  },
  {
    id: "silverSigils",
    label: "Silver Sigils",
    emoji: "🪙",
    shape: "currency",
    currencyField: "SilverSigils",
    unit: "Silver Sigils",
  },
  {
    id: "royalSigils",
    label: "Royal Sigils",
    emoji: "👑",
    shape: "currency",
    currencyField: "RoyalSigils",
    unit: "Royal Sigils",
  },
  { id: "mount", label: "Mount", emoji: "🐴", shape: "list", unit: "mount", single: true },
  { id: "dye", label: "Legendary Dye", emoji: "🎨", shape: "list", unit: "dye", single: true },
  { id: "lockbox", label: "Trove Chest", emoji: "📦", shape: "stack", unit: "Trove Chests" },
  { id: "consumable", label: "Potion", emoji: "🧪", shape: "stack", unit: "potions" },
];

export function findGrantCategory(id: string): GrantCategory | null {
  return GRANT_CATEGORIES.find((category) => category.id === id) ?? null;
}

export type GrantItemOption = { key: string; label: string; description: string };

const CONSUMABLE_ITEMS: Array<{ key: ConsumableId; label: string }> = [
  { key: "exp", label: "EXP potion" },
  { key: "gear", label: "Gear potion" },
  { key: "gold", label: "Gold potion" },
  { key: "material", label: "Material potion" },
];

/**
 * The concrete items a category offers. Currency categories return an empty list: the flow
 * skips straight to the amount, because there is nothing to pick.
 */
export function listGrantItems(categoryId: GrantCategoryId): GrantItemOption[] {
  switch (categoryId) {
    case "mount":
      return ALL_MOUNT_IDS.map((id) => ({
        key: String(id),
        label: mountLabel(id),
        description: isExclusiveMount(id) ? "Exclusive mount" : "Mount",
      }));
    case "dye":
      return LEGENDARY_DYE_IDS.map((id) => ({
        key: String(id),
        label: dyeLabel(id),
        description: "Legendary dye",
      }));
    case "lockbox":
      return [{ key: "1", label: "Trove Chest", description: "Trove chest stack" }];
    case "consumable":
      return CONSUMABLE_ITEMS.map((item) => ({
        key: item.key,
        label: item.label,
        description: "Consumable potion",
      }));
    default:
      return [];
  }
}

/** Resolves a category's item key into the label shown to the operator. */
export function grantItemLabel(
  categoryId: GrantCategoryId,
  itemKey: string | undefined,
): string {
  if (!itemKey) return "";
  switch (categoryId) {
    case "mount":
      return mountLabel(Number(itemKey));
    case "dye":
      return dyeLabel(Number(itemKey));
    case "consumable":
      return (
        CONSUMABLE_ITEMS.find((item) => item.key === itemKey)?.label ??
        `${itemKey} potion`
      );
    case "lockbox":
      return "Trove Chest";
    default:
      return itemKey;
  }
}

export type GrantOperation = "add" | "remove";

export type GrantOutcome =
  | {
      status: "ok";
      userId: number;
      characterName: string;
      category: GrantCategory;
      operation: GrantOperation;
      itemKey?: string;
      itemLabel?: string;
      /** The value the affected field held before and reads after, for the confirmation. */
      beforeValue: number;
      afterValue: number;
      /** True when a list item was already present on an add (or absent on a remove). */
      unchanged: boolean;
    }
  | { status: "no-account" }
  | { status: "no-character"; userId: number }
  | { status: "character-not-found"; userId: number }
  | { status: "insufficient"; available: number; requested: number }
  | { status: "invalid"; reason: string };

function arrayField(categoryId: GrantCategoryId): "mounts" | "OwnedDyes" {
  return categoryId === "dye" ? "OwnedDyes" : "mounts";
}

function listValue(character: Document, field: "mounts" | "OwnedDyes", id: number): number {
  const raw = (character as Record<string, unknown>)[field];
  const ids = Array.isArray(raw)
    ? raw.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
    : [];
  return ids.includes(id) ? 1 : 0;
}

function numberFieldValue(character: Document, field: string): number {
  const value = Number((character as Record<string, unknown>)[field] ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function stackValue(
  character: Document,
  field: "lockboxes" | "consumables",
  idField: string,
  entryId: number,
): number {
  const entries = (character as Record<string, unknown>)[field];
  if (!Array.isArray(entries)) return 0;
  const entry = entries.find(
    (candidate) =>
      Number((candidate as Record<string, unknown> | null)?.[idField] ?? NaN) === entryId,
  );
  const count = Number((entry as Record<string, unknown> | undefined)?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function outcomeToGrant(
  outcome: CharacterMutationOutcome,
  context: {
    category: GrantCategory;
    operation: GrantOperation;
    itemKey?: string;
    itemLabel?: string;
    entryId?: number;
  },
): GrantOutcome {
  if (outcome.status !== "ok") return outcome;

  const { category, itemKey, operation, itemLabel } = context;
  const readValue = (character: Document): number => {
    if (category.shape === "currency" && category.currencyField) {
      return numberFieldValue(character, category.currencyField);
    }
    if (category.shape === "list") {
      return listValue(character, arrayField(category.id), Number(itemKey));
    }
    return stackValue(
      character,
      category.id === "consumable" ? "consumables" : "lockboxes",
      category.id === "consumable" ? "consumableID" : "lockboxID",
      context.entryId ?? 1,
    );
  };

  const beforeValue = readValue(outcome.before);
  const afterValue = readValue(outcome.after);
  return {
    status: "ok",
    userId: outcome.userId,
    characterName: outcome.characterName,
    category,
    operation,
    ...(itemKey ? { itemKey } : {}),
    ...(itemLabel ? { itemLabel } : {}),
    beforeValue,
    afterValue,
    unchanged: beforeValue === afterValue,
  };
}

/**
 * Applies one grant against a linked player's character save.
 *
 * Currency and stack categories use the amount; mount and dye are one-of-a-kind, so their
 * amount is always 1 and the operation decides whether the id is added or pulled. All the
 * write safety (save addressed by `_id`, character matched by name, value read back) lives
 * in `mutateGameCharacter`.
 */
export async function applyGrant(input: {
  discordId: string;
  characterName: string;
  categoryId: GrantCategoryId;
  itemKey?: string;
  operation: GrantOperation;
  amount: number;
}): Promise<GrantOutcome> {
  const category = findGrantCategory(input.categoryId);
  if (!category) return { status: "invalid", reason: "That item type is not supported." };

  const signed = input.operation === "add" ? input.amount : -input.amount;
  let mutation: CharacterMutation;
  let entryId: number | undefined;

  switch (category.id) {
    case "mount":
    case "dye": {
      const id = Number(input.itemKey);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return { status: "invalid", reason: "Pick a specific item first." };
      }
      const field = arrayField(category.id);
      mutation =
        input.operation === "add"
          ? { kind: "list", field, add: [id] }
          : { kind: "list", field, remove: [id] };
      break;
    }
    case "lockbox": {
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      entryId = 1;
      mutation = {
        kind: "stack",
        field: "lockboxes",
        idField: "lockboxID",
        entryId,
        delta: signed,
      };
      break;
    }
    case "consumable": {
      const consumable = input.itemKey as ConsumableId;
      const mapped = CONSUMABLE_ID_BY_KIND[consumable];
      if (!mapped) {
        return { status: "invalid", reason: "Pick a specific potion first." };
      }
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      entryId = mapped;
      mutation = {
        kind: "stack",
        field: "consumables",
        idField: "consumableID",
        entryId,
        delta: signed,
      };
      break;
    }
    default: {
      if (!category.currencyField) {
        return { status: "invalid", reason: "That item type is not supported." };
      }
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      mutation = { kind: "currency", field: category.currencyField, delta: signed };
      break;
    }
  }

  const outcome = await mutateGameCharacter(
    input.discordId,
    input.characterName,
    mutation,
  );
  return outcomeToGrant(outcome, {
    category,
    operation: input.operation,
    itemKey: input.itemKey,
    itemLabel: grantItemLabel(category.id, input.itemKey),
    entryId,
  });
}

/** A one-line description of a grant, used in the confirmation and the operator log. */
export function formatGrantLine(outcome: Extract<GrantOutcome, { status: "ok" }>): string {
  const sign = outcome.operation === "add" ? "+" : "−";
  const item = outcome.itemLabel ? ` ${outcome.itemLabel}` : ` ${outcome.category.unit}`;
  if (outcome.category.shape === "list") {
    return `${outcome.category.emoji} ${sign}${item.trim()}${outcome.unchanged ? " (already set)" : ""}`;
  }
  return `${outcome.category.emoji} ${sign}${Math.abs(outcome.afterValue - outcome.beforeValue).toLocaleString()}${item}`;
}

/** The resulting value in the save, phrased for a human. */
export function formatGrantValue(outcome: Extract<GrantOutcome, { status: "ok" }>): string {
  if (outcome.category.shape === "list") {
    return outcome.afterValue > 0 ? "owned ✅" : "not owned ❌";
  }
  return outcome.afterValue.toLocaleString();
}
