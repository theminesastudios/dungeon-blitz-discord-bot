import {
  CONSUMABLE_ID_BY_KIND,
  EXCLUSIVE_MOUNT_IDS,
  LEGENDARY_DYE_IDS,
  NON_EXCLUSIVE_MOUNT_IDS,
  type ConsumableId,
} from "./sponsorPacks.js";
import {
  findGameUserIdForDiscord,
  requestGameRewards,
  type CurrencyField,
  type GameRewardChange,
  type GearSetTier,
  type MaterialRarity,
  type GameRewardsOutcome,
} from "./gameRewards.js";
import { adjustGameMammothIdols, GameServerAdminError } from "./gameMaintenance.js";
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
  | "consumable"
  | "gear"
  | "materials"
  | "xp";

/**
 * `currency` asks for an amount, `stack` for an item then an amount, `list` and `set` for an
 * item only: a mount or dye is one of a kind, and a gear set is the class's whole set at a tier.
 */
export type GrantShape = "currency" | "list" | "stack" | "set";

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
  /** The amount modal's question, when "How many <unit>?" does not read right. */
  amountPrompt?: string;
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
  { id: "gear", label: "All class gear", emoji: "🗡️", shape: "set", unit: "gear pieces", single: true },
  {
    id: "materials",
    label: "Materials",
    emoji: "🧱",
    shape: "stack",
    unit: "materials",
    amountPrompt: "How many of each material?",
  },
  { id: "xp", label: "Experience", emoji: "✨", shape: "currency", currencyField: "xp", unit: "XP" },
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

const GEAR_TIERS: Array<{ key: `${GearSetTier}`; label: string; tier: GearSetTier }> = [
  { key: "2", label: "Legendary gear", tier: 2 },
  { key: "1", label: "Rare gear", tier: 1 },
  { key: "0", label: "Magic gear", tier: 0 },
];

const MATERIAL_SETS: Array<{ key: MaterialRarity; label: string; description: string }> = [
  { key: "L", label: "Legendary materials", description: "Every Legendary material" },
  { key: "R", label: "Rare materials", description: "Every Rare material" },
  { key: "M", label: "Magic materials", description: "Every Magic material" },
  { key: "all", label: "All materials", description: "Every material, all rarities" },
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
    case "gear":
      return GEAR_TIERS.map((tier) => ({
        key: tier.key,
        label: tier.label,
        description: `Every ${tier.label.replace(" gear", "")} piece the character's class can use`,
      }));
    case "materials":
      return MATERIAL_SETS.map((set) => ({ key: set.key, label: set.label, description: set.description }));
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
    case "gear":
      return GEAR_TIERS.find((tier) => tier.key === itemKey)?.label ?? `Tier ${itemKey} gear`;
    case "materials":
      return MATERIAL_SETS.find((set) => set.key === itemKey)?.label ?? `${itemKey} materials`;
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
      /** Gear sets: how many pieces the class has at the tier. */
      total?: number;
      /** Experience: the level before and after. */
      levelBefore?: number;
      levelAfter?: number;
    }
  | { status: "no-account" }
  | { status: "no-character"; userId: number }
  | { status: "character-not-found"; userId: number }
  /** `available` is null when the game server did not say what the balance is. */
  | { status: "insufficient"; available: number | null; requested: number }
  | { status: "invalid"; reason: string }
  /** The game server refused or could not be reached; nothing was changed. */
  | { status: "unavailable"; reason: string };

/** Game-server currency kinds, by the save field a grant category adjusts. */
const CURRENCY_KINDS: Record<Exclude<CurrencyField, "mammothIdols">, "gold" | "sigils" | "keys" | "ore" | "royalSigils" | "xp"> = {
  gold: "gold",
  SilverSigils: "sigils",
  DragonKeys: "keys",
  DragonOre: "ore",
  RoyalSigils: "royalSigils",
  xp: "xp",
};

