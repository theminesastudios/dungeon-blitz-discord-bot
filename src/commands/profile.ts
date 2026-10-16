import { ContainerBuilder } from "@minesa-org/mini-interaction";
import type { AutocompleteContext, CommandInteraction } from "@minesa-org/mini-interaction";
import {
  buildPortraitUrl,
  getPlayerProfile,
  searchPlayers,
  type GameWalletSummary,
  type PlayerProfile,
} from "../utils/gameWallet.js";
import { disciplineName } from "../utils/characterDisplay.js";
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
import { classEmoji, disciplineEmoji, emoji } from "../ui/emojis.js";

/**
 * `-# ⭐ Level 50 · 1,234,567 XP · Paladin · ⚖️ Justicar`. Unlike the shared subtitle it leaves
 * out the class icon (the name line already has it): eight characters on one save have to fit
 * in Discord's 4,000-character message limit, and every custom emoji costs ~35 characters.
 */
function profileSubtitle(wallet: GameWalletSummary): string {
  const parts = [`${emoji("ui_level")} Level ${wallet.characterLevel}`, `${formatNumber(wallet.characterXp)} XP`];
  if (wallet.characterClass) parts.push(wallet.characterClass);
  const discipline = disciplineName(wallet);
  parts.push(discipline ? `${disciplineEmoji(wallet.characterMasterClass)} ${discipline}`.trim() : "No discipline yet");
  return `-# ${parts.join(" · ")}`;
}

/** One compact block per character: level, total experience and balances. */
function walletLines(wallet: GameWalletSummary): string {
  return [
    `${classEmoji(wallet.characterClass)} **${wallet.characterName}**`,
    profileSubtitle(wallet),
    `${emoji("cur_gold")} ${formatNumber(wallet.gold)} · ${emoji("cur_idol")} ${formatNumber(wallet.mammothIdols)} · ${emoji("cur_dragon_key")} ${formatNumber(wallet.dragonKeys)} · ${emoji("cur_dragon_ore")} ${formatNumber(wallet.dragonOre)} · ${emoji("cur_silver_sigil")} ${formatNumber(wallet.silverSigils)} · ${emoji("cur_royal_sigil")} ${formatNumber(wallet.royalSigils)}`,
  ].join("\n");
}

export function buildStaffProfile(profile: PlayerProfile): ContainerBuilder {
  const wallets = [...profile.wallets].sort((a, b) => b.lastPlayedMs - a.lastPlayedMs);
  const latest = wallets[0] ?? null;
  const owner = latest?.owner;
  const title = owner?.discordUsername ? `@${owner.discordUsername}` : profile.githubUsername ?? "Player profile";
  const identity = [
    `## ${title}`,
    `-# Discord ${profile.discordUserId ? `<@${profile.discordUserId}>` : "not linked"} · GitHub ${profile.githubUsername ?? "not linked"}${latest ? ` · Game user ${latest.gameUserId}` : ""}`,
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
 * `/admin profile` — the staff view of a player: who they are and every live character's level,
 * experience and balances. Players see their own data on `/account view` and anyone's
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
    return interaction.editReply(v2(buildStaffProfile(profile)));
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
