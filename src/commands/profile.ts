import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "@minesa-org/mini-interaction";
import type {
  AutocompleteContext,
  CommandInteraction,
  MessageActionRowComponent,
  MessageComponentInteraction,
} from "@minesa-org/mini-interaction";
import {
  buildPortraitUrl,
  getAccountActivity,
  getCharacterProgress,
  getPlayerProfile,
  searchPlayers,
  type AccountActivity,
  type CharacterProgress,
  type GameWalletSummary,
  type PlayerProfile,
} from "../utils/gameWallet.js";
import { ABILITIES } from "../data/abilities.js";
import { disciplineName } from "../utils/characterDisplay.js";
import { masterClassName } from "../utils/gameStatsSync.js";
import { characterPlaytimeKey, formatPlaytime } from "../utils/playtime.js";
import { isAdministrator } from "../utils/discordInteractions.js";
import {
  buttonRow,
  COLORS,
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
import { classEmoji, disciplineEmoji, emoji } from "../ui/emojis.js";

const ID = {
  inspect: "admin-profile:inspect",
  /** `admin-profile:back:<discordId>` re-opens the owner's whole profile. */
  back: "admin-profile:back:",
} as const;

/** A save holds at most 8 characters (`LoginHandler` sends max_chars = 8). */
const MAX_CHARACTERS = 8;

/** The cap on a Class Tower's research (`TalentHandler.MAX_TALENT_POINTS_PER_CLASS`). */
const MAX_TALENT_POINTS = 50;

/** The first `MasterClassID` of each base class; its disciplines are the next three ids. */
const DISCIPLINE_OFFSET: Record<string, number> = { rogue: 0, paladin: 3, mage: 6 };

function playtimeOf(activity: AccountActivity | null, wallet: GameWalletSummary): number {
  return activity?.characterPlaytimeMs[characterPlaytimeKey(wallet.characterName)] ?? 0;
}

/**
 * `-# ⭐ Level 50 · 1,234,567 XP · Played 3h 5m · ⚖️ Justicar`. Tighter than the shared
 * subtitle: eight characters on one save have to fit in Discord's 4,000-character message
 * limit, and every custom emoji costs ~35 characters. The class icon is on the name line
 * already, so the class is named only when no discipline (which implies it) is chosen yet —
 * unless `withClass`, for the one-character detail view that has room.
 */
function profileSubtitle(wallet: GameWalletSummary, playtimeMs: number, withClass = false): string {
  const parts = [`${emoji("ui_level")} Level ${wallet.characterLevel}`, `${formatNumber(wallet.characterXp)} XP`];
  if (playtimeMs > 0) parts.push(`Played ${formatPlaytime(playtimeMs)}`);
  const discipline = disciplineName(wallet);
  if (wallet.characterClass && (withClass || !discipline)) parts.push(wallet.characterClass);
  parts.push(discipline ? `${disciplineEmoji(wallet.characterMasterClass)} ${discipline}`.trim() : "No discipline yet");
  return `-# ${parts.join(" · ")}`;
}

function balanceLine(wallet: GameWalletSummary): string {
  return `${emoji("cur_gold")} ${formatNumber(wallet.gold)} · ${emoji("cur_idol")} ${formatNumber(wallet.mammothIdols)} · ${emoji("cur_dragon_key")} ${formatNumber(wallet.dragonKeys)} · ${emoji("cur_dragon_ore")} ${formatNumber(wallet.dragonOre)} · ${emoji("cur_silver_sigil")} ${formatNumber(wallet.silverSigils)} · ${emoji("cur_royal_sigil")} ${formatNumber(wallet.royalSigils)}`;
}

/** One compact block per character: level, total experience, playtime and balances. */
function walletLines(wallet: GameWalletSummary, playtimeMs: number): string {
  return [
    `${classEmoji(wallet.characterClass)} **${wallet.characterName}**`,
    profileSubtitle(wallet, playtimeMs),
    balanceLine(wallet),
  ].join("\n");
}

/** `-# Played 3d 4h · 120 runs (98 won) · 4,512 kills · 33 deaths`, or null with nothing recorded. */
export function activityLine(activity: AccountActivity | null): string | null {
  if (!activity) return null;
  const { playtimeMs, runs, wins, kills, deaths } = activity;
  if (playtimeMs + runs + wins + kills + deaths <= 0) return null;
  return `-# Played ${formatPlaytime(playtimeMs)} · ${formatNumber(runs)} runs (${formatNumber(wins)} won) · ${formatNumber(kills)} kills · ${formatNumber(deaths)} deaths`;
}

function inspectRow(wallets: GameWalletSummary[]): ActionRowBuilder<MessageActionRowComponent> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(ID.inspect)
    .setPlaceholder("Inspect a character: abilities, talents…")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(
      wallets.map((wallet) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(wallet.characterName.slice(0, 100))
          .setValue(wallet.selector.slice(0, 100))
          .setDescription(
            [`Level ${wallet.characterLevel}`, wallet.characterClass, disciplineName(wallet) ?? ""]
              .filter(Boolean)
              .join(" · ")
              .slice(0, 100),
          ),
      ),
    );
  return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

export function buildStaffProfile(profile: PlayerProfile, activity: AccountActivity | null = null): ContainerBuilder {
  const wallets = [...profile.wallets].sort((a, b) => b.lastPlayedMs - a.lastPlayedMs).slice(0, MAX_CHARACTERS);
  const latest = wallets[0] ?? null;
  const owner = latest?.owner;
  const title = owner?.discordUsername ? `@${owner.discordUsername}` : profile.githubUsername ?? "Player profile";
  const activitySummary = activityLine(activity);
  const identity = [
    `## ${title}`,
    `-# Discord ${profile.discordUserId ? `<@${profile.discordUserId}>` : "not linked"} · GitHub ${profile.githubUsername ?? "not linked"}${latest ? ` · Game user ${latest.gameUserId}` : ""}`,
    ...(activitySummary ? [activitySummary] : []),
  ].join("\n");
  const portrait = buildPortraitUrl(latest);
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.brand)
    .addComponent(portrait ? section(identity, thumbnail(portrait)) : text(identity))
    .addComponent(divider());
  if (wallets.length === 0) {
    container.addComponent(text("-# No characters on a live save."));
    return container;
  }
  for (const wallet of wallets) container.addComponent(text(walletLines(wallet, playtimeOf(activity, wallet))));
  return container.addComponent(inspectRow(wallets));
}

