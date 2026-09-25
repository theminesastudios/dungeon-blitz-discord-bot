import { waitUntil } from "@vercel/functions";
import { applyItemNames, type GameItemNameEntry } from "./gameItemNames.js";
import { fetchGameServerAdmin } from "./gameMaintenance.js";

/* ------------------------------------------------------------------
 * The game's item catalogue
 *
 * Mount and dye ids are content ids: the save stores numbers, and only the game
 * knows what `81` is called. Rather than freezing a copy of that list in this
 * repository, the bot reads it from the game server and merges it into
 * `gameItemNames.ts`, so a new mount is named the moment the game ships it.
 *
 * The read is fail-open on purpose. Every caller is rendering a picker or a log
 * line, and `Mount #81` is a perfectly usable fallback — a game server that is
 * down or has not added the route yet must never block a purchase or a grant.
 * ------------------------------------------------------------------ */

const CONTENT_PATH = "/api/admin/content";

/** How long a loaded catalogue is trusted before it is read again. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

/**
 * Kept well inside Discord's 3-second acknowledgement window: a grant confirmation
 * waits for this, and a game server that is down must not turn a click into "interaction
 * failed".
 */
const CATALOGUE_TIMEOUT_MS = 1_500;

/** `{ mounts: [{ id, name }], dyes: [{ id, name }] }` or `{ "81": "name" }`. */
export type GameItemCatalogue = {
  ok?: boolean;
  mounts?: unknown;
  dyes?: unknown;
  items?: { mounts?: unknown; dyes?: unknown };
};

let loadedAt = 0;
let inFlight: Promise<void> | null = null;

function parseEntry(id: unknown, name: unknown): GameItemNameEntry | null {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  const label = String(name ?? "").trim();
  if (!label) return null;
  return { id: numericId, name: label };
}

/** Reads either an array of `{ id, name }` entries or an `{ id: name }` map. */
export function parseItemNameList(raw: unknown): GameItemNameEntry[] {
  if (Array.isArray(raw)) {
    const entries: GameItemNameEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as { id?: unknown; mountId?: unknown; dyeId?: unknown; name?: unknown; label?: unknown };
      const entry = parseEntry(
        record.id ?? record.mountId ?? record.dyeId,
        record.name ?? record.label,
      );
      if (entry) entries.push(entry);
    }
    return entries;
  }

  if (raw && typeof raw === "object") {
    const entries: GameItemNameEntry[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = parseEntry(key, value);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  return [];
}

/** Pulls the mounts and dyes out of whichever shape the game server answered with. */
export function parseItemCatalogue(payload: unknown): {
  mounts: GameItemNameEntry[];
  dyes: GameItemNameEntry[];
} {
  const record = (payload ?? {}) as GameItemCatalogue;
  const nested = record.items ?? {};
  return {
    mounts: parseItemNameList(record.mounts ?? nested.mounts),
    dyes: parseItemNameList(record.dyes ?? nested.dyes),
  };
}

/**
 * Loads the game's item names into the shared tables, at most once per TTL.
 *
 * Concurrent callers share one request, and a failure is cached for the same TTL
 * as a success so an unreachable game server is asked once, not on every click.
 * Never throws: the caller only ever loses prettier labels.
 */
export async function ensureGameItemNames(): Promise<void> {
  if (Date.now() - loadedAt < CATALOGUE_TTL_MS) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const payload = await fetchGameServerAdmin<GameItemCatalogue>(
        CONTENT_PATH,
        "item catalogue",
        CATALOGUE_TIMEOUT_MS,
      );
      const { mounts, dyes } = parseItemCatalogue(payload);
      if (mounts.length === 0 && dyes.length === 0) {
        console.warn(
          "[gameContent] The game server returned no mount or dye names; falling back to ids.",
        );
      }
      applyItemNames({ mounts, dyes });
    } catch (error) {
      console.warn(
        "[gameContent] Item catalogue unavailable, falling back to ids:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      loadedAt = Date.now();
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Starts a load without waiting for it, so the caller can answer Discord immediately and
 * still have the names by the time the operator reaches a list. Used by the panels that
 * are built *before* the interaction is acknowledged, where blocking would risk the
 * 3-second window on a slow game server. The load is kept alive past the response with
 * `waitUntil` where the host provides it.
 */
export function primeGameItemNames(): void {
  if (Date.now() - loadedAt < CATALOGUE_TTL_MS) return;
  const promise = ensureGameItemNames();
  try {
    waitUntil(promise);
  } catch {
    // Not running on Vercel: the promise resolves on its own either way.
    void promise.catch(() => {});
  }
}

/** Test hook: forgets the cached catalogue so the next call reads it again. */
export function resetGameItemNamesCache(): void {
  loadedAt = 0;
  inFlight = null;
}
