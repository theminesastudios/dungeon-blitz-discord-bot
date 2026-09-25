import { requestGameServerAdmin } from "./gameMaintenance.js";

/* ------------------------------------------------------------------
 * Game moderation
 *
 * Bans are enforced by the game server, not the bot: only the process that holds the
 * player connections can refuse a login and drop a session. The bot therefore calls the
 * game server's admin API (same shared secret as `/maintenance` and `/idols`) and reports
 * what it heard back. A duration of `null` means permanent.
 * ------------------------------------------------------------------ */

export type BanDurationChoice = "1h" | "1d" | "3d" | "7d" | "30d" | "permanent";

export const BAN_DURATION_CHOICES: Array<{
  name: string;
  value: BanDurationChoice;
}> = [
  { name: "1 hour", value: "1h" },
  { name: "1 day", value: "1d" },
  { name: "3 days", value: "3d" },
  { name: "7 days", value: "7d" },
  { name: "30 days", value: "30d" },
  { name: "Permanent", value: "permanent" },
];

/** Seconds for a duration choice, or null for a permanent ban. */
export function banDurationSeconds(choice: BanDurationChoice): number | null {
  switch (choice) {
    case "1h":
      return 60 * 60;
    case "1d":
      return 24 * 60 * 60;
    case "3d":
      return 3 * 24 * 60 * 60;
    case "7d":
      return 7 * 24 * 60 * 60;
    case "30d":
      return 30 * 24 * 60 * 60;
    case "permanent":
      return null;
  }
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/** Human phrasing for a ban length, also used in the confirmation and the log. */
export function formatBanDuration(seconds: number | null): string {
  if (seconds === null) return "permanent";
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

export type BanResult = {
  ok: true;
  userId: number;
  characterName?: string;
  permanent: boolean;
  durationSeconds: number | null;
  /** ISO timestamp the game server computed, when it reported one. */
  expiresAt?: string;
  /** How many live sessions it dropped as part of the ban. */
  sessionsClosed?: number;
};

export type UnbanResult = {
  ok: true;
  userId: number;
  characterName?: string;
};

/**
 * Bans a game user. `durationSeconds` of null bans permanently. The shared secret and the
 * base URL come from the same environment as the other admin calls, so a deployment that
 * can run `/maintenance` can ban too.
 */
export async function banGamePlayer(input: {
  userId: number;
  durationSeconds: number | null;
  reason?: string;
  bannedByDiscordId: string;
}): Promise<BanResult> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("A valid game user id is required to ban a player");
  }
  const payload = await requestGameServerAdmin<BanResult>(
    "/api/admin/ban",
    {
      userId: input.userId,
      permanent: input.durationSeconds === null,
      durationSeconds: input.durationSeconds,
      ...(input.reason ? { reason: input.reason } : {}),
      bannedByDiscordId: input.bannedByDiscordId,
    },
    "game ban",
  );
  return payload;
}

/** Lifts a ban, permanent or otherwise, for a game user. */
export async function unbanGamePlayer(input: {
  userId: number;
  unbannedByDiscordId: string;
}): Promise<UnbanResult> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("A valid game user id is required to unban a player");
  }
  const payload = await requestGameServerAdmin<UnbanResult>(
    "/api/admin/unban",
    {
      userId: input.userId,
      unbannedByDiscordId: input.unbannedByDiscordId,
    },
    "game unban",
  );
  return payload;
}
