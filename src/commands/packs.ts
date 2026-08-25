import {
  ButtonBuilder,
  ButtonStyle,
  CommandBuilder,
  CommandContext,
  ContainerBuilder,
  IntegrationType,
  InteractionFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "@minesa-org/mini-interaction";
import { MessageFlags } from "discord-api-types/v10";
import type {
  CommandInteraction,
  MessageComponentInteraction,
} from "@minesa-org/mini-interaction";
import {
  SPONSOR_PACKS,
  formatUsd,
  getSponsorCredit,
  purchaseSponsorPack,
  type SponsorCredit,
  type SponsorPack,
} from "../utils/sponsorPacks.js";
import { getMemberRoleIds, interactionDiscordId } from "../utils/discordInteractions.js";

const BUY_BUTTON_PREFIX = "packs:buy:";
const SHOP_BUTTON_ID = "packs:shop";

// Components V2 messages require the IsComponentsV2 flag; shop views are ephemeral.
const CONTAINER_FLAGS = MessageFlags.IsComponentsV2;
const CONTAINER_EPHEMERAL_FLAGS = (MessageFlags.IsComponentsV2 |
  InteractionFlags.Ephemeral) as MessageFlags;

function packPriceLabel(pack: SponsorPack) {
  return pack.priceCents === 0 ? "FREE" : formatUsd(pack.priceCents);
}

function packRequirementLabel(pack: SponsorPack) {
  return pack.requiredRoleId ? ` • <@&${pack.requiredRoleId}> only` : "";
}

function packItemsText(pack: SponsorPack) {
  return pack.items.map((item) => `- ${item}`).join("\n");
}

function buildShopContainer(credit: SponsorCredit): ContainerBuilder {
  const balanceLine = credit.isSponsor
    ? `**Your balance:** ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)} (sponsored ${credit.sponsoredCents === null ? "unknown" : formatUsd(credit.sponsoredCents)} • used ${formatUsd(credit.usedCents)})`
    : "You are not a GitHub sponsor yet — sponsor The Minesa Studios to earn credit to spend here.";

  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  container.addComponent(
    new TextDisplayBuilder().setContent(
      `## 🛍️ Sponsor Pack Shop\n${balanceLine}\n-# Every pack costs donation credit: sponsor more to afford bigger packs.`,
    ),
  );
  container.addComponent(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  for (const pack of SPONSOR_PACKS) {
    container.addSection(
      new SectionBuilder()
        .addComponent(
          new TextDisplayBuilder().setContent(
            `**${pack.emoji} ${pack.name} — ${packPriceLabel(pack)}**${packRequirementLabel(pack)}\n${packItemsText(pack)}`,
          ),
        )
        .setAccessory(
          new ButtonBuilder()
            .setLabel(pack.priceCents === 0 ? "Claim" : "Buy")
            .setStyle(ButtonStyle.Primary)
            .setCustomId(`${BUY_BUTTON_PREFIX}${pack.id}`),
        ),
    );
  }

  container.addComponent(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
  container.addComponent(
    new TextDisplayBuilder().setContent(
      "-# Tap **Buy** to spend your donation credit • `/profile` shows your balance and what you have used.",
    ),
  );
  return container;
}

function buildPurchasedContainer(
  pack: SponsorPack,
  credit: SponsorCredit,
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(pack.color);
  container.addComponent(
    new TextDisplayBuilder().setContent(
      `## ${pack.emoji} ${pack.name} purchased!${pack.priceCents === 0 ? " (free claim)" : ""}`,
    ),
  );
  container.addComponent(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
  container.addComponent(
    new TextDisplayBuilder().setContent(packItemsText(pack)),
  );
  container.addComponent(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
  container.addComponent(
    new TextDisplayBuilder().setContent(
      [
        `**Price:** ${packPriceLabel(pack)}`,
        `**Remaining balance:** ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)}`,
        `**Sponsored / Used:** ${credit.sponsoredCents === null ? "Unknown" : formatUsd(credit.sponsoredCents)} / ${formatUsd(credit.usedCents)}`,
      ].join("\n"),
    ),
  );
  container.addComponent(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
  container.addComponent(
    new TextDisplayBuilder().setContent(
      "-# Pack contents are delivered to your game account by the team.",
    ),
  );
  container.addSection(
    new SectionBuilder()
      .addComponent(
        new TextDisplayBuilder().setContent(
          "-# Back to browsing? Open the shop again below.",
        ),
      )
      .setAccessory(
        new ButtonBuilder()
          .setLabel("Back to shop")
          .setStyle(ButtonStyle.Secondary)
          .setCustomId(SHOP_BUTTON_ID),
      ),
  );
  return container;
}

async function respondWithPurchase(
  discordId: string,
  packId: string,
  memberRoleIds: string[],
  editReply: (data: Record<string, unknown>) => Promise<unknown>,
) {
  const result = await purchaseSponsorPack(discordId, packId, memberRoleIds);
  switch (result.status) {
    case "no-profile":
      return editReply({
        content:
          "Your Discord account has no linked GitHub account, so donation credit cannot be checked. Link GitHub through the account linking flow first.",
        flags: InteractionFlags.Ephemeral,
      });
    case "missing-role":
      return editReply({
        content: `The **${result.pack.name}** is a free claim for sponsors only — you need the <@&${result.pack.requiredRoleId}> role to claim it.`,
        flags: InteractionFlags.Ephemeral,
      });
    case "already-claimed":
      return editReply({
        content: `You already claimed the **${result.pack.name}**. Each player can claim it once.`,
        flags: InteractionFlags.Ephemeral,
      });
    case "not-sponsor":
      return editReply({
        content:
          "Only GitHub sponsors have donation credit to spend. Sponsor The Minesa Studios on GitHub Sponsors first!",
        flags: InteractionFlags.Ephemeral,
      });
    case "credit-unknown":
      return editReply({
        content:
          "Your donation total could not be verified with GitHub right now. Please try again later.",
        flags: InteractionFlags.Ephemeral,
      });
    case "insufficient":
      return editReply({
        content: `You need ${formatUsd(result.pack.priceCents)} of donation credit for the **${result.pack.name}**, but your remaining balance is ${formatUsd(result.balanceCents)}.`,
        flags: InteractionFlags.Ephemeral,
      });
    case "conflict":
      return editReply({
        content:
          "Your balance changed while processing the purchase. Please try again.",
        flags: InteractionFlags.Ephemeral,
      });
  }

  const { pack, credit } = result;
  return editReply({
    components: [buildPurchasedContainer(pack, credit)],
    flags: CONTAINER_EPHEMERAL_FLAGS,
  });
}

async function handleBuy(
  interaction: CommandInteraction | MessageComponentInteraction,
  packId: string,
) {
  const discordId = interactionDiscordId(interaction);
  if (!discordId) {
    return interaction.reply({
      content: "Your Discord account could not be verified.",
      flags: InteractionFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
  try {
    return await respondWithPurchase(
      discordId,
      packId,
      getMemberRoleIds(interaction),
      (data) => interaction.editReply(data as never),
    );
  } catch (error) {
    console.error("[packs] Purchase failed:", error);
    return interaction.editReply({
      content:
        "The purchase could not be processed right now. Please try again later.",
    });
  }
}

async function handleShop(
  interaction: CommandInteraction | MessageComponentInteraction,
) {
  const discordId = interactionDiscordId(interaction);
  if (!discordId) {
    return interaction.reply({
      content: "Your Discord account could not be verified.",
      flags: InteractionFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
  try {
    const credit = await getSponsorCredit(discordId);
    if (!credit) {
      return interaction.editReply({
        content:
          "Your Discord account has no linked GitHub account, so donation credit cannot be checked. Link GitHub through the account linking flow first.",
      });
    }
    return interaction.editReply({
      components: [buildShopContainer(credit)],
      flags: CONTAINER_FLAGS,
    });
  } catch (error) {
    console.error("[packs] Shop failed:", error);
    return interaction.editReply({
      content:
        "The pack shop could not be loaded right now. Please try again later.",
    });
  }
}

export const packsCommand = {
  data: new CommandBuilder()
    .setContexts([CommandContext.Guild])
    .setIntegrationTypes([IntegrationType.GuildInstall])
    .setName("packs")
    .setDescription("Browse and buy sponsor packs with your donation credit")
    .setDMPermission(false),
  handler: (interaction: CommandInteraction) => handleShop(interaction),
};

export const packsBuyComponent = {
  customId: BUY_BUTTON_PREFIX,
  handler: (interaction: MessageComponentInteraction) => {
    if (!interaction.data.custom_id.startsWith(BUY_BUTTON_PREFIX)) {
      return interaction.reply({
        content: "That pack button is no longer valid.",
        flags: InteractionFlags.Ephemeral,
      });
    }
    return handleBuy(
      interaction,
      interaction.data.custom_id.slice(BUY_BUTTON_PREFIX.length),
    );
  },
};

export const packsShopComponent = {
  customId: SHOP_BUTTON_ID,
  handler: (interaction: MessageComponentInteraction) => handleShop(interaction),
};