/** "Triple Strike" with its rank out of the max, bold; an unknown id is shown by number. */
function abilityLabel(id: number, rank: number): string {
  const info = ABILITIES[id];
  return info ? `${info.name} **${rank}**/${info.maxRank}` : `Ability ${id} **${rank}**`;
}

/**
 * Abilities grouped the way the game's skill book is: the base class first, then each
 * discipline. The basic melee (max rank 0) is not an ability anyone upgrades and is left out.
 */
export function abilityLines(progress: CharacterProgress): string[] {
  const groups = new Map<string, string[]>();
  for (const ability of progress.abilities) {
    const info = ABILITIES[ability.id];
    if (info && info.maxRank <= 0) continue;
    const group = info?.className || "Other";
    groups.set(group, [...(groups.get(group) ?? []), abilityLabel(ability.id, ability.rank)]);
  }
  if (groups.size === 0) return ["-# No abilities learned."];
  const base = progress.wallet.characterClass.toLowerCase();
  const order = [...groups.keys()].sort(
    (a, b) => Number(b.toLowerCase() === base) - Number(a.toLowerCase() === base) || a.localeCompare(b),
  );
  const lines = order.map((group) => `**${group}** — ${groups.get(group)!.join(" · ")}`);
  const hotbar = progress.activeAbilities.map((id) => ABILITIES[id]?.name ?? `Ability ${id}`);
  if (hotbar.length > 0) lines.push(`-# Hotbar: ${hotbar.join(", ")}`);
  return lines;
}

/** `Executioner 50/50 · Shadowwalker 12/50 · Soulthief 0/50`, one Class Tower per discipline. */
export function talentLine(progress: CharacterProgress): string {
  const offset = DISCIPLINE_OFFSET[progress.wallet.characterClass.trim().toLowerCase()];
  const keys = ["1", "2", "3"];
  if (offset === undefined) {
    return keys.map((key) => `Tower ${key}: ${progress.talentPoints[key] ?? 0}/${MAX_TALENT_POINTS}`).join(" · ");
  }
  return keys
    .map((key) => `${masterClassName(offset + Number(key)) || `Tower ${key}`} ${progress.talentPoints[key] ?? 0}/${MAX_TALENT_POINTS}`)
    .join(" · ");
}

