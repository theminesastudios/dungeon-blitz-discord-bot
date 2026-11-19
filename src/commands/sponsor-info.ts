import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { getSponsorDonationInfo } from "../utils/githubSponsors.js";
import { buildSponsorHistory, fetchGithubSponsorEvents, formatSponsorHistory } from "../utils/sponsorHistory.js";
import { isAdministrator } from "../utils/discordInteractions.js";

/** `/admin sponsor` — shows a GitHub sponsor's tier, status, Royal Sigils and month-by-month history. */
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
    const [sponsorship, events] = await Promise.all([
      getSponsorDonationInfo(githubUsername),
      fetchGithubSponsorEvents(githubUsername).catch((error) => {
        console.warn("[sponsor-info] Sponsor activity unavailable:", error);
        return null;
      }),
    ]);
    const history = events ? buildSponsorHistory(events, Date.now()) : null;
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
    return interaction.editReply({
      embeds: [
        {
          color: sponsorship.isActive ? 0x2da44e : 0x6e7781,
          title: `${sponsorship.githubUsername}'s sponsorship`,
          description: (history ? formatSponsorHistory(history, 8) : ["Sponsor activity is not available right now."]).join("\n").slice(0, 4000),
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
            {
              name: "Royal Sigils from GitHub",
              value: history ? history.totalCents.toLocaleString("en-US") : "Not visible",
              inline: true,
            },
            {
              name: "Tier",
              value: sponsorship.tierName ?? "Not visible",
              inline: true,
            },
            { name: "Started", value: `<t:${startedAt}:D>`, inline: true },
          ],
          footer: {
            text: "$1 = 100 Royal Sigils. Monthly payments are counted from GitHub's sponsor activity: start, tier changes and cancellations.",
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
