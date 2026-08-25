import {
  CommandBuilder,
  CommandContext,
  IntegrationType,
} from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { getSponsorDonationInfo } from "../utils/githubSponsors.js";

export const sponsorInfoCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("sponsor-info")
    .setDescription("Show a GitHub sponsor's sponsorship information")
    .setDefaultMemberPermissions(8n)
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("github_username")
        .setDescription("The sponsor's GitHub username")
        .setRequired(true),
    ),
  handler: async (interaction: CommandInteraction) => {
    if (!isAdministrator(interaction)) {
      return interaction.reply({
        content: "Administrator permission is required.",
        flags: 64,
      });
    }
    const githubUsername = interaction.options.getString(
      "github_username",
      true,
    )!;
    interaction.deferReply({ flags: 64 });

    try {
      const sponsorship = await getSponsorDonationInfo(githubUsername);
      if (!sponsorship) {
        return interaction.editReply({
          content: `No GitHub sponsorship information was found for **${githubUsername}**.`,
        });
      }

      const amount =
        sponsorship.amountInCents === null
          ? "Not visible"
          : `$${(sponsorship.amountInCents / 100).toFixed(2)} USD${
              sponsorship.isOneTimePayment ? " one-time" : " per month"
            }`;
      const startedAt = Math.floor(
        new Date(sponsorship.createdAt).getTime() / 1000,
      );
      const estimatedTotal =
        sponsorship.estimatedTotalInCents === null
          ? "Not visible"
          : `$${(sponsorship.estimatedTotalInCents / 100).toFixed(2)} USD`;
      const totalLabel =
        sponsorship.totalEstimateScope === "current-tier"
          ? "Estimated total (current tier only)"
          : sponsorship.totalEstimateScope === "one-time"
            ? "Total donation"
            : "Estimated total";

      return interaction.editReply({
        embeds: [
          {
            color: sponsorship.isActive ? 0x2da44e : 0x6e7781,
            title: `${sponsorship.githubUsername}'s sponsorship`,
            url: `https://github.com/${encodeURIComponent(sponsorship.githubUsername)}`,
            fields: [
              {
                name: "Sponsored account",
                value: sponsorship.targetLogin,
                inline: true,
              },
              {
                name: "Status",
                value: sponsorship.isActive ? "Active" : "Past sponsor",
                inline: true,
              },
              { name: "Amount", value: amount, inline: true },
              { name: totalLabel, value: estimatedTotal, inline: true },
              {
                name: "Tier",
                value: sponsorship.tierName ?? "Not visible",
                inline: true,
              },
              { name: "Started", value: `<t:${startedAt}:D>`, inline: true },
            ],
            footer: {
              text: "Recurring totals are estimates from the visible tier and dates; GitHub does not expose a payment ledger.",
            },
          },
        ],
      });
    } catch (error) {
      console.error(
        "[sponsor-info] Failed to load sponsorship information:",
        error,
      );
      return interaction.editReply({
        content:
          "I couldn't load that sponsor's information from GitHub right now.",
      });
    }
  },
};

function isAdministrator(interaction: CommandInteraction) {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined || permissions === null) return false;
  return (BigInt(permissions) & 8n) === 8n;
}