/** The staff detail view of one character: everything on the overview plus abilities and talents. */
export function buildCharacterInspect(progress: CharacterProgress, activity: AccountActivity | null): ContainerBuilder {
  const { wallet } = progress;
  const lastPlayed = wallet.lastPlayedMs > 0 ? ` · Last played <t:${Math.floor(wallet.lastPlayedMs / 1000)}:R>` : "";
  const heading = [
    `## ${classEmoji(wallet.characterClass)} ${wallet.characterName}`,
    profileSubtitle(wallet, playtimeOf(activity, wallet), true),
    `-# Game user ${wallet.gameUserId}${wallet.owner ? ` · <@${wallet.owner.discordId}>` : ""}${lastPlayed}`,
  ].join("\n");
  const portrait = buildPortraitUrl(wallet);
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.brand)
    .addComponent(portrait ? section(heading, thumbnail(portrait, wallet.characterName)) : text(heading))
    .addComponent(text(balanceLine(wallet)))
    .addComponent(divider())
    .addComponent(text(["### Abilities", ...abilityLines(progress)].join("\n")))
    .addComponent(text(`### Class Tower talent points\n${talentLine(progress)}`));
  if (wallet.owner) {
    container.addComponent(
      buttonRow(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("Back to profile")
          .setCustomId(`${ID.back}${wallet.owner.discordId}`),
      ),
    );
  }
  return container;
}

/** The account's activity counters; a failure only hides that line, it never fails the view. */
async function loadActivity(gameUserId: number | undefined): Promise<AccountActivity | null> {
  if (!gameUserId) return null;
  try {
    return await getAccountActivity(gameUserId);
  } catch (error) {
    console.warn("[profile] Account activity load failed:", error);
    return null;
  }
}

async function loadProfileView(selector: string): Promise<ContainerBuilder | null> {
  const profile = await getPlayerProfile(selector);
  if (!profile) return null;
  const activity = await loadActivity(profile.wallets[0]?.gameUserId);
  return buildStaffProfile(profile, activity);
}

const playerNotFound = () => notice(COLORS.muted, "Player not found", "No live account matches that player.");

/**
 * `/admin profile` — the staff view of a player: who they are, what the account has done
 * (playtime, runs, kills, deaths) and every live character's level, experience, playtime and
 * balances, with a picker that opens one character's abilities and talents. Players see their
 * own data on `/account view` and anyone's public card on `/player`; this is the only place one
 * player's details are shown to another.
 */
export async function handleProfile(interaction: CommandInteraction) {
  const selector = interaction.options.getString("player", true) ?? "";
  interaction.deferReply({ flags: 64 });
  try {
    const view = await loadProfileView(selector);
    return interaction.editReply(v2(view ?? playerNotFound()));
  } catch (error) {
    console.error("[profile] Failed to load player profile:", error);
    return interaction.editReply(errorNotice("The player profile could not be loaded."));
  }
}

function deny(interaction: MessageComponentInteraction) {
  return interaction.reply(v2(notice(COLORS.danger, "Not allowed", "Administrator permission is required.")));
}

export const profileInspectSelect = {
  customId: ID.inspect,
  handler: async (interaction: MessageComponentInteraction) => {
    if (!isAdministrator(interaction)) return deny(interaction);
    const selector = String(interaction.getStringValues()[0] ?? "");
    interaction.deferUpdate();
    try {
      const progress = await getCharacterProgress(selector);
      if (!progress) {
        return interaction.editReply(
          v2Update(notice(COLORS.muted, "Character not found", "That character is no longer on a live save.")),
        );
      }
      const activity = await loadActivity(progress.wallet.gameUserId);
      return interaction.editReply(v2Update(buildCharacterInspect(progress, activity)));
    } catch (error) {
      console.error("[profile] Character inspect failed:", error);
      return interaction.editReply(v2Update(notice(COLORS.danger, "Something went wrong", "The character could not be loaded.")));
    }
  },
};

export const profileBackButton = {
  customId: `${ID.back}*`,
  handler: async (interaction: MessageComponentInteraction) => {
    if (!isAdministrator(interaction)) return deny(interaction);
    const discordId = interaction.data.custom_id.slice(ID.back.length);
    interaction.deferUpdate();
    try {
      const view = /^\d+$/.test(discordId) ? await loadProfileView(`profile:${discordId}`) : null;
      return interaction.editReply(v2Update(view ?? playerNotFound()));
    } catch (error) {
      console.error("[profile] Failed to reload player profile:", error);
      return interaction.editReply(v2Update(notice(COLORS.danger, "Something went wrong", "The player profile could not be loaded.")));
    }
  },
};

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
