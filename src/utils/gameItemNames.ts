/* ------------------------------------------------------------------
 * Game content names
 *
 * A save document stores ids only (`mounts: [81]`, `OwnedDyes: [4]`), so every
 * line a player or an operator reads has to name the id itself. The game owns
 * the content, so the names are fetched from the game server by
 * `ensureGameItemNames()` in `gameContent.ts` and merged in here.
 *
 * The two tables stay the place to pin a name by hand. A hand-written entry wins
 * over whatever the game server reports; ids the game named itself are refreshed
 * on every load, so a rename in the game reaches the bot, and a failed load never
 * clears a name that is already known.
 * ------------------------------------------------------------------ */

/** Mount display names, keyed by the game's mount id. */
export const MOUNT_NAMES: Record<number, string> = {};

/** Legendary dye display names, keyed by the game's dye id. */
export const DYE_NAMES: Record<number, string> = {};

/** Ids the game server itself named; only those may be refreshed by a later load. */
const GAME_NAMED_MOUNT_IDS = new Set<number>();
const GAME_NAMED_DYE_IDS = new Set<number>();

/** Longest name that still fits a select option's description line. */
const NAME_LIMIT = 100;

export function mountLabel(id: number): string {
  return MOUNT_NAMES[id] ?? `Mount #${id}`;
}

export function dyeLabel(id: number): string {
  return DYE_NAMES[id] ?? `Legendary dye #${id}`;
}

export type GameItemNameEntry = { id: number; name: string };

function cleanName(raw: unknown): string {
  // Discord rejects select options with control characters, and a game update
  // should never be able to break the picker.
  return String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, NAME_LIMIT);
}

function applyToTable(
  table: Record<number, string>,
  gameNamedIds: Set<number>,
  entries: readonly GameItemNameEntry[] | undefined,
): number {
  let applied = 0;
  for (const entry of entries ?? []) {
    const id = Number(entry?.id);
    const name = cleanName(entry?.name);
    if (!Number.isSafeInteger(id) || id <= 0 || !name) continue;
    // A name written into this repository by hand outranks the game's own report.
    if (table[id] !== undefined && !gameNamedIds.has(id)) continue;
    table[id] = name;
    gameNamedIds.add(id);
    applied += 1;
  }
  return applied;
}

/**
 * Merges names reported by the game server into the tables. Blank or malformed
 * entries are dropped rather than stored, so a half-broken catalogue degrades to
 * `Mount #<id>` for that id alone.
 */
export function applyItemNames(input: {
  mounts?: readonly GameItemNameEntry[];
  dyes?: readonly GameItemNameEntry[];
}): number {
  return (
    applyToTable(MOUNT_NAMES, GAME_NAMED_MOUNT_IDS, input.mounts) +
    applyToTable(DYE_NAMES, GAME_NAMED_DYE_IDS, input.dyes)
  );
}
