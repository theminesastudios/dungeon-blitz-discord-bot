import {
  CommandBuilder,
  CommandContext,
  IntegrationType,
} from "@minesa-org/mini-interaction";
import type {
  AutocompleteContext,
  CommandInteraction,
} from "@minesa-org/mini-interaction";
import { handleMaintenance } from "./maintenance.js";
import {
  handleAddCredits,
  handleAddCreditsAutocomplete,
} from "./add-credits.js";
import { handleIdols, handleIdolsAutocomplete } from "./idols.js";
import {
  handlePackRewards,
  handlePackRewardsAutocomplete,
} from "./pack-rewards.js";
import {
  handleWidgetStatus,
  handleWidgetStatusAutocomplete,
} from "./widget-status.js";
import { handleSponsorInfo } from "./sponsor-info.js";
import { handleGrant } from "./grant.js";

/**
 * The staff toolbox, grouped under one command so the command list stays short and the
 * tools that act on a player's save or the live server sit together:
 *
 *   /admin maintenance   — start the in-game maintenance countdown
 *   /admin credits        — add shop credit for a donation
 *   /admin idols          — add or subtract Mammoth Idols
 *   /admin rewards        — strip sponsor pack rewards from a save
 *   /admin grant          — give or remove a specific item (interactive panel)
 *   /admin widget         — diagnose a player's Game Stats widget
 *   /admin sponsor        — inspect a GitHub sponsor's visible tier
 */
export const adminCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("admin")
    .setDescription("Staff tools for Dungeon Blitz")
    .setDefaultMemberPermissions(8n)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("maintenance")
        .setDescription("Start the Dungeon Blitz maintenance warning")
        .addNumberOption((option) =>
          option
            .setName("seconds")
            .setDescription("Seconds until maintenance starts")
            .setMinValue(1)
            .setMaxValue(86_400)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("credits")
        .setDescription("Add shop credit equal to a player's donation")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Search GitHub, Discord, character name, or game user ID")
            .setAutocomplete(true)
            .setRequired(true),
        )
        .addNumberOption((option) =>
          option
            .setName("dollars")
            .setDescription("Donated amount in USD to convert into shop credit")
            .setMinValue(0.01)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("note")
            .setDescription("Optional note stored with the credit grant")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("idols")
        .setDescription("Add or subtract a player's Mammoth Idols")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Search by character name or game user ID")
            .setAutocomplete(true)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("operation")
            .setDescription("Whether to add or subtract idols")
            .addChoices(
              { name: "Add", value: "add" },
              { name: "Subtract", value: "sub" },
            )
            .setRequired(true),
        )
        .addNumberOption((option) =>
          option
            .setName("amount")
            .setDescription("Positive whole number of idols")
            .setMinValue(1)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rewards")
        .setDescription("Remove sponsor pack mounts and dyes from a player's save")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Search by GitHub, Discord, character name, or game user ID")
            .setAutocomplete(true)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("character")
            .setDescription("Only this character (leave empty for every character)")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("reset-credit")
            .setDescription("Also clear their pack purchases so packs can be bought again")
            .setRequired(false)
            .addChoices(
              { name: "No", value: "no" },
              { name: "Yes", value: "yes" },
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("grant")
        .setDescription("Give or remove a specific item (gold, idols, mounts, gear, …)"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("widget")
        .setDescription("Check what is blocking a player's Game Stats widget")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription(
              "Inspect this player (leave empty for the application-level checks only)",
            )
            .setAutocomplete(true)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("sponsor")
        .setDescription("Show a GitHub sponsor's sponsorship information")
        .addStringOption((option) =>
          option
            .setName("github_username")
            .setDescription("The sponsor's GitHub username")
            .setRequired(true),
        ),
    ),
  handler: async (interaction: CommandInteraction) => {
    switch (interaction.options.getSubcommand(true)) {
      case "maintenance":
        return handleMaintenance(interaction);
      case "credits":
        return handleAddCredits(interaction);
      case "idols":
        return handleIdols(interaction);
      case "rewards":
        return handlePackRewards(interaction);
      case "grant":
        return handleGrant(interaction);
      case "widget":
        return handleWidgetStatus(interaction);
      case "sponsor":
        return handleSponsorInfo(interaction);
      default:
        return interaction.reply({
          content: "That admin action does not exist.",
          flags: 64,
        });
    }
  },
};

/** Every `/admin` player picker shares one autocomplete entry point. */
export async function handleAdminAutocomplete(
  autocomplete: AutocompleteContext,
) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "player") {
    autocomplete.respond([]);
    return;
  }

  switch (focused.subcommand) {
    case "credits":
      return handleAddCreditsAutocomplete(autocomplete);
    case "idols":
      return handleIdolsAutocomplete(autocomplete);
    case "rewards":
      return handlePackRewardsAutocomplete(autocomplete);
    case "widget":
      return handleWidgetStatusAutocomplete(autocomplete);
    default:
      autocomplete.respond([]);
  }
}
