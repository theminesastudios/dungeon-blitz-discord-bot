import { CommandBuilder } from "@minesa-org/mini-interaction";
import type { AutocompleteContext } from "@minesa-org/mini-interaction";
import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { adjustMammothIdols, searchGameWallets } from "../utils/gameWallet.js";

export const idolsCommand = {
  data: new CommandBuilder()
    .setName("idols")
    .setDescription("Manually add or subtract a player's Mammoth Idols")
    .setDMPermission(false)
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
  handler: async (interaction: CommandInteraction) => {
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
        content: `**${result.after.characterName}**: Mammoth Idols ${result.before.mammothIdols.toLocaleString()} → **${result.after.mammothIdols.toLocaleString()}** (${operation === "add" ? "+" : "−"}${amount.toLocaleString()})`,
        flags: 64,
      });
    } catch (error) {
      console.error("[idols] Wallet update failed:", error);
      return interaction.reply({
        content: "The player wallet could not be updated.",
        flags: 64,
      });
    }
  },
};

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
