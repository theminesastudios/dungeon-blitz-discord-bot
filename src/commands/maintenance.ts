import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { broadcastGameMaintenance } from "../utils/gameMaintenance.js";
import { isAdministrator } from "../utils/discordInteractions.js";

/** `/admin maintenance` — starts the in-game maintenance countdown. */
export async function handleMaintenance(interaction: CommandInteraction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({
      content: "Administrator permission is required.",
      flags: 64,
    });
  }
  const seconds = interaction.options.getNumber("seconds", true)!;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    return interaction.reply({
      content: "Enter a whole number of seconds between 1 and 86,400.",
      flags: 64,
    });
  }

  interaction.deferReply({ flags: 64 });
  try {
    const result = await broadcastGameMaintenance(seconds);
    return interaction.editReply({
      embeds: [
        {
          color: 0xf1c40f,
          title: "🛠️ Maintenance warning started",
          fields: [
            {
              name: "Countdown",
              value: `${seconds.toLocaleString()} seconds`,
              inline: true,
            },
            {
              name: "Players notified",
              value: result.recipients.toLocaleString(),
              inline: true,
            },
          ],
        },
      ],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[maintenance] Broadcast failed:", error);
    return interaction.editReply({
      content: `The game server could not start the maintenance warning: ${reason}`,
    });
  }
}
