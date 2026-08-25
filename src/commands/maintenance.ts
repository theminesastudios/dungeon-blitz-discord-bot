import {
  CommandBuilder,
  CommandContext,
  IntegrationType,
} from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { broadcastGameMaintenance } from "../utils/gameMaintenance.js";
import { isAdministrator } from "../utils/discordInteractions.js";

export const maintenanceCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("maintenance")
    .setDescription("Start the Dungeon Blitz maintenance warning")
    .setDefaultMemberPermissions(8n)
    .setDMPermission(false)
    .addNumberOption((option) =>
      option
        .setName("seconds")
        .setDescription("Seconds until maintenance starts")
        .setMinValue(1)
        .setMaxValue(86_400)
        .setRequired(true),
    ),
  handler: async (interaction: CommandInteraction) => {
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
        content: `Maintenance warning started for **${seconds.toLocaleString()} seconds** and announced to **${result.recipients.toLocaleString()}** connected player${result.recipients === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      console.error("[maintenance] Broadcast failed:", error);
      return interaction.editReply({
        content: "The game server could not start the maintenance warning.",
      });
    }
  },
};
