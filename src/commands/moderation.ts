import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { waitUntil } from "@vercel/functions";
import {
  canManageGuild,
  interactionActorLabel,
  interactionDiscordId,
} from "../utils/discordInteractions.js";
import { findGameUserIdForDiscord } from "../utils/gameRewards.js";
import {
  banDurationSeconds,
  banGamePlayer,
  formatBanDuration,
  unbanGamePlayer,
  type BanDurationChoice,
} from "../utils/gameModeration.js";
import { publishGameLog, type GameLogField } from "../utils/gameLogChannel.js";
import { COLORS, notice, v2 } from "../ui/containers.js";


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
    console.error("[moderation] Game account lookup failed:", error);
    return null;
  }
}

/**
 * `/admin ban` and `/admin unban` take a player out of the game. The bot
 * resolves the Discord member to their linked game user and asks the game server to
 * enforce or lift the ban — the game server is the only process that can refuse a login
 * and drop a live session.
 */
export async function handleBan(interaction: CommandInteraction) {
  if (!canManageGuild(interaction)) {
    return interaction.reply(v2(notice(COLORS.muted, "Not allowed", "You need the **Manage Server** permission to ban a player from the game.")));
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
    return interaction.reply(v2(notice(COLORS.muted, "Check the target", "Pick a valid Discord member to ban.")));
  }
  if (actorId && targetId === actorId) {
    return interaction.reply(v2(notice(COLORS.muted, "Check the target", "You cannot ban yourself.")));
  }

  const durationSeconds = banDurationSeconds(durationChoice);
  const durationLabel = formatBanDuration(durationSeconds);

  interaction.deferReply({ flags: 64 });
  try {
    const userId = await resolveGameUser(targetId);
    if (userId === null) {
      return interaction.editReply(v2(notice(COLORS.muted, "Nothing to do", `<@${targetId}> has no linked Dungeon Blitz account, so there is nothing to ban.`)));
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
    return interaction.editReply(
      v2(
        notice(COLORS.danger, "Player banned from Dungeon Blitz", [
          `<@${targetId}> cannot sign in ${
            durationSeconds === null ? "until the ban is lifted." : "until the ban expires."
          }`,
          `Game user **${result.userId}** · ${durationLabel}${
            Number.isFinite(endsAt) ? ` · expires <t:${Math.floor(endsAt / 1000)}:R>` : ""
          }`,
          ...(reason ? [`Reason: ${reason}`] : []),
          `-# Banned by ${interactionActorLabel(interaction)}`,
        ]),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[moderation] Ban failed:", error);
    reportModeration("game-ban-error", "⚠️ Game ban failed", [
      { name: "Player", value: `<@${targetId}>`, inline: true },
      { name: "Duration", value: durationLabel, inline: true },
      { name: "Error", value: message.slice(0, 1000) },
    ]);
    return interaction.editReply(v2(notice(COLORS.danger, "Ban failed", `The ban could not be applied: ${message}`)));
  }
}

export async function handleUnban(interaction: CommandInteraction) {
  if (!canManageGuild(interaction)) {
    return interaction.reply(v2(notice(COLORS.muted, "Not allowed", "You need the **Manage Server** permission to lift a game ban.")));
  }

  const target = interaction.options.getUser("target", true);
  const reason = interaction.options.getString("reason", false)?.trim() || undefined;
  const actorId = interactionDiscordId(interaction);
  const targetId = String(target?.user?.id ?? "").trim();
  if (!targetId) {
    return interaction.reply(v2(notice(COLORS.muted, "Check the target", "Pick a valid Discord member to unban.")));
  }

  interaction.deferReply({ flags: 64 });
  try {
    const userId = await resolveGameUser(targetId);
    if (userId === null) {
      return interaction.editReply(v2(notice(COLORS.muted, "Nothing to do", `<@${targetId}> has no linked Dungeon Blitz account.`)));
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

    return interaction.editReply(
      v2(
        notice(COLORS.success, "Game ban lifted", [
          `<@${targetId}> can sign in to Dungeon Blitz again.`,
          `Game user **${result.userId}**`,
          ...(reason ? [`Reason: ${reason}`] : []),
          `-# Lifted by ${interactionActorLabel(interaction)}`,
        ]),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[moderation] Unban failed:", error);
    reportModeration("game-unban-error", "⚠️ Game unban failed", [
      { name: "Player", value: `<@${targetId}>`, inline: true },
      { name: "Error", value: message.slice(0, 1000) },
    ]);
    return interaction.editReply(v2(notice(COLORS.danger, "Unban failed", `The ban could not be lifted: ${message}`)));
  }
}
