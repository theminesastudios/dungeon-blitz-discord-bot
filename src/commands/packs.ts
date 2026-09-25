import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	CommandContext,
	ContainerBuilder,
	GalleryBuilder,
	GalleryItemBuilder,
	IntegrationType,
	InteractionFlags,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
} from "@minesa-org/mini-interaction";
import { MessageFlags } from "discord-api-types/v10";
import type { MessageActionRowComponent } from "@minesa-org/mini-interaction";
import type {
	CommandInteraction,
	MessageComponentInteraction,
} from "@minesa-org/mini-interaction";
import {
	SPONSOR_PACKS,
	formatUsd,
	purchaseSponsorPack,
	findSponsorPack,
	type PackPurchaseResult,
	type PackRewardDeliveryResult,
	type SponsorCredit,
	type SponsorPack,
} from "../utils/sponsorPacks.js";
import {
	formatRewardLine,
	listGameSaveCharacters,
	type GameCharacterOption,
} from "../utils/gameRewards.js";
import { ensureGameItemNames, primeGameItemNames } from "../utils/gameContent.js";
import { getMemberRoleIds, interactionDiscordId } from "../utils/discordInteractions.js";
import {
	publishGameLog,
	type GameLogField,
	type GameLogPayload,
} from "../utils/gameLogChannel.js";
import { waitUntil } from "@vercel/functions";

const BUY_BUTTON_PREFIX = "packs:buy:";
const PACK_SELECT_ID = "packs:view";
const CHARACTER_SELECT_PREFIX = "packs:char:";

// Components V2 messages require the IsComponentsV2 flag; shop views are ephemeral.
const CONTAINER_FLAGS = MessageFlags.IsComponentsV2;
const CONTAINER_EPHEMERAL_FLAGS =
	(MessageFlags.IsComponentsV2 | InteractionFlags.Ephemeral) as MessageFlags;

function packPriceLabel(pack: SponsorPack) {
	return pack.priceCents === 0 ? "FREE" : formatUsd(pack.priceCents);
}

function packButtonLabel(pack: SponsorPack) {
	return pack.priceCents === 0 ? "Claim" : "Buy";
}

