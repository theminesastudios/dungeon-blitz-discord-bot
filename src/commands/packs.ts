import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	ContainerBuilder,
	GalleryBuilder,
	GalleryItemBuilder,
	InteractionFlags,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} from "@minesa-org/mini-interaction";
import { MessageFlags } from "discord-api-types/v10";
import type { MessageActionRowComponent } from "@minesa-org/mini-interaction";
import type {
	CommandInteraction,
	MessageComponentInteraction,
} from "@minesa-org/mini-interaction";
import {
	SPONSOR_PACKS,
	formatCreditAmount,
	formatCredits,
	purchaseSponsorPack,
	findSponsorPack,
	getSponsorCredit,
	getFreePackStatus,
	type ConsumableId,
	type FreePackStatus,
	type PackMember,
	type PackPurchaseResult,
	type PackReward,
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
import {
	getMemberPremiumSince,
	getMemberRoleIds,
	interactionDiscordId,
} from "../utils/discordInteractions.js";
import { getCommunityGuildMember } from "../utils/discordRoleGrant.js";
import {
	publishGameLog,
	type GameLogField,
	type GameLogPayload,
} from "../utils/gameLogChannel.js";
import { waitUntil } from "@vercel/functions";
import { formatSponsorHistory } from "../utils/sponsorHistory.js";
import { buttonRow, COLORS, divider, text } from "../ui/containers.js";
import { classComponentEmoji, componentEmoji, emoji, type EmojiName } from "../ui/emojis.js";

const BUY_BUTTON_PREFIX = "packs:buy:";
const PACK_SELECT_ID = "packs:view";
const HISTORY_BUTTON_ID = "packs:history";
const CHARACTER_SELECT_PREFIX = "packs:char:";

// Components V2 messages require the IsComponentsV2 flag; shop views are ephemeral.
const CONTAINER_FLAGS = MessageFlags.IsComponentsV2;
const CONTAINER_EPHEMERAL_FLAGS =
	(MessageFlags.IsComponentsV2 | InteractionFlags.Ephemeral) as MessageFlags;

function packPriceLabel(pack: SponsorPack) {
	return pack.priceCents === 0 ? "Free" : formatCredits(pack.priceCents);
}

/** Who a pack is for, in a few words: the pack list and the detail view both use it. */
function packTerms(pack: SponsorPack): string {
	if (pack.requiredRoleId) return "Sponsors · once per player";
	if (pack.requiredBoostDays !== undefined) {
		return `After ${pack.requiredBoostDays} days of boosting · once per player`;
	}
	return "Paid with Royal Sigils";
}

function buildPackSelectRow(defaultId?: string) {
	const select = new StringSelectMenuBuilder()
		.setCustomId(PACK_SELECT_ID)
		.setPlaceholder(defaultId ? "Look at another pack…" : "Pick a pack to see what's inside…")
		.setMinValues(1)
		.setMaxValues(1)
		.setOptions(
			SPONSOR_PACKS.map((pack) =>
				new StringSelectMenuOptionBuilder()
					.setLabel(`${pack.name} · ${pack.priceCents === 0 ? "Free" : `${formatCreditAmount(pack.priceCents)} Royal Sigils`}`)
					.setValue(pack.id)
					.setEmoji(componentEmoji(pack.emoji))
					.setDescription(packTerms(pack))
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
					.setEmoji(classComponentEmoji(character.class))
					.setDefault(
						selectedCharacter
							? character.name === selectedCharacter
							: character === characters[0],
					),
			),
		);

	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

/** The line under the price saying whether this player can take the pack, and if not, why. */
function statusLine(status: FreePackStatus | null): string | null {
	if (!status) return null;
	switch (status.kind) {
		case "eligible":
			return "You can claim this pack.";
		case "claimed":
			return "You have already claimed this pack.";
		case "missing-role":
			return `You need the <@&${status.roleId}> role to claim this pack.`;
		case "boosting": {
			if (status.boostedDays === null) {
				return `Boost the server and keep it for ${status.requiredDays} days to unlock this pack.`;
			}
			const left = status.requiredDays - status.boostedDays;
			return `You have boosted for ${status.boostedDays} of ${status.requiredDays} days. ${left} more ${left === 1 ? "day" : "days"} to go.`;
		}
	}
}

function packBanner(pack: SponsorPack) {
	return new GalleryBuilder().addItem(
		new GalleryItemBuilder()
			.setMedia({ url: pack.imageUrl })
			.setDescription(`${pack.name}: ${pack.items.join(", ")}`.slice(0, 1024)),
	);
}

function buildPackContainer(
	pack: SponsorPack,
	status: FreePackStatus | null,
	characters: GameCharacterOption[] = [],
	selectedCharacter?: string,
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(pack.color);
	container.addComponent(packBanner(pack));

	const status_ = statusLine(status);
	container.addComponent(
		text(
			[
				`## ${emoji(pack.emoji)} ${pack.name}`,
				`**${packPriceLabel(pack)}** · ${packTerms(pack)}`,
				...(status_ ? [status_] : []),
			].join("\n"),
		),
	);

	container.addComponent(divider());

	// A free pack this player cannot take: the status line already says why, so the
	// delivery controls would only be a disabled button to look at.
	if (status && status.kind !== "eligible") {
		container.addComponent(buildPackSelectRow(pack.id));
		return container;
	}

	const characterRow = buildCharacterSelectRow(pack, characters, selectedCharacter);
	if (characterRow) {
		container.addComponent(text("**Deliver to**"));
		container.addComponent(characterRow);
	} else {
		container.addComponent(
			text(
				"**Deliver to**\n-# You have no character yet. Create one in-game, then come back to claim it.",
			),
		);
	}

	// Paid packs check credit only on Buy (it is a GitHub round trip), so the button is
	// disabled only when there is no character to deliver to.
	const canTake = characterRow !== null;
	// Without an explicit pick the server delivers to the most recent unlocked character.
	const target = selectedCharacter;
	container.addComponent(
		buttonRow(
			new ButtonBuilder()
				.setLabel(
					pack.priceCents === 0
						? "Claim for free"
						: `Buy for ${formatCreditAmount(pack.priceCents)} Royal Sigils`,
				)
				.setStyle(ButtonStyle.Success)
				.setDisabled(!canTake)
				.setCustomId(
					target
						? `${BUY_BUTTON_PREFIX}${pack.id}:${target}`
						: `${BUY_BUTTON_PREFIX}${pack.id}`,
				),
		),
	);

	container.addComponent(divider());
	container.addComponent(buildPackSelectRow(pack.id));
	return container;
}

function buildShopContainer(): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(COLORS.warning);
	const line = (pack: SponsorPack) =>
		`${emoji(pack.emoji)} **${pack.name}** · ${pack.priceCents === 0 ? packTerms(pack).replace(" · once per player", "") : packPriceLabel(pack)}`;
	const free = SPONSOR_PACKS.filter((pack) => pack.priceCents === 0);
	const paid = SPONSOR_PACKS.filter((pack) => pack.priceCents > 0 && !pack.group);
	const tierLine = (pack: SponsorPack) => `${pack.items.join(" + ")} · ${packPriceLabel(pack)}`;
	const kit = SPONSOR_PACKS.filter((pack) => pack.group === "kit");
	const keyChest = SPONSOR_PACKS.filter((pack) => pack.group === "key-chest");

	container.addComponent(
		text(
			[
				"## Pack Shop",
				"-# Rewards go straight into the character you pick, the moment you buy.",
				"-# Every $1 paid on GitHub Sponsors or Patreon, monthly or one-time, gives you 100 Royal Sigils to spend here.",
			].join("\n"),
		),
	);
	container.addComponent(divider());
	container.addComponent(
		text(["### Free, once per player", ...free.map(line)].join("\n")),
	);
	container.addComponent(
		text(["### Paid with Royal Sigils", ...paid.map(line)].join("\n")),
	);
	container.addComponent(
		text([`### ${emoji("item_mammoth_idol")} Kit Packs`, ...kit.map(tierLine)].join("\n")),
	);
	container.addComponent(
		text([`### ${emoji("item_trove_chest")} Key & Chest Packs`, ...keyChest.map(tierLine)].join("\n")),
	);
	container.addComponent(
		buttonRow(
			new ButtonBuilder()
				.setCustomId(HISTORY_BUTTON_ID)
				.setLabel("My Royal Sigils")
				.setEmoji(componentEmoji("item_royal_sigil"))
				.setStyle(ButtonStyle.Secondary),
		),
	);
	container.addComponent(divider());
	container.addComponent(buildPackSelectRow());
	return container;
}

const POTION_EMOJI: Record<ConsumableId, EmojiName> = {
	exp: "item_potion_exp",
	gear: "item_potion_gear",
	gold: "item_potion_gold",
	material: "item_potion_material",
};

function rewardIcon(reward: PackReward): string {
	switch (reward.kind) {
		case "keys":
			return emoji("cur_dragon_key");
		case "gold":
			return emoji("item_gold");
		case "sigils":
			return emoji("item_silver_sigil");
		case "mount":
			return emoji(reward.exclusive ? "item_mount_exclusive" : "item_mount");
		case "dye":
			return emoji(reward.legendary ? "item_dye_legendary" : "item_dye_rare");
		case "lockbox":
			return emoji("item_trove_chest");
		case "consumable":
			return emoji(POTION_EMOJI[reward.consumableId]);
		case "idols":
			return emoji("item_mammoth_idol");
	}
}

/** How many dye names a grouped dye line spells out before it summarises the rest. */
const DYE_NAMES_SHOWN = 8;

/**
 * The buyer's "what you got" list. Dyes arrive as one reward each, so a pack with twenty of
 * them is folded into a single line rather than twenty. A reward that did not land is marked
 * without the raw database message: that goes to the operator log, which is where staff read
 * it and where they can put the reward right.
 */
function buildDeliverySummary(deliveries: PackRewardDeliveryResult[]): string[] {
	if (deliveries.length === 0) return ["-# No rewards to deliver for this pack."];

	const lines: string[] = ["**What you got**"];
	const dyes = deliveries.filter(
		(outcome) => outcome.status === "delivered" && outcome.delivery.reward.kind === "dye",
	);
	let dyesListed = false;
	for (const outcome of deliveries) {
		const reward = outcome.delivery.reward;
		if (dyes.length > 1 && dyes.includes(outcome)) {
			if (dyesListed) continue;
			dyesListed = true;
			const names = dyes.map((dye) => formatRewardLine(dye.delivery.reward));
			const rest = names.length - DYE_NAMES_SHOWN;
			lines.push(
				`${rewardIcon(reward)} ${dyes.length} Legendary Dyes`,
				`-# ${names.slice(0, DYE_NAMES_SHOWN).join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`,
			);
			continue;
		}
		const line = `${rewardIcon(reward)} ${formatRewardLine(reward)}`;
		lines.push(outcome.status === "delivered" ? line : `${line} · not delivered`);
	}
	if (deliveries.some((outcome) => outcome.status !== "delivered")) {
		lines.push("-# Anything marked \"not delivered\" did not reach your save. Staff have been notified and will add it by hand.");
	}
	return lines;
}

function buildPurchasedContainer(
	pack: SponsorPack,
	credit: SponsorCredit,
	deliveries: PackRewardDeliveryResult[],
): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(pack.color);
	container.addComponent(packBanner(pack));

	const characterName =
		deliveries.find((outcome) => outcome.status === "delivered")?.delivery.characterName ?? "";
	const paidLine =
		pack.priceCents === 0
			? "-# Free claim"
			: `-# Paid ${formatCredits(pack.priceCents)} · ${credit.balanceCents === null ? "balance unknown" : `${formatCredits(credit.balanceCents)} left`}`;
	container.addComponent(
		text(
			[
				`## ${emoji(pack.emoji)} ${pack.name} delivered${characterName ? ` to ${characterName}` : ""}`,
				paidLine,
			].join("\n"),
		),
	);
	container.addComponent(divider());
	container.addComponent(text(buildDeliverySummary(deliveries).join("\n")));
	container.addComponent(divider());
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
const PURCHASE_STATUS: Record<string, string> = {
	ok: "Delivered",
	insufficient: "Not enough Royal Sigils",
	"missing-role": "Sponsor role required",
	"not-boosting": "Not boosting long enough",
	"already-claimed": "Already claimed",
	"no-character": "Delivery failed — refunded",
	"credit-unknown": "Royal Sigils could not be verified",
	conflict: "Balance changed mid-purchase",
	"not-sponsor": "Not a sponsor",
	"no-profile": "Not linked",
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
	const status = PURCHASE_STATUS[result.status] ?? result.status;
	const fields: GameLogField[] = [
		{ name: "Player", value: `<@${discordId}>`, inline: true },
	];
	if ("pack" in result) {
		fields.push({
			name: "Pack",
			value: `${emoji(result.pack.emoji)} ${result.pack.name}`,
			inline: true,
		});
		fields.push({
			name: "Price",
			value: formatCredits(result.pack.priceCents),
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
					: formatCredits(result.credit.balanceCents),
			inline: true,
		});
		if (result.credit.bonusCents > 0) {
			fields.push({
				name: "Bonus Royal Sigils",
				value: formatCredits(result.credit.bonusCents),
				inline: true,
			});
		}
		// What the game server reports the character holds after the delivery ("(live)" when the
		// player was in game). This is the line that answers "the credit went but the rewards are
		// not in the game": either the values are named here, or the delivery is reported as
		// failed above.
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
		// A partly delivered pack is not refunded, so the rewards that did not land need staff
		// to grant them — this is the list to work from.
		const missed = result.deliveries
			.filter((outcome) => outcome.status !== "delivered")
			.slice(0, 6)
			.map(
				(outcome) =>
					`- ${formatRewardLine(outcome.delivery.reward)} → ${outcome.error ?? "not delivered"}`,
			);
		if (missed.length > 0) {
			fields.push({ name: "Not delivered", value: missed.join("\n") });
		}
	} else if (result.status === "insufficient") {
		fields.push({
			name: "Balance",
			value: formatCredits(result.balanceCents),
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
	}

	return {
		event: `pack-purchase-${result.status}`,
		title: `Pack purchase — ${status}`,
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
		`### ${emoji(pack.emoji)} ${pack.name} purchased!${pack.priceCents === 0 ? " (free claim)" : ""}`,
		`**Price:** ${packPriceLabel(pack)}`,
		...(pack.requiredBoostDays !== undefined
			? []
			: [`**Remaining balance:** ${credit.balanceCents === null ? "Unknown" : formatCredits(credit.balanceCents)}`]),
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
	member: PackMember,
	characterName: string | undefined,
	editReply: (data: Record<string, unknown>) => Promise<unknown>,
) {
	const result = await purchaseSponsorPack(discordId, packId, member, characterName);
	// Loaded after the purchase, never before: the reward lines should name what was
	// delivered ("Skybone Wyrm"), but a slow game server must not delay the write.
	await ensureGameItemNames();
	// Every outcome that means something happened to a save or a balance is
	// logged. A random member clicking a sponsor-only pack is not an event an
	// operator needs to read.
	if (
		result.status !== "no-profile" &&
		result.status !== "not-sponsor" &&
		result.status !== "not-boosting"
	) {
		reportPurchase(purchaseLogCard(result, discordId, packId));
	}

	switch (result.status) {
		case "no-profile":
			return editReply({
				content:
					"Your Discord account is not linked yet, so your Royal Sigils cannot be checked. Link your account first.",
				flags: InteractionFlags.Ephemeral,
			});
		case "missing-role":
			return editReply({
				content: `The **${result.pack.name}** is a free claim for sponsors only — you need the <@&${result.pack.requiredRoleId}> role to claim it.`,
				flags: InteractionFlags.Ephemeral,
			});
		case "not-boosting":
			return editReply({
				content:
					result.boostedDays === null
						? `The **${result.pack.name}** is for server boosters. Boost the server and keep it up for ${result.pack.requiredBoostDays} days, then claim it here.`
						: `You have boosted the server for ${result.boostedDays} of the ${result.pack.requiredBoostDays} days the **${result.pack.name}** needs. Come back in ${result.pack.requiredBoostDays! - result.boostedDays} more ${result.pack.requiredBoostDays! - result.boostedDays === 1 ? "day" : "days"}.`,
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
					"Royal Sigils come from donations. Sponsor The Minesa Studios on GitHub Sponsors or Patreon first!",
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
				content: `You need ${formatCredits(result.pack.priceCents)} for the **${result.pack.name}**, but your remaining balance is ${formatCredits(result.balanceCents)}.`,
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
					`The **${result.pack.name}** could not be delivered — ${result.reason}`,
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

/**
 * The member a gated pack is checked against. The Sponsor role and server
 * boosts exist only on the community guild (DISCORD_GUILD_ID), while the shop
 * is global — the interaction's `member` describes the player in whichever
 * guild they invoked it from, so outside the community guild their membership
 * is fetched there instead. A member that cannot be read gets no roles and no
 * boost, never a free pass.
 */
async function packMember(
	interaction: CommandInteraction | MessageComponentInteraction,
	discordId: string,
): Promise<PackMember> {
	const communityGuildId = process.env.DISCORD_GUILD_ID?.trim();
	const guildId = String(
		(interaction as { guild_id?: string | null }).guild_id ?? "",
	).trim();
	if (!communityGuildId) {
		return { roleIds: [], premiumSince: null };
	}
	if (guildId === communityGuildId) {
		return {
			roleIds: getMemberRoleIds(interaction),
			premiumSince: getMemberPremiumSince(interaction),
		};
	}
	const member = await getCommunityGuildMember(discordId).catch(() => null);
	return {
		roleIds: member?.roleIds ?? [],
		premiumSince: member?.premiumSince ?? null,
	};
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
			await packMember(interaction, discordId),
			characterName,
			(data) => interaction.editReply(data as never),
		);
	} catch (error) {
		console.error("[packs] Purchase failed:", error);
		// A thrown purchase is the one outcome the player only sees as a generic
		// message, so the operator log carries the real error.
		reportPurchase({
			event: "pack-purchase-error",
			title: "Pack purchase failed",
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

	return interaction.update({
		components: [await buildPackView(interaction, pack)],
		flags: CONTAINER_FLAGS,
	});
}

/** The pack's detail view for this player: their characters and, for a free pack, whether they can claim it. */
async function buildPackView(
	interaction: MessageComponentInteraction,
	pack: SponsorPack,
	selectedCharacter?: string,
): Promise<ContainerBuilder> {
	const discordId = interactionDiscordId(interaction);
	const [characters, status] = await Promise.all([
		discordId ? listGameSaveCharacters(discordId).catch(() => []) : Promise.resolve([]),
		discordId
			? packMember(interaction, discordId).then((member) =>
					getFreePackStatus(discordId, pack, member),
				)
			: Promise.resolve(null),
	]);
	return buildPackContainer(pack, status, characters, selectedCharacter);
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
		.setName("packs")
		.setDescription("Browse and buy sponsor packs"),
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

/** The player's own Royal Sigils: balance and every donation behind it, month by month. */
async function handleHistory(interaction: MessageComponentInteraction) {
	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return interaction.reply({ content: "Your Discord account could not be verified.", flags: InteractionFlags.Ephemeral });
	}
	await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
	const credit = await getSponsorCredit(discordId).catch(() => null);
	if (!credit) {
		return interaction.editReply({ content: "Your Discord account is not linked yet, so there are no Royal Sigils to show." });
	}
	const container = new ContainerBuilder().setAccentColor(COLORS.warning);
	container.addComponent(
		text(
			[
				`## ${emoji("item_royal_sigil")} Your Royal Sigils`,
				`**Balance:** ${credit.balanceCents === null ? "unknown" : formatCredits(credit.balanceCents)}`,
				`-# Donated ${credit.sponsoredCents === null ? "unknown" : formatCredits(credit.sponsoredCents)}${credit.bonusCents > 0 ? ` · bonus ${formatCredits(credit.bonusCents)}` : ""} · spent ${formatCredits(credit.usedCents)}`,
			].join("\n"),
		),
	);
	container.addComponent(divider());
	container.addComponent(text((credit.history ? formatSponsorHistory(credit.history) : ["Donation history is not available right now."]).join("\n").slice(0, 3800)));
	return interaction.editReply({ components: [container], flags: CONTAINER_EPHEMERAL_FLAGS } as never);
}

export const packsHistoryComponent = {
	customId: HISTORY_BUTTON_ID,
	handler: (interaction: MessageComponentInteraction) => handleHistory(interaction),
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

		return interaction.update({
			components: [await buildPackView(interaction, pack, selected)],
			flags: CONTAINER_FLAGS,
		});
	},
};
