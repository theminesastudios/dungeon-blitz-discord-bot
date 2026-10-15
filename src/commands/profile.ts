import { ContainerBuilder } from "@minesa-org/mini-interaction";
import type { AutocompleteContext, CommandInteraction } from "@minesa-org/mini-interaction";
import {
  buildPortraitUrl,
  getPlayerProfile,
  searchPlayers,
  type GameWalletSummary,
  type PlayerProfile,
} from "../utils/gameWallet.js";
import { getSponsorCredit, formatCreditAmount, CREDIT_EMOJI } from "../utils/sponsorPacks.js";
import { characterSubtitle } from "../utils/characterDisplay.js";
import {
  COLORS,
  divider,
  errorNotice,
  formatNumber,
  notice,
  section,
  text,
  thumbnail,
  v2,
} from "../ui/containers.js";
import { classEmoji, emoji } from "../ui/emojis.js";

/** One compact balance block per character. */
function walletLines(wallet: GameWalletSummary): string {
  return [
    `${classEmoji(wallet.characterClass)} **${wallet.characterName}**`,
    characterSubtitle(wallet),
    `${emoji("cur_gold")} ${formatNumber(wallet.gold)} · ${emoji("cur_idol")} ${formatNumber(wallet.mammothIdols)} · ${emoji("cur_dragon_key")} ${formatNumber(wallet.dragonKeys)} · ${emoji("cur_dragon_ore")} ${formatNumber(wallet.dragonOre)} · ${emoji("cur_silver_sigil")} ${formatNumber(wallet.silverSigils)} · ${emoji("cur_royal_sigil")} ${formatNumber(wallet.royalSigils)}`,
  ].join("\n");
}

function yesNo(value: boolean | null, yes = "Yes"): string {
  return value === null ? "Unknown" : value ? yes : "No";
}

export function buildStaffProfile(profile: PlayerProfile, creditLine: string | null): ContainerBuilder {
  const wallets = [...profile.wallets].sort((a, b) => b.lastPlayedMs - a.lastPlayedMs);
  const latest = wallets[0] ?? null;
  const owner = latest?.owner;
  const title = owner?.discordUsername ? `@${owner.discordUsername}` : profile.githubUsername ?? "Player profile";
  const identity = [
    `## ${title}`,
    `-# Discord ${profile.discordUserId ? `<@${profile.discordUserId}>` : "not linked"} · GitHub ${profile.githubUsername ?? "not linked"}${latest ? ` · Game user ${latest.gameUserId}` : ""}`,
    `Sponsor **${yesNo(profile.isSponsor, profile.sponsorTarget ? `Yes (${profile.sponsorTarget})` : "Yes")}** · Contributor **${yesNo(profile.isContributor)}**`,
    ...(creditLine ? [creditLine] : []),
  ].join("\n");
  const portrait = buildPortraitUrl(latest);
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.brand)
    .addComponent(portrait ? section(identity, thumbnail(portrait)) : text(identity))
    .addComponent(divider());
  if (wallets.length === 0) {
    container.addComponent(text("-# No characters on a live save."));
  }
  for (const wallet of wallets.slice(0, 8)) container.addComponent(text(walletLines(wallet)));
  return container;
}

/**
 * `/admin profile` — the staff view of a player: identity, sponsor state, shop credit and every
 * live character's balances. Players see their own data on `/account view` and anyone's
 * public card on `/player`; this is the only place one player's balances are shown to another.
 */
export async function handleProfile(interaction: CommandInteraction) {
  const selector = interaction.options.getString("player", true) ?? "";
  interaction.deferReply({ flags: 64 });
  try {
    const profile = await getPlayerProfile(selector);
    if (!profile) {
      return interaction.editReply(v2(notice(COLORS.muted, "Player not found", "No live account matches that player.")));
    }

    let creditLine: string | null = null;
    if (profile.discordUserId) {
      try {
        const credit = await getSponsorCredit(profile.discordUserId);
        if (credit && (credit.isSponsor || credit.bonusCents > 0)) {
          const bonus = credit.bonusCents > 0 ? ` · bonus ${formatCreditAmount(credit.bonusCents)}` : "";
          creditLine =
            credit.balanceCents === null
              ? `${CREDIT_EMOJI} Credits: balance unknown · used ${formatCreditAmount(credit.usedCents)}${bonus}`
              : `${CREDIT_EMOJI} Credits: **${formatCreditAmount(credit.balanceCents)}** left · used ${formatCreditAmount(credit.usedCents)} · sponsored ${formatCreditAmount(credit.sponsoredCents ?? 0)}${bonus}`;
        }
      } catch (error) {
        console.warn("[profile] Sponsor credit load failed:", error);
      }
    }
    return interaction.editReply(v2(buildStaffProfile(profile, creditLine)));
  } catch (error) {
    console.error("[profile] Failed to load player profile:", error);
    return interaction.editReply(errorNotice("The player profile could not be loaded."));
  }
}

export async function handleProfileAutocomplete(autocomplete: AutocompleteContext) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "player") {
    autocomplete.respond([]);
    return;
  }
  try {
    const players = await searchPlayers(String(focused.value ?? ""));
    autocomplete.respond(players.map((player) => ({ name: player.label, value: player.selector })));
  } catch (error) {
    console.error("[profile] Autocomplete failed:", error);
    autocomplete.respond([]);
  }
}