function buildPackSelectRow(defaultId?: string) {
	const select = new StringSelectMenuBuilder()
		.setCustomId(PACK_SELECT_ID)
		.setPlaceholder("Select a pack to view…")
		.setMinValues(1)
		.setMaxValues(1)
		.setOptions(
			SPONSOR_PACKS.map((pack) =>
				new StringSelectMenuOptionBuilder()
					.setLabel(`${pack.name} — ${packPriceLabel(pack)}`)
					.setValue(pack.id)
					.setEmoji(pack.emoji)
					.setDescription(
						pack.requiredRoleId
							? "Sponsor role required"
							: undefined,
					)
					.setDefault(pack.id === defaultId),
			),
		);

	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function buildCharacterSelectRow(
	pack: SponsorPack,
	characters: GameCharacterOption[],
	selectedCharacter?: string,
): ActionRowBuilder<MessageActionRowComponent> | null {
	if (characters.length === 0) return null;

	const select = new StringSelectMenuBuilder()
		.setCustomId(`${CHARACTER_SELECT_PREFIX}${pack.id}`)
		.setPlaceholder("Deliver to character…")
		.setMinValues(1)
		.setMaxValues(1)
		.setOptions(
			characters.map((character) =>
				new StringSelectMenuOptionBuilder()
					.setLabel(character.name.slice(0, 100))
					.setValue(character.name)
					.setDescription(`Level ${character.level} ${character.class}`)
					.setDefault(
						selectedCharacter
							? character.name === selectedCharacter
							: character === characters[0],
					),
			),
		);

	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function buildPackContainer(
	pack: SponsorPack,
	credit?: SponsorCredit | null,
	characters: GameCharacterOption[] = [],
	selectedCharacter?: string,
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(pack.color);

	// Pack image gallery
	const gallery = new GalleryBuilder().addItem(
		new GalleryItemBuilder().setMedia({ url: pack.imageUrl }).setDescription(pack.name),
	);
	container.addComponent(gallery);

	// Header + price + role info
	const headerParts: string[] = [];
	headerParts.push(`### ${pack.emoji} ${pack.name}`);
	headerParts.push(`**Price:** ${packPriceLabel(pack)}`);

	if (pack.requiredRoleId) {
		headerParts.push(`-# 🎟️ Free claim for <@&${pack.requiredRoleId}> role holders only`);
	}

	if (credit) {
		headerParts.push(
			`-# 💰 Your balance: ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)}`,
		);
	}

	container.addComponent(
		new TextDisplayBuilder().setContent(headerParts.join("\n")),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	// Buy/Claim button in a section
	container.addSection(
		new SectionBuilder()
			.addComponent(
				new TextDisplayBuilder().setContent(
					pack.priceCents === 0
						? "-# Tap **Claim** to get this free pack"
						: `-# Tap **Buy** to purchase with ${formatUsd(pack.priceCents)}`,
				),
			)
			.setAccessory(
				new ButtonBuilder()
					.setLabel(packButtonLabel(pack))
					.setStyle(ButtonStyle.Primary)
					.setCustomId(
						selectedCharacter
							? `${BUY_BUTTON_PREFIX}${pack.id}:${selectedCharacter}`
							: `${BUY_BUTTON_PREFIX}${pack.id}`,
					),
			),
	);

	const characterRow = buildCharacterSelectRow(pack, characters, selectedCharacter);
	if (characterRow) {
		container.addComponent(
			new TextDisplayBuilder().setContent(
				"-# 🎒 Pick which character receives the pack rewards (defaults to your most recent character).",
			),
		);
		container.addComponent(characterRow);
	}

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	// Select menu row at the bottom
	container.addComponent(buildPackSelectRow(pack.id));

	return container;
}

function buildShopContainer(): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(0xf1c40f);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			"## 🛍️ Sponsor Pack Shop\nBrowse and purchase sponsor packs below.\n-# Select a pack to see details and purchase.",
		),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	container.addComponent(buildPackSelectRow());

	return container;
}

function buildDeliverySummary(deliveries: PackRewardDeliveryResult[]): string[] {
	if (deliveries.length === 0) return ["-# No rewards to deliver for this pack."];

	const lines: string[] = ["**Delivered rewards**"];
	for (const outcome of deliveries) {
		const reward = formatRewardLine(outcome.delivery.reward);
		lines.push(
			outcome.status === "delivered"
				? `- ✅ ${reward} → **${outcome.delivery.characterName}**`
				: `- ⚠️ ${reward} — ${outcome.error ?? "delivery failed"}`,
		);
	}
	return lines;
}

function buildPurchasedContainer(
	pack: SponsorPack,
	credit: SponsorCredit,
	deliveries: PackRewardDeliveryResult[],
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(pack.color);

	// Pack image
	const gallery = new GalleryBuilder().addItem(
		new GalleryItemBuilder().setMedia({ url: pack.imageUrl }).setDescription(pack.name),
	);
	container.addComponent(gallery);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			`### ${pack.emoji} ${pack.name} purchased!${pack.priceCents === 0 ? " (free claim)" : ""}`,
		),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	container.addComponent(
		new TextDisplayBuilder().setContent(
			[
				`**Price:** ${packPriceLabel(pack)}`,
				`**Remaining balance:** ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)}`,
				`**Sponsored / Used:** ${credit.sponsoredCents === null ? "Unknown" : formatUsd(credit.sponsoredCents)}${credit.bonusCents > 0 ? ` + ${formatUsd(credit.bonusCents)} bonus` : ""} / ${formatUsd(credit.usedCents)}`,
			].join("\n"),
		),
	);

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	container.addComponent(
		new TextDisplayBuilder().setContent(buildDeliverySummary(deliveries).join("\n")),
	);

	// Select menu to keep browsing
	container.addComponent(buildPackSelectRow());

	return container;
}

