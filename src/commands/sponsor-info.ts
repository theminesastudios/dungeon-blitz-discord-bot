import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { getSponsorDonationInfo } from "../utils/githubSponsors.js";
import { isAdministrator } from "../utils/discordInteractions.js";

/** `/admin sponsor` — shows a GitHub sponsor's visible tier, status and estimated total. */
export async function handleSponsorInfo(interaction: CommandInteraction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({
      content: "Administrator permission is required.",
      flags: 64,
    });
  }
  const githubUsername = interaction.options.getString("github_username", true)!;
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
}