type GrantContext = {
  category: GrantCategory;
  operation: GrantOperation;
  amount: number;
  itemKey?: string;
  itemLabel?: string;
};

function okOutcome(
  context: GrantContext,
  userId: number,
  characterName: string,
  beforeValue: number,
  afterValue: number,
): GrantOutcome {
  return {
    status: "ok",
    userId,
    characterName,
    category: context.category,
    operation: context.operation,
    ...(context.itemKey ? { itemKey: context.itemKey } : {}),
    ...(context.itemLabel ? { itemLabel: context.itemLabel } : {}),
    beforeValue,
    afterValue,
    unchanged: beforeValue === afterValue,
  };
}

/** Maps the game server's answer for a single-change grant onto the grant outcome. */
export function grantOutcomeFromGame(
  outcome: GameRewardsOutcome,
  userId: number,
  context: GrantContext,
): GrantOutcome {
  if (!outcome.ok) {
    switch (outcome.refusal) {
      case "no-save":
        return { status: "no-character", userId };
      case "not-found":
        return { status: "character-not-found", userId };
      case "held-elsewhere":
        return {
          status: "unavailable",
          reason: "The player is signed in on another game server. Try again once they log out.",
        };
      case "invalid-request":
        return { status: "invalid", reason: outcome.message };
      default:
        return { status: "unavailable", reason: outcome.message };
    }
  }

  const result = outcome.results[0];
  if (!result) {
    return { status: "unavailable", reason: "The game server did not report the change." };
  }
  if (result.status === "insufficient") {
    return { status: "insufficient", available: result.before, requested: context.amount };
  }
  const ok = okOutcome(context, outcome.userId, outcome.characterName, result.before, result.after);
  if (ok.status !== "ok") return ok;
  return {
    ...ok,
    ...(typeof result.total === "number" ? { total: result.total } : {}),
    ...(typeof result.levelBefore === "number" && typeof result.levelAfter === "number"
      ? { levelBefore: result.levelBefore, levelAfter: result.levelAfter }
      : {}),
  };
}

/**
 * Account-wide Mammoth Idols (game issue #529) have their own route, which moves every
 * character's balance together.
 */
