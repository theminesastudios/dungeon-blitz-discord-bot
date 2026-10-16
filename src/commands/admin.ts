import {
  CommandBuilder,
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
import { handleLobbyChat } from "./lobby-chat.js";
import { handleGrant } from "./grant.js";
import { handleSponsorRole } from "./sponsor-role.js";
import { handleProfile, handleProfileAutocomplete } from "./profile.js";
import { handleBan, handleUnban } from "./moderation.js";
import { BAN_DURATION_CHOICES } from "../utils/gameModeration.js";

/**
 * The staff toolbox, grouped under one command so the command list stays short and the
 * tools that act on a player's save or the live server sit together:
 *
 *   /admin profile       — a player's playtime, characters, XP, balances, abilities and talents
 *   /admin ban / unban   — take a player out of the game, or let them back in
 *   /admin maintenance   — start the in-game maintenance countdown
 *   /admin lobby-chat    — choose the Discord channel lobby chat is linked to
 *   /admin credits        — add credits for a donation, or remove credits added by mistake
 *   /admin idols          — add or subtract Mammoth Idols
 *   /admin rewards        — strip sponsor pack rewards from a save
 *   /admin grant          — give or remove a specific item (interactive panel)
 *   /admin widget         — diagnose a player's Game Stats widget
 *   /admin sponsor        — inspect a GitHub sponsor's visible tier
 *   /admin sponsor-role   — mark a player a sponsor, unlocking their linked Sponsor role
 */
export const adminCommand = {
  data: new CommandBuilder()
    .setName("admin")
    .setDescription("Staff tools for Dungeon Blitz")
    .setDefaultMemberPermissions(8n)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("profile")
        .setDescription("Show a player's playtime, characters, XP, balances, abilities and talents")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Search by character, Discord username, GitHub, or game user ID")
            .setAutocomplete(true)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ban")
        .setDescription("Ban a player from the game for a limited time")
        .addUserOption((option) =>
          option
            .setName("target")
            .setDescription("The Discord member to ban")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("How long the ban lasts")
            .addChoices(...BAN_DURATION_CHOICES)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Shown to the player and stored in the operator log")
            .setMaxLength(200)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("unban")
        .setDescription("Lift a player's game ban")
        .addUserOption((option) =>
          option
            .setName("target")
            .setDescription("The Discord member to unban")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Optional note stored in the operator log")
            .setMaxLength(200)
            .setRequired(false),
        ),
    )
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
        .setName("lobby-chat")
        .setDescription("Choose the Discord channel the game's lobby chat is linked to")
        .addStringOption((option) =>
          option
            .setName("channel")
            .setDescription(
              "Channel to link (#channel, <#id> or an id), `none` to unlink, or empty to show the current one",
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("credits")
        .setDescription("Add or remove a player's donation credits (100 credits per $1)")
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
            .setDescription("Amount in USD to add or remove (100 credits per $1)")
            .setMinValue(0.01)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("note")
            .setDescription("Optional note stored with the credit grant")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Add (default) or remove credits added earlier")
            .addChoices(
              { name: "Add", value: "add" },
              { name: "Remove", value: "remove" },
            )
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
        .setDescription("Undo test purchases: removes every buyable mount and legendary dye from a save")
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
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("sponsor-role")
        .setDescription(
          "Mark a member a sponsor, unlocking their linked Sponsor role",
        )
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The member to mark as a sponsor")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("github_username")
            .setDescription(
              "Or resolve the member from their linked GitHub username instead",
            )
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Sponsor (default) or unsponsor")
            .addChoices(
              { name: "Grant", value: "grant" },
              { name: "Remove", value: "remove" },
            )
            .setRequired(false),
        ),
    ),
  handler: async (interaction: CommandInteraction) => {
    switch (interaction.options.getSubcommand(true)) {
      case "profile":
        return handleProfile(interaction);
      case "ban":
        return handleBan(interaction);
      case "unban":
        return handleUnban(interaction);
      case "maintenance":
        return handleMaintenance(interaction);
      case "lobby-chat":
        return handleLobbyChat(interaction);
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
      case "sponsor-role":
        return handleSponsorRole(interaction);
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
    case "profile":
      return handleProfileAutocomplete(autocomplete);
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
