import type { AutocompleteContext } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { getPlayerProfile, searchPlayers } from "../utils/gameWallet.js";
import {
  addCreditsToPlayer,
  removeCreditsFromPlayer,
  formatCredits,
  CREDIT_EMOJI,
} from "../utils/sponsorPacks.js";
import { interactionDiscordId, isAdministrator } from "../utils/discordInteractions.js";

/**
 * `/admin credits` — grants shop credit equal to a donated dollar amount, or with
 * `mode: remove` takes back bonus credit that was added earlier.
 */
export async function handleAddCredits(interaction: CommandInteraction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({
      content: "Administrator permission is required.",
      flags: 64,
    });
  }

  const playerSelector = interaction.options.getString("player", true)!.trim();
  const dollars = interaction.options.getNumber("dollars", true)!;
  const note = interaction.options.getString("note", false) ?? undefined;
  const removing = interaction.options.getString("mode", false) === "remove";
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || cents <= 0) {
    return interaction.reply({
      content: `Enter a positive dollar amount to ${removing ? "remove" : "grant"}.`,
      flags: 64,
    });
  }

  interaction.deferReply({ flags: 64 });

  try {
    // Wallet selectors must be resolved through their linked profile first so
    // the credit lands on the Discord account that owns the ledger.
    let targetDiscordId: string | null = null;
    if (playerSelector.startsWith("profile:")) {
      targetDiscordId = playerSelector.slice("profile:".length).trim() || null;
    } else {
      const profile = await getPlayerProfile(playerSelector);
      targetDiscordId = profile?.discordUserId ?? null;
    }
    if (!targetDiscordId) {
      return interaction.editReply({
        content:
          "That player has no linked profile. Only players who linked Discord with GitHub (through account linking) can receive credit.",
      });
    }

    if (removing) {
      return interaction.editReply(
        await removeCredits(targetDiscordId, dollars, interactionDiscordId(interaction), note),
      );
    }

    const result = await addCreditsToPlayer({
      discordId: targetDiscordId,
      dollars,
      grantedByDiscordId: interactionDiscordId(interaction),
      note,
    });

    if (result.status === "no-profile") {
      return interaction.editReply({
        content: "That player has no linked profile to grant credit to.",
      });
    }
    if (result.status === "not-linked") {
      return interaction.editReply({
        content:
          "That Discord account has no linked GitHub account, so donation credit cannot be tracked for it.",
      });
    }

    const dollarLabel = `$${(result.cents / 100).toFixed(2)}`;
    return interaction.editReply({
      embeds: [
        {
          color: 0x2ecc71,
          title: `${CREDIT_EMOJI} Credits added`,
          fields: [
            { name: "Player", value: `<@${targetDiscordId}>`, inline: true },
            { name: "Added", value: `${formatCredits(result.cents)} (${dollarLabel})`, inline: true },
            { name: "New bonus balance", value: formatCredits(result.totalBonusCents), inline: true },
          ],
          footer: {
            text: "Stacks on top of their GitHub sponsor donations in the pack shop.",
          },
        },
      ],
    });
  } catch (error) {
    console.error("[add-credits] Credit grant failed:", error);
    return interaction.editReply({
      content: `The credit could not be ${removing ? "removed" : "added"} right now. Please try again later.`,
    });
  }
}

/** The reply for `mode: remove`: only bonus credit can be taken back, and never more than is there. */
async function removeCredits(
  targetDiscordId: string,
  dollars: number,
  removedBy: string,
  note: string | undefined,
): Promise<Record<string, unknown>> {
  const result = await removeCreditsFromPlayer({
    discordId: targetDiscordId,
    dollars,
    removedByDiscordId: removedBy,
    note,
  });

  if (result.status === "no-profile") {
    return { content: "That player has no linked profile to remove credit from." };
  }
  if (result.status === "insufficient") {
    return {
      content:
        result.totalBonusCents > 0
          ? `<@${targetDiscordId}> only has ${formatCredits(result.totalBonusCents)} ($${(result.totalBonusCents / 100).toFixed(2)}) of added credits, so ${formatCredits(result.cents)} cannot be removed. Nothing was changed.`
          : `<@${targetDiscordId}> has no added credits to remove. Credits from a GitHub sponsorship cannot be removed here. Nothing was changed.`,
    };
  }

  const dollarLabel = `$${(result.cents / 100).toFixed(2)}`;
  return {
    embeds: [
      {
        color: 0xe74c3c,
        title: `${CREDIT_EMOJI} Credits removed`,
        fields: [
          { name: "Player", value: `<@${targetDiscordId}>`, inline: true },
          { name: "Removed", value: `${formatCredits(result.cents)} (${dollarLabel})`, inline: true },
          { name: "New bonus balance", value: formatCredits(result.totalBonusCents), inline: true },
        ],
        footer: {
          text: "Credits they already spent on packs stay spent; their balance shows 0 until new credit covers it.",
        },
      },
    ],
  };
}

export async function handleAddCreditsAutocomplete(
  autocomplete: AutocompleteContext,
) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "player") {
    autocomplete.respond([]);
    return;
  }

  try {
    // Only linked profiles can hold credit, so the picker lists exactly the
    // `profile:<discordId>` rows.
    const players = (await searchPlayers(String(focused.value ?? ""))).filter(
      (player) => player.selector.startsWith("profile:"),
    );
    autocomplete.respond(
      players.map((player) => ({
        name: player.label.slice(0, 100),
        value: player.selector,
      })),
    );
  } catch (error) {
    console.error("[add-credits] Autocomplete failed:", error);
    autocomplete.respond([]);
  }
}
