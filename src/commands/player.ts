import {
  CommandBuilder,
  CommandContext,
  ContainerBuilder,
  IntegrationType,
} from "@minesa-org/mini-interaction";
import type { AutocompleteContext, CommandInteraction } from "@minesa-org/mini-interaction";
import {
  buildPortraitUrl,
  findLiveCharacter,
  formatCharacterLabel,
  searchGameWallets,
  type GameWalletSummary,
} from "../utils/gameWallet.js";
import { currentQuest, formatQuest } from "../utils/characterDisplay.js";
import {
  COLORS,
  divider,
  errorNotice,
  formatNumber,
  notice,
  section,
  text,
  thumbnail,
  v2,
} from "../ui/containers.js";
import { classEmoji, emoji } from "../ui/emojis.js";

/**
 * `/player <name>` is the public card anyone can pull up: portrait, level, gold and the quest
 * the character is on. Nothing else — balances, account details and the owner's other
 * characters stay private to `/account view`.
 */
export function buildPlayerCard(character: GameWalletSummary): ContainerBuilder {
  const heading = `## ${classEmoji(character.characterClass)} ${character.characterName}\n-# ${emoji("ui_level")} Level ${character.characterLevel}`;
  const portrait = buildPortraitUrl(character);
  return new ContainerBuilder()
    .setAccentColor(COLORS.brand)
    .addComponent(portrait ? section(heading, thumbnail(portrait, character.characterName)) : text(heading))
    .addComponent(divider())
    .addComponent(text(`${emoji("cur_gold")} **${formatNumber(character.gold)}** gold`))
    .addComponent(text(`${emoji("ui_quest")} **Current quest**\n${formatQuest(currentQuest(character.missions))}`));
}

export const playerCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("player")
    .setDescription("Show a player's public profile")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Character name")
        .setAutocomplete(true)
        .setMaxLength(32)
        .setRequired(true),
    ),
  handler: async (interaction: CommandInteraction) => {
    const name = (interaction.options.getString("name", true) ?? "").trim();
    interaction.deferReply();
    try {
      const character = await findLiveCharacter(name);
      if (!character) {
        return interaction.editReply(
          v2(notice(COLORS.muted, "Player not found", `No character named **${name}** is playing Dungeon Blitz.`), {
            ephemeral: false,
          }),
        );
      }
      return interaction.editReply(v2(buildPlayerCard(character), { ephemeral: false }));
    } catch (error) {
      console.error("[player] Lookup failed:", error);
      return interaction.editReply(errorNotice("The player profile could not be loaded right now."));
    }
  },
};

export async function handlePlayerAutocomplete(autocomplete: AutocompleteContext) {
  const focused = autocomplete.getFocusedOption();
  if (!focused || focused.name !== "name") {
    autocomplete.respond([]);
    return;
  }
  try {
    const characters = await searchGameWallets(String(focused.value ?? ""));
    autocomplete.respond(
      characters.map((character) => ({
        name: formatCharacterLabel(character),
        value: character.characterName,
      })),
    );
  } catch (error) {
    console.error("[player] Autocomplete failed:", error);
    autocomplete.respond([]);
  }
}
