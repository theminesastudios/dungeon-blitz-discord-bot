import {
  CommandBuilder,
  CommandContext,
  IntegrationType,
} from "@minesa-org/mini-interaction";
import type { AutocompleteContext } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import {
  buildPortraitUrl,
  getPlayerProfile,
  searchPlayers,
  type GameWalletSummary,
} from "../utils/gameWallet.js";
import { getSponsorCredit, formatUsd } from "../utils/sponsorPacks.js";
import {
  canManageGuild,
  interactionDiscordId,
} from "../utils/discordInteractions.js";

const PINNED_COLOR = 0x5865f2;

function walletTitle(wallet: GameWalletSummary): string {
  const bits = [`${wallet.characterName}`, `· Lv ${wallet.characterLevel}`];
  if (wallet.characterClass) bits.push(`· ${wallet.characterClass}`);
  return bits.join(" ").slice(0, 256);
}

/** One compact two-column balance block, so a wallet reads at a glance instead of a wall of text. */
function walletValue(wallet: GameWalletSummary): string {
  return [
    `💰 **Gold** ${wallet.gold.toLocaleString()}  ·  🔮 **Mammoth Idols** ${wallet.mammothIdols.toLocaleString()}`,
    `🗝️ **Dragon Keys** ${wallet.dragonKeys.toLocaleString()}  ·  ⛏️ **Dragon Ore** ${wallet.dragonOre.toLocaleString()}`,
    `🪙 **Silver** ${wallet.silverSigils.toLocaleString()}  ·  👑 **Royal** ${wallet.royalSigils.toLocaleString()}`,
  ].join("\n");
}

/**
 * `/profile` shows the invoking player their own linked account and balances. Looking up
 * someone else is a staff action and is gated on Manage Server (or Administrator), so a
 * player can never read another player's wallet through the command.
 */
export const profileCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("profile")
    .setDescription("Show your linked game profile and balances")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("player")
        .setDescription(
          "Staff only (Manage Server). Search GitHub, Discord, character name, or game user ID",
        )
        .setAutocomplete(true)
        .setRequired(false),
    ),
  handler: async (interaction: CommandInteraction) => {
    // Anyone may look up themselves; only staff may name someone else.
    const requestedPlayer = interaction.options.getString("player", false);
    if (requestedPlayer && !canManageGuild(interaction)) {
      return interaction.reply({
        content:
          "You need the **Manage Server** permission to look up another player's profile. Run `/profile` without options to see your own balances.",
        flags: 64,
      });
    }

    interaction.deferReply({ flags: 64 });
    const selector =
      requestedPlayer ?? `profile:${interactionDiscordId(interaction)}`;

    try {
      const profile = await getPlayerProfile(selector);
      if (!profile)
        return interaction.editReply({
          content: requestedPlayer
            ? "Player profile was not found."
            : "Your Discord account is not linked to a game account yet. Run `/account create` to link it.",
        });

      // Most recently touched wallet is the account the player is actually using.
      const wallets = [...profile.wallets].sort(
        (left, right) => right.updatedAtMs - left.updatedAtMs,
      );
      const latest = wallets[0] ?? null;
      const portrait = buildPortraitUrl(latest);

      const identityFields: Array<{
        name: string;
        value: string;
        inline?: boolean;
      }> = [
        {
          name: "GitHub",
          value: profile.githubUsername ?? "Not linked",
          inline: true,
        },
        {
          name: "Discord",
          value: profile.discordUserId ? `<@${profile.discordUserId}>` : "Not linked",
          inline: true,
        },
        {
          name: "Sponsor",
          value:
            profile.isSponsor === null
              ? "Unknown"
              : profile.isSponsor
                ? `Yes${profile.sponsorTarget ? ` (${profile.sponsorTarget})` : ""}`
                : "No",
          inline: true,
        },
        {
          name: "Contributor",
          value:
            profile.isContributor === null
              ? "Unknown"
              : profile.isContributor
                ? "Yes"
                : "No",
          inline: true,
        },
      ];

      if (profile.discordUserId) {
        try {
          const credit = await getSponsorCredit(profile.discordUserId);
          if (credit && (credit.isSponsor || credit.bonusCents > 0)) {
            const bonusPart =
              credit.bonusCents > 0
                ? `  ·  🎁 **Bonus** ${formatUsd(credit.bonusCents)}`
                : "";
            identityFields.push({
              name: "Shop credit",
              value:
                credit.balanceCents === null
                  ? `**Balance left:** Unknown  ·  **Used:** ${formatUsd(credit.usedCents)}${bonusPart}`
                  : `**Balance left:** ${formatUsd(credit.balanceCents)}  ·  **Used:** ${formatUsd(credit.usedCents)}  ·  **Sponsored:** ${formatUsd(credit.sponsoredCents ?? 0)}${bonusPart}`,
            });
          }
        } catch (error) {
          console.warn("[profile] Sponsor credit load failed:", error);
        }
      }

      const walletFields = wallets.slice(0, 5).map((wallet) => ({
        name: walletTitle(wallet),
        value: walletValue(wallet),
      }));
      if (wallets.length === 0) {
        walletFields.push({
          name: "Game wallets",
          value: "No matching wallet document exists yet.",
        });
      }

      return interaction.editReply({
        embeds: [
          {
            color: PINNED_COLOR,
            author: { name: "Dungeon Blitz profile" },
            title:
              latest?.characterName ??
              profile.githubUsername ??
              "Player profile",
            ...(portrait ? { thumbnail: { url: portrait } } : {}),
            fields: [...identityFields, ...walletFields],
            footer: {
              text: latest
                ? `Active character · game user ${latest.gameUserId}`
                : "No game wallet found",
            },
          },
        ],
      });
    } catch (error) {
      console.error("[profile] Failed to load player profile:", error);
      return interaction.editReply({
        content: "The player profile could not be loaded.",
      });
    }
  },
};

export async function handleProfileAutocomplete(
  autocomplete: AutocompleteContext,
) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "player") {
    autocomplete.respond([]);
    return;
  }

  try {
    const players = await searchPlayers(String(focused.value ?? ""));
    autocomplete.respond(
      players.map((player) => ({
        name: player.label.slice(0, 100),
        value: player.selector,
      })),
    );
  } catch (error) {
    console.error("[profile] Autocomplete failed:", error);
    autocomplete.respond([]);
  }
}