async function applyIdolGrant(
  userId: number,
  characterName: string,
  context: GrantContext,
): Promise<GrantOutcome> {
  try {
    const result = await adjustGameMammothIdols(
      userId,
      characterName,
      context.operation === "add" ? "add" : "sub",
      context.amount,
    );
    return okOutcome(context, userId, result.characterName || characterName, result.before, result.after);
  } catch (error) {
    if (error instanceof GameServerAdminError && error.status === 404 && /not found/i.test(error.message)) {
      return { status: "character-not-found", userId };
    }
    if (error instanceof GameServerAdminError && error.status === 409) {
      return { status: "insufficient", available: null, requested: context.amount };
    }
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Applies one grant to a linked player's character through the game server, which changes the
 * live character when the player is online and the stored save when not. A direct save write
 * would be overwritten by the game's own copy.
 *
 * Currency and stack categories use the amount; mount and dye are one-of-a-kind, so their
 * amount is always 1 and the operation decides whether the id is added or removed.
 */
export async function applyGrant(input: {
  discordId: string;
  characterName: string;
  categoryId: GrantCategoryId;
  itemKey?: string;
  operation: GrantOperation;
  amount: number;
  requestedBy?: string;
}): Promise<GrantOutcome> {
  const category = findGrantCategory(input.categoryId);
  if (!category) return { status: "invalid", reason: "That item type is not supported." };

  let change: GameRewardChange | null = null;
  switch (category.id) {
    case "mount":
    case "dye": {
      const id = Number(input.itemKey);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return { status: "invalid", reason: "Pick a specific item first." };
      }
      change = category.id === "mount" ? { kind: "mount", mountIds: [id] } : { kind: "dye", dyeId: id };
      break;
    }
    case "lockbox": {
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      change = { kind: "lockbox", lockboxId: 1, count: input.amount };
      break;
    }
    case "consumable": {
      const mapped = CONSUMABLE_ID_BY_KIND[input.itemKey as ConsumableId];
      if (!mapped) {
        return { status: "invalid", reason: "Pick a specific potion first." };
      }
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      change = { kind: "consumable", consumableID: mapped, count: input.amount };
      break;
    }
    case "gear": {
      const tier = GEAR_TIERS.find((entry) => entry.key === input.itemKey)?.tier;
      if (tier === undefined) {
        return { status: "invalid", reason: "Pick a gear tier first." };
      }
      change = { kind: "gearSet", tier };
      break;
    }
    case "materials": {
      const rarity = MATERIAL_SETS.find((entry) => entry.key === input.itemKey)?.key;
      if (!rarity) {
        return { status: "invalid", reason: "Pick which materials first." };
      }
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      change = { kind: "materialSet", rarity, count: input.amount };
      break;
    }
    default: {
      if (!category.currencyField) {
        return { status: "invalid", reason: "That item type is not supported." };
      }
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        return { status: "invalid", reason: "Enter a positive whole number." };
      }
      if (category.currencyField !== "mammothIdols") {
        change = { kind: CURRENCY_KINDS[category.currencyField], amount: input.amount };
      }
      break;
    }
  }

  const userId = await findGameUserIdForDiscord(input.discordId);
  if (userId === null) return { status: "no-account" };

  const context: GrantContext = {
    category,
    operation: input.operation,
    amount: category.single ? 1 : input.amount,
    itemKey: input.itemKey,
    itemLabel: grantItemLabel(category.id, input.itemKey),
  };
  if (!change) return applyIdolGrant(userId, input.characterName, context);

  const outcome = await requestGameRewards({
    userId,
    characterName: input.characterName,
    rewards: [{ ...change, operation: input.operation }],
    requestedBy: input.requestedBy ?? "grant",
    // Staff may grant to a character the game has not unlocked yet; the shop may not.
    allowLocked: true,
  });
  return grantOutcomeFromGame(outcome, userId, context);
}

/** A one-line description of a grant, used in the confirmation and the operator log. */
export function formatGrantLine(outcome: Extract<GrantOutcome, { status: "ok" }>): string {
  const sign = outcome.operation === "add" ? "+" : "−";
  const item = outcome.itemLabel ? ` ${outcome.itemLabel}` : ` ${outcome.category.unit}`;
  if (outcome.category.shape === "list") {
    return `${outcome.category.emoji} ${sign}${item.trim()}${outcome.unchanged ? " (already set)" : ""}`;
  }
  const delta = Math.abs(outcome.afterValue - outcome.beforeValue).toLocaleString();
  if (outcome.category.shape === "set") {
    return `${outcome.category.emoji} ${sign}${delta}${item}${outcome.unchanged ? " (nothing to change)" : " pieces"}`;
  }
  const level =
    outcome.levelBefore !== undefined && outcome.levelAfter !== undefined && outcome.levelBefore !== outcome.levelAfter
      ? ` (Lv ${outcome.levelBefore} → ${outcome.levelAfter})`
      : "";
  return `${outcome.category.emoji} ${sign}${delta}${item}${level}`;
}

/** The resulting value in the save, phrased for a human. */
export function formatGrantValue(outcome: Extract<GrantOutcome, { status: "ok" }>): string {
  if (outcome.category.shape === "list") {
    return outcome.afterValue > 0 ? "owned ✅" : "not owned ❌";
  }
  if (outcome.category.shape === "set") {
    const total = outcome.total !== undefined ? ` of ${outcome.total.toLocaleString()}` : "";
    return `${outcome.afterValue.toLocaleString()}${total} pieces at this tier`;
  }
  if (outcome.levelAfter !== undefined) {
    return `${outcome.afterValue.toLocaleString()} XP · Lv ${outcome.levelAfter}`;
  }
  return outcome.afterValue.toLocaleString();
}