/**
 * Purchase outcomes are reported to the operator log channel as well as to the
 * buyer. The buyer's reply is ephemeral and depends on Discord accepting a
 * components-v2 edit, so the log is the record that still exists when a
 * delivery or a reply fails — it is also what makes a stuck interaction
 * diagnosable without deploying anything.
 *
 * `publishGameLog` never throws and `waitUntil` keeps the delivery alive past
 * the response, so logging cannot slow a purchase down or break it.
 */
function reportPurchase(payload: GameLogPayload) {
	const promise = publishGameLog(payload);
	try {
		waitUntil(promise);
	} catch {
		// Vercel-only helper; the promise keeps running while the function lives.
		void promise.catch(() => {});
	}
}

/** Pretty labels for the outcome states, so the log never shows a raw `missing-role`. */
const PURCHASE_STATUS: Record<string, { emoji: string; label: string }> = {
	ok: { emoji: "✅", label: "Delivered" },
	insufficient: { emoji: "💸", label: "Not enough credit" },
	"missing-role": { emoji: "🎟️", label: "Sponsor role required" },
	"already-claimed": { emoji: "📦", label: "Already claimed" },
	"no-character": { emoji: "❌", label: "Delivery failed — refunded" },
	"credit-unknown": { emoji: "⚠️", label: "Credit could not be verified" },
	conflict: { emoji: "🔁", label: "Balance changed mid-purchase" },
	"not-sponsor": { emoji: "🙅", label: "Not a sponsor" },
	"no-profile": { emoji: "🔗", label: "Not linked" },
};

/**
 * The operator-log card for one purchase: an embed with real fields rather than one long
 * paragraph, so a row is scannable and the values an operator needs to compare against the
 * save (the document id and what each reward field reads afterwards) get their own lines.
 */
