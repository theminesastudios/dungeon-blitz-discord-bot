import type { AutocompleteContext } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { adjustMammothIdols, searchGameWallets } from "../utils/gameWallet.js";
import { isAdministrator } from "../utils/discordInteractions.js";

/** `/admin idols` — atomically adds or subtracts a player's Mammoth Idols. */
export async function handleIdols(interaction: CommandInteraction) {
  if (!isAdministrator(interaction)) {
    return interaction.reply({
      content: "Administrator permission is required.",
      flags: 64,
    });
  }

  const walletId = interaction.options.getString("player", true)!;
  const operation = interaction.options.getString("operation", true);
  const amount = interaction.options.getNumber("amount", true)!;
  if (
    (operation !== "add" && operation !== "sub") ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    return interaction.reply({
      content: "Choose add/sub and enter a positive whole number.",
      flags: 64,
    });
  }

  try {
    console.info("[idols] Applying wallet adjustment", {
      selector: walletId,
      operation,
      amount,
    });
    const result = await adjustMammothIdols(walletId, operation, amount);
    if (!result) {
      return interaction.reply({
        content:
          operation === "sub"
            ? "Player not found or the player does not have enough Mammoth Idols."
            : "Player wallet not found.",
        flags: 64,
      });
    }

    return interaction.reply({
      embeds: [
        {
          color: operation === "add" ? 0x2ecc71 : 0xe74c3c,
          title: `${operation === "add" ? "➕" : "➖"} Mammoth Idols ${
            operation === "add" ? "added" : "removed"
          }`,
          description: `**${result.after.characterName}**`,
          fields: [
            {
              name: "Before",
              value: result.before.mammothIdols.toLocaleString(),
              inline: true,
            },
            {
              name: "Change",
              value: `${operation === "add" ? "+" : "−"}${amount.toLocaleString()}`,
              inline: true,
            },
            {
              name: "After",
              value: result.after.mammothIdols.toLocaleString(),
              inline: true,
            },
          ],
        },
      ],
      flags: 64,
    });
  } catch (error) {
    console.error("[idols] Wallet update failed:", error);
    return interaction.reply({
      content: "The player wallet could not be updated.",
      flags: 64,
    });
  }
}

export async function handleIdolsAutocomplete(
  autocomplete: AutocompleteContext,
) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "player") {
    autocomplete.respond([]);
    return;
  }

  try {
    const wallets = await searchGameWallets(String(focused.value ?? ""));
    autocomplete.respond(
      wallets.map((wallet) => ({
        name:
          `${wallet.characterName} [${wallet.gameUserId}] • Idols ${wallet.mammothIdols} • Gold ${wallet.gold} • Keys ${wallet.dragonKeys}`.slice(
            0,
            100,
          ),
        value: wallet.selector,
      })),
    );
  } catch (error) {
    console.error("[idols] Autocomplete failed:", error);
    autocomplete.respond([]);
  }
}
