import { CommandBuilder, CommandContext, IntegrationType } from "@minesa-org/mini-interaction";
import type { AutocompleteContext } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import {
  buildPortraitUrl,
  getPlayerProfile,
  searchPlayers,
} from "../utils/gameWallet.js";
import { getSponsorCredit, formatUsd } from "../utils/sponsorPacks.js";
import { interactionDiscordId, isAdministrator } from "../utils/discordInteractions.js";

export const profileCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("profile")
    .setDescription(
      "Show your linked profile, or look up another player's (admin only)",
    )
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("player")
        .setDescription(
          "Admin only. Search GitHub, Discord, character name, or game user ID",
        )
        .setAutocomplete(true)
        .setRequired(false),
    ),
  handler: async (interaction: CommandInteraction) => {
    // Anyone may look up themselves; only admins may name someone else.
    const requestedPlayer = interaction.options.getString("player", false);
    if (requestedPlayer && !isAdministrator(interaction)) {
      return interaction.reply({
        content:
          "Administrator permission is required to look up another player.",
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
            : "Your Discord account is not linked to a game account yet.",
        });
      // Most recently touched wallet is the account the player is actually using.
      const wallets = [...profile.wallets].sort(
        (left, right) => right.updatedAtMs - left.updatedAtMs,
      );
      const latest = wallets[0] ?? null;
      const portrait = buildPortraitUrl(latest);

      const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        {
          name: "GitHub",
          value: profile.githubUsername ?? "Not linked",
          inline: true,
        },
        {
          name: "Discord ID",
          value: profile.discordUserId ?? "Not linked",
          inline: true,
        },
        {
          name: "Sponsor",
          value:
            profile.isSponsor === null
              ? "Unknown"
              : profile.isSponsor
                ? `Yes (${profile.sponsorTarget ?? "unknown target"})`
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

      if (profile.discordUserId && profile.isSponsor) {
        try {
          const credit = await getSponsorCredit(profile.discordUserId);
          if (credit) {
            fields.push({
              name: "Sponsor credit",
              value:
                credit.balanceCents === null
                  ? `**Balance left:** Unknown • **Used:** ${formatUsd(credit.usedCents)}`
                  : `**Balance left:** ${formatUsd(credit.balanceCents)} • **Used:** ${formatUsd(credit.usedCents)} • Sponsored: ${formatUsd(credit.sponsoredCents ?? 0)}`,
            });
          }
        } catch (error) {
          console.warn("[profile] Sponsor credit load failed:", error);
        }
      }

      for (const wallet of wallets.slice(0, 5)) {
        fields.push({
          name: `${wallet.characterName} [${wallet.gameUserId}]`,
          value: [
            `Gold: **${wallet.gold.toLocaleString()}**`,
            `Mammoth Idols: **${wallet.mammothIdols.toLocaleString()}**`,
            `Dragon Keys: **${wallet.dragonKeys.toLocaleString()}**`,
            `Dragon Ore: **${wallet.dragonOre.toLocaleString()}**`,
            `Silver/Royal Sigils: **${wallet.silverSigils.toLocaleString()} / ${wallet.royalSigils.toLocaleString()}**`,
          ].join("\n"),
        });
      }
      if (wallets.length === 0) {
        fields.push({
          name: "Game wallets",
          value: "No matching wallet document exists yet.",
        });
      }

      return interaction.editReply({
        embeds: [
          {
            color: 0x5865f2,
            title:
              latest?.characterName ??
              profile.githubUsername ??
              "Player profile",
            ...(portrait ? { image: { url: portrait } } : {}),
            fields,
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