function purchaseLogCard(
	result: PackPurchaseResult,
	discordId: string,
	packId: string,
): GameLogPayload {
	const status = PURCHASE_STATUS[result.status] ?? {
		emoji: "ℹ️",
		label: result.status,
	};
	const fields: GameLogField[] = [
		{ name: "Player", value: `<@${discordId}>`, inline: true },
	];
	if ("pack" in result) {
		fields.push({
			name: "Pack",
			value: `${result.pack.emoji} ${result.pack.name}`,
			inline: true,
		});
		fields.push({
			name: "Price",
			value: formatUsd(result.pack.priceCents),
			inline: true,
		});
	} else {
		fields.push({ name: "Pack", value: packId, inline: true });
	}

	let message = "";

	if (result.status === "ok") {
		const delivered = result.deliveries.filter(
			(outcome) => outcome.status === "delivered",
		).length;
		message = `Delivered to **${result.deliveries[0]?.delivery.characterName ?? "character"}**.`;
		fields.push({
			name: "Rewards",
			value: `${delivered}/${result.deliveries.length} delivered`,
			inline: true,
		});
		fields.push({
			name: "Remaining",
			value:
				result.credit.balanceCents === null
					? "unknown"
					: formatUsd(result.credit.balanceCents),
			inline: true,
		});
		if (result.credit.bonusCents > 0) {
			fields.push({
				name: "Bonus credit",
				value: formatUsd(result.credit.bonusCents),
				inline: true,
			});
		}
		// What the save actually reads after the writes, plus which document was written. This is
		// the line that answers "the credit went but the rewards are not in the database": either
		// the values are named here and something else is reading a different save, or the
		// delivery is reported as failed above.
		const values = result.deliveries
			.filter((outcome) => outcome.status === "delivered")
			.slice(0, 6)
			.map(
				(outcome) =>
					`- ${formatRewardLine(outcome.delivery.reward)} → ${outcome.verified ?? "not verified"}`,
			);
		if (values.length > 0) {
			fields.push({ name: "After write", value: values.join("\n") });
		}
		const saveIds = [
			...new Set(
				result.deliveries
					.map((outcome) => outcome.saveId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		if (saveIds.length > 0) fields.push({ name: "Save", value: saveIds.join(", ") });
	} else if (result.status === "insufficient") {
		fields.push({
			name: "Balance",
			value: formatUsd(result.balanceCents),
			inline: true,
		});
	} else if (result.status === "no-character") {
		message = result.reason;
		const errors = result.deliveries
			.map((outcome) => outcome.error)
			.filter((error): error is string => Boolean(error));
		if (errors.length > 0) {
			fields.push({ name: "Delivery errors", value: errors.slice(0, 3).join("\n") });
		}
		// A refunded purchase still has to say where the write went, or the operator has nothing
		// to compare against the save they are looking at.
		const saveIds = [
			...new Set(
				result.deliveries
					.map((outcome) => outcome.saveId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		if (saveIds.length > 0) fields.push({ name: "Save", value: saveIds.join(", ") });
	}

	return {
		event: `pack-purchase-${result.status}`,
		title: `${status.emoji} Pack purchase — ${status.label}`,
		...(message ? { message } : {}),
		fields,
	};
}

function buildPurchaseSummary(
	pack: SponsorPack,
	credit: SponsorCredit,
	deliveries: PackRewardDeliveryResult[],
): string {
	return [
		`### ${pack.emoji} ${pack.name} purchased!${pack.priceCents === 0 ? " (free claim)" : ""}`,
		`**Price:** ${packPriceLabel(pack)}`,
		`**Remaining balance:** ${credit.balanceCents === null ? "Unknown" : formatUsd(credit.balanceCents)}`,
		...buildDeliverySummary(deliveries),
	].join("\n");
}

/**
 * Sends the rich components-v2 confirmation, retrying as plain text when Discord
 * rejects the payload. The purchase has already been recorded and delivered at
 * this point, so the reply must always replace the deferred "thinking…" state
 * rather than leaving the player with a stuck interaction.
 */
async function editWithFallback(
	editReply: (data: Record<string, unknown>) => Promise<unknown>,
	rich: Record<string, unknown>,
	fallbackContent: string,
) {
	try {
		return await editReply(rich);
	} catch (error) {
		console.error(
			"[packs] Component reply rejected, falling back to text:",
			error,
		);
		return editReply({
			content: fallbackContent,
			flags: InteractionFlags.Ephemeral,
		});
	}
}

async function respondWithPurchase(
	discordId: string,
	packId: string,
	memberRoleIds: string[],
	characterName: string | undefined,
	editReply: (data: Record<string, unknown>) => Promise<unknown>,
) {
	const result = await purchaseSponsorPack(discordId, packId, memberRoleIds, characterName);
	// Loaded after the purchase, never before: the reward lines should name what was
	// delivered ("Skybone Wyrm"), but a slow game server must not delay the write.
	await ensureGameItemNames();
	// Every outcome that means something happened to a save or a balance is
	// logged. A random member clicking a sponsor-only pack is not an event an
	// operator needs to read.
	if (result.status !== "no-profile" && result.status !== "not-sponsor") {
		reportPurchase(purchaseLogCard(result, discordId, packId));
	}

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
		case "no-character":
			// The purchase (or free claim) was automatically reverted — credit is
			// back and the Sponsor Pack claim is released, so nothing was lost.
			return editReply({
				content: [
					`❌ The **${result.pack.name}** could not be delivered — ${result.reason}`,
					result.pack.priceCents === 0
						? "Your claim was released; try again once you have an unlocked character."
						: "You were not charged; your balance is unchanged.",
				].join("\n"),
				flags: InteractionFlags.Ephemeral,
			});
	}

	const { pack, credit, deliveries } = result;
	return editWithFallback(
		editReply,
		{
			components: [buildPurchasedContainer(pack, credit, deliveries)],
			flags: CONTAINER_EPHEMERAL_FLAGS,
		},
		buildPurchaseSummary(pack, credit, deliveries),
	);
}

async function handleBuy(
	interaction: CommandInteraction | MessageComponentInteraction,
	packId: string,
	characterName?: string,
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
			characterName,
			(data) => interaction.editReply(data as never),
		);
	} catch (error) {
		console.error("[packs] Purchase failed:", error);
		// A thrown purchase is the one outcome the player only sees as a generic
		// message, so the operator log carries the real error.
		reportPurchase({
			event: "pack-purchase-error",
			title: "🛑 Pack purchase failed",
			fields: [
				{ name: "Player", value: `<@${discordId}>`, inline: true },
				{ name: "Pack", value: packId, inline: true },
				{
					name: "Error",
					value: `\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
				},
			],
		});
		return interaction.editReply({
			content:
				"The purchase could not be processed right now. Please try again later.",
		});
	}
}

async function handlePackView(
	interaction: MessageComponentInteraction,
) {
	// Reward lines read better with the game's own names, and the shop is opened a few
	// clicks before a purchase happens — so start the load now instead of waiting for it
	// inside the purchase.
	primeGameItemNames();

	const packId = interaction.getStringValues()[0];
	const pack = packId ? findSponsorPack(packId) : null;

	if (!pack) {
		return interaction.reply({
			content: "Invalid pack selection.",
			flags: InteractionFlags.Ephemeral,
		});
	}

	const discordId = interactionDiscordId(interaction);
	const characters = discordId ? await listGameSaveCharacters(discordId).catch(() => []) : [];

	return interaction.update({
		components: [buildPackContainer(pack, null, characters)],
		flags: CONTAINER_FLAGS,
	});
}

async function handleShop(
	interaction: CommandInteraction | MessageComponentInteraction,
) {
	primeGameItemNames();
	return interaction.reply({
		components: [buildShopContainer()],
		flags: CONTAINER_EPHEMERAL_FLAGS,
	});
}

export const packsCommand = {
	data: new CommandBuilder()
		.setContexts([CommandContext.Guild])
		.setIntegrationTypes([IntegrationType.GuildInstall])
		.setName("packs")
		.setDescription("Browse and buy sponsor packs")
		.setDMPermission(false),
	handler: (interaction: CommandInteraction) => handleShop(interaction),
};

export const packsBuyComponent = {
	// Trailing "*" registers this as a prefix handler: buy buttons carry
	// "packs:buy:<packId>" or "packs:buy:<packId>:<characterName>".
	customId: `${BUY_BUTTON_PREFIX}*`,
	handler: (interaction: MessageComponentInteraction) => {
		if (!interaction.data.custom_id.startsWith(BUY_BUTTON_PREFIX)) {
			return interaction.reply({
				content: "That pack button is no longer valid.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		// Custom ID shape: "packs:buy:<packId>" or "packs:buy:<packId>:<characterName>".
		const payload = interaction.data.custom_id.slice(BUY_BUTTON_PREFIX.length);
		const separatorIndex = payload.indexOf(":");
		const packId = separatorIndex < 0 ? payload : payload.slice(0, separatorIndex);
		const characterName = separatorIndex < 0 ? undefined : payload.slice(separatorIndex + 1);
		return handleBuy(interaction, packId, characterName);
	},
};

export const packsSelectComponent = {
	customId: PACK_SELECT_ID,
	handler: (interaction: MessageComponentInteraction) =>
		handlePackView(interaction),
};

export const packsCharacterSelectComponent = {
	customId: `${CHARACTER_SELECT_PREFIX}*`,
	handler: async (interaction: MessageComponentInteraction) => {
		const packId = interaction.data.custom_id.slice(CHARACTER_SELECT_PREFIX.length);
		const pack = findSponsorPack(packId);
		if (!pack) {
			return interaction.reply({
				content: "Invalid pack selection.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		const selected = interaction.getStringValues()[0];
		if (!selected) {
			return interaction.reply({
				content: "Select a character first.",
				flags: InteractionFlags.Ephemeral,
			});
		}

		const discordId = interactionDiscordId(interaction);
		const characters = discordId ? await listGameSaveCharacters(discordId).catch(() => []) : [];

		return interaction.update({
			components: [buildPackContainer(pack, null, characters, selected)],
			flags: CONTAINER_FLAGS,
		});
	},
};
