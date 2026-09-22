import {
	getPackLedger,
	getPlayerProfile,
	grantBonusCredit,
	recordPackPurchase,
	refundPackPurchase,
	type PackPurchase,
} from "./gameWallet.js";
import {
	LockedCharacterError,
	applyPackRewardsToSave,
	findDefaultGameSaveCharacter,
	findGameUserIdForDiscord,
	listGameSaveCharacters,
	type GameSaveCharacterRef,
} from "./gameRewards.js";
import { getSponsorDonationInfo } from "./githubSponsors.js";

export type { GameCharacterOption } from "./gameRewards.js";

/** Discord role that unlocks the free Sponsor Pack claim. */
export const SPONSOR_ROLE_ID = "1365618632415248444";

/* ------------------------------------------------------------------
 * Pack rewards
 *
 * Each pack carries a concrete `rewards` table that the shop rolls and
 * writes straight into the buyer's game save, so nothing has to be
 * delivered by hand any more.
 * ------------------------------------------------------------------ */

/** Consumable IDs as they appear in the game's save (`consumables[].consumableID`). */
export type ConsumableId = "exp" | "gear" | "gold" | "material";

/** A concrete game reward: written into the save document at purchase time. */
export type PackReward =
	| { kind: "mount"; mountId: number; mountIds?: number[]; label: string; exclusive: boolean }
	| { kind: "dye"; dyeId: number; label: string; legendary: boolean }
	| { kind: "lockbox"; lockboxId: number; count: number; label: string }
	| { kind: "consumable"; consumableId: ConsumableId; count: number; label: string }
	| { kind: "gold"; amount: number }
	| { kind: "sigils"; amount: number };

/** Reward pools the game maintains. Mount/dye IDs must match live game content. */
export const NON_EXCLUSIVE_MOUNT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const EXCLUSIVE_MOUNT_IDS = [81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91] as const;
export const LEGENDARY_DYE_IDS = [4, 9, 11, 13, 19, 20, 22, 26, 27, 33] as const;

const EXP_POTION_ID = 1;
const GEAR_POTION_ID = 3;
const GOLD_POTION_ID = 6;
const MATERIAL_POTION_ID = 8;
const TROVE_LOCKBOX_ID = 1;

export const CONSUMABLE_ID_BY_KIND: Record<ConsumableId, number> = {
	exp: EXP_POTION_ID,
	gear: GEAR_POTION_ID,
	gold: GOLD_POTION_ID,
	material: MATERIAL_POTION_ID,
};

function pickRandom<T>(values: readonly T[]): T {
	return values[Math.floor(Math.random() * values.length)];
}

function mountReward(mountId: number, exclusive: boolean): PackReward {
	return { kind: "mount", mountId, exclusive, label: "Mount" };
}

function mountBundleReward(mountIds: number[], exclusive: boolean): PackReward {
	const first = mountIds[0] ?? 0;
	return {
		kind: "mount",
		mountId: first,
		mountIds: mountIds.length > 1 ? [...mountIds] : undefined,
		exclusive,
		label: "Mount",
	};
}

function dyeReward(dyeId: number): PackReward {
	return { kind: "dye", dyeId, legendary: true, label: "Legendary Dye" };
}

function lockboxReward(count: number): PackReward {
	return { kind: "lockbox", lockboxId: TROVE_LOCKBOX_ID, count, label: "Trove Chests" };
}

function consumableReward(kind: ConsumableId, count: number): PackReward {
	return { kind: "consumable", consumableId: kind, count, label: `${kind} potion` };
}

/** Builds the concrete reward list for a pack, rolling any random entries. */
export function buildPackRewards(pack: Pick<SponsorPack, "id">): PackReward[] {
	switch (pack.id) {
		case "sponsor":
			return [
				mountReward(pickRandom(NON_EXCLUSIVE_MOUNT_IDS), false),
				{ kind: "gold", amount: 10_000 },
			];
		case "supporter":
			return [
				lockboxReward(3),
				dyeReward(pickRandom(LEGENDARY_DYE_IDS)),
				{ kind: "gold", amount: 25_000 },
			];
		case "adventurer":
			return [
				lockboxReward(10),
				mountReward(pickRandom(EXCLUSIVE_MOUNT_IDS), true),
				{ kind: "sigils", amount: 250 },
				dyeReward(pickRandom(LEGENDARY_DYE_IDS)),
				consumableReward("exp", 2),
			];
		case "hero":
			return [
				lockboxReward(25),
				mountReward(pickRandom(EXCLUSIVE_MOUNT_IDS), true),
				mountReward(pickRandom(EXCLUSIVE_MOUNT_IDS), true),
				mountReward(pickRandom(EXCLUSIVE_MOUNT_IDS), true),
				{ kind: "sigils", amount: 750 },
				dyeReward(pickRandom(LEGENDARY_DYE_IDS)),
				dyeReward(pickRandom(LEGENDARY_DYE_IDS)),
				{ kind: "gold", amount: 100_000 },
				consumableReward("exp", 2),
				consumableReward("gear", 2),
				consumableReward("gold", 2),
				consumableReward("material", 2),
			];
		case "champions":
			return [
				lockboxReward(50),
				// One bundle so the summary lists all 11 mounts together.
				mountBundleReward([...EXCLUSIVE_MOUNT_IDS], true),
				{ kind: "sigils", amount: 750 },
				...LEGENDARY_DYE_IDS.map((dyeId) => dyeReward(dyeId)),
				{ kind: "gold", amount: 250_000 },
				consumableReward("exp", 5),
				consumableReward("gear", 5),
				consumableReward("gold", 5),
				consumableReward("material", 5),
			];
		default:
			return [];
	}
}

export type SponsorPack = {
	id: string;
	name: string;
	priceCents: number;
	emoji: string;
	color: number;
	items: string[];
	/** Banner image displayed in the pack shop. */
	imageUrl: string;
	/** When set, only members with this Discord role can claim the pack. */
	requiredRoleId?: string;
};

/** A pack reward together with the character that received it. */
export type PackRewardDelivery = {
	reward: PackReward;
	characterName: string;
};

/** Delivery result for one pack purchase. */
export type PackRewardDeliveryResult = {
	status: "delivered" | "failed";
	delivery: PackRewardDelivery;
	error?: string;
};

// Prices mirror the community pack sheet; credit comes from what each sponsor has donated.
export const SPONSOR_PACKS: SponsorPack[] = [
	{
		id: "sponsor",
		name: "Sponsor Pack",
		priceCents: 0,
		emoji: "🐴",
		color: 0xf1f1f1,
		items: ["1 random non-exclusive mount", "10,000 golds"],
		imageUrl:
			"https://media.discordapp.net/attachments/1533512926474797126/1533571335576485928/Sponsor.png?ex=6a8dfa1a&is=6a8ca89a&hm=eb550755829f0edd7e8733ecbe54f2641c092eaca10c8f791d4152a6a2ff6c4c&=&format=webp&quality=lossless&width=2048&height=689",
		requiredRoleId: SPONSOR_ROLE_ID,
	},
	{
		id: "supporter",
		name: "Supporter Pack",
		priceCents: 300,
		emoji: "🗝️",
		color: 0x4fc3f7,
		items: [
			"3 trove keys",
			"3 trove chests",
			"1 legendary dye",
			"25,000 golds",
		],
		imageUrl:
			"https://media.discordapp.net/attachments/1533512926474797126/1533571343813971969/Supporter.png?ex=6a8dfa1c&is=6a8ca89c&hm=d5c29eadd2d31d29734c60a8e6bc49ef5f27e14413faa1f1ae637939659db188&=&format=webp&quality=lossless&width=2048&height=689",
	},
	{
		id: "adventurer",
		name: "Adventurer Pack",
		priceCents: 1_000,
		emoji: "⚔️",
		color: 0xe2582b,
		items: [
			"10 trove keys",
			"10 trove chests",
			"1 exclusive mount",
			"250 sigils coins",
			"2 legendary dyes",
			"2 EXP potions",
		],
		imageUrl:
			"https://media.discordapp.net/attachments/1533512926474797126/1533571352857149491/Adventurer.png?ex=6a8dfa1e&is=6a8ca89e&hm=8c8b8a075a04ef0bd2e527c16912c755ee1daf2abacd98b247ead9b4b8b6079e&=&format=webp&quality=lossless&width=2048&height=689",
	},
	{
		id: "hero",
		name: "Hero Pack",
		priceCents: 2_500,
		emoji: "🛡️",
		color: 0x2c3e50,
		items: [
			"25 trove keys",
			"25 trove chests",
			"3 exclusive mounts",
			"750 sigils coins",
			"4 legendary dyes",
			"100,000 golds",
			"2 EXP potions",
			"2 gear potions",
			"2 gold potions",
			"2 material potions",
		],
		imageUrl:
			"https://media.discordapp.net/attachments/1533512926474797126/1533571366744227890/Hero.png?ex=6a8dfa22&is=6a8ca8a2&hm=3bdc9a2de727401a2eb21b68af69e43a97c947f52992a9f795145ee22149d4a&=&format=webp&quality=lossless&width=2048&height=689",
	},
	{
		id: "champions",
		name: "Champions' Pack",
		priceCents: 10_000,
		emoji: "🏆",
		color: 0x0e8f6e,
		items: [
			"50 trove keys",
			"50 trove chests",
			"ALL exclusive mounts",
			"750 sigils coins",
			"ALL legendary dyes",
			"250,000 golds",
			"5 EXP potions",
			"5 gear potions",
			"5 gold potions",
			"5 material potions",
			"Custom Discord role",
			"Rename an NPC",
		],
		imageUrl:
			"https://media.discordapp.net/attachments/1533512926474797126/1533571380053016686/Champions.png?ex=6a8dfa25&is=6a8ca8a5&hm=7a76b17821c4c1aa210f71527b362300819a5443f13176506c086f1bf55fe92d&=&format=webp&quality=lossless&width=2048&height=698",
	},
];

export function findSponsorPack(packId: string): SponsorPack | null {
	return SPONSOR_PACKS.find((pack) => pack.id === packId) ?? null;
}

export function formatUsd(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

export type SponsorCredit = {
	githubUsername: string;
	isSponsor: boolean;
	sponsoredCents: number | null;
	/** Admin-granted bonus credit that is added on top of the donation total. */
	bonusCents: number;
	usedCents: number;
	balanceCents: number | null;
	purchases: PackPurchase[];
};

/**
 * A player's spendable credit is the donation total GitHub reports for their linked
 * account plus any admin-granted bonus credit, minus whatever they have already
 * spent on packs.
 */
export async function getSponsorCredit(
	discordId: string,
): Promise<SponsorCredit | null> {
	const profile = await getPlayerProfile(`profile:${discordId.trim()}`);
	if (!profile?.githubUsername) return null;

	const ledger = await getPackLedger(discordId.trim());
	let sponsoredCents: number | null = null;
	if (profile.isSponsor) {
		try {
			const donation = await getSponsorDonationInfo(profile.githubUsername);
			sponsoredCents = donation?.estimatedTotalInCents ?? donation?.amountInCents ?? null;
		} catch (error) {
			console.warn(
				`[sponsorPacks] Donation total unavailable for "${profile.githubUsername}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return {
		githubUsername: profile.githubUsername,
		isSponsor: profile.isSponsor === true,
		sponsoredCents,
		bonusCents: ledger.bonusCents,
		usedCents: ledger.usedCents,
		// Unknown donations only hide the GitHub-reported part; bonus credit is
		// always spendable, so the balance stays computable when bonus > 0.
		balanceCents:
			sponsoredCents === null
				? (ledger.bonusCents > 0 ? ledger.bonusCents - ledger.usedCents : null)
				: Math.max(0, sponsoredCents + ledger.bonusCents - ledger.usedCents),
		purchases: ledger.purchases,
	};
}

/**
 * Grants bonus spendable credit (in cents) to a player. This is how external
 * donations that GitHub cannot see (PayPal, Ko-fi, …) become pack credit: the
 * dollar amount is converted 1:1 to cents of credit on their linked profile.
 */
export async function addCreditsToPlayer(input: {
	discordId: string;
	/** Dollar amount to credit, e.g. 12.5 for $12.50. */
	dollars: number;
	grantedByDiscordId: string;
	note?: string;
}): Promise<
	| { status: "ok"; cents: number; totalBonusCents: number }
	| { status: "no-profile" }
	| { status: "not-linked" }
> {
	const cents = Math.round(input.dollars * 100);
	if (!Number.isFinite(input.dollars) || cents <= 0) {
		throw new Error("Credit amount must be a positive dollar amount");
	}

	// The credit ledger lives on the linked profile, so a Discord account with
	// no profile (or no linked GitHub) has nowhere to store the credit.
	const profile = await getPlayerProfile(`profile:${input.discordId.trim()}`);
	if (!profile?.discordUserId) return { status: "no-profile" };
	if (!profile.githubUsername) return { status: "not-linked" };

	const granted = await grantBonusCredit(
		profile.discordUserId,
		cents,
		input.grantedByDiscordId,
		input.note,
	);
	if (!granted) return { status: "no-profile" };

	const ledger = await getPackLedger(profile.discordUserId);
	return { status: "ok", cents, totalBonusCents: ledger.bonusCents };
}

export type PackPurchaseResult =
	| { status: "ok"; pack: SponsorPack; credit: SponsorCredit; deliveries: PackRewardDeliveryResult[] }
	| { status: "no-profile" }
	| { status: "not-sponsor" }
	| { status: "credit-unknown" }
	| { status: "insufficient"; pack: SponsorPack; balanceCents: number }
	| { status: "missing-role"; pack: SponsorPack }
	| { status: "already-claimed"; pack: SponsorPack }
	| { status: "conflict"; pack: SponsorPack }
	| {
			status: "no-character";
			pack: SponsorPack;
			/** Player-facing explanation of why delivery failed. */
			reason: string;
			/** Per-reward outcomes when the save was reachable but the writes failed. */
			deliveries: PackRewardDeliveryResult[];
	  };

function hasNoSuccessfulDelivery(deliveries: PackRewardDeliveryResult[]): boolean {
	return deliveries.length > 0 && deliveries.every((outcome) => outcome.status !== "delivered");
}

function failedDeliveryReason(deliveries: PackRewardDeliveryResult[]): string {
	return (
		deliveries.find((outcome) => outcome.status === "failed")?.error ??
		"The rewards could not be delivered."
	);
}

/** Best-effort revert of a charge whose rewards never landed; failures are logged for follow-up. */
async function refundQuietly(discordId: string, purchase: PackPurchase): Promise<boolean> {
	try {
		return await refundPackPurchase(discordId.trim(), purchase);
	} catch (error) {
		console.error("[sponsorPacks] Automatic refund failed:", error);
		return false;
	}
}

/**
 * One shop purchase, start to finish.
 *
 * Order of operations matters: credit is deducted (or the claim recorded)
 * atomically first, and only then are rewards rolled and written. A charge or
 * free claim that is not followed by at least one successful reward write —
 * including a locked target character — is reverted automatically, so a player
 * can never lose credit or burn the one-time Sponsor claim to a broken save.
 * The failure is reported as `no-character` with the delivery errors; unexpected
 * infrastructure errors still throw, after the same revert.
 *
 * Every network lookup — the profile, the ledger and the GitHub donation total —
 * is done before the charge, and the post-purchase balance is derived locally.
 * Delivery therefore runs with no remote round trip behind it, so the
 * confirmation reply cannot be outlived by a slow dependency.
 */
export async function purchaseSponsorPack(
	discordId: string,
	packId: string,
	memberRoleIds: string[] = [],
	targetCharacterName?: string,
): Promise<PackPurchaseResult> {
	const pack = findSponsorPack(packId);
	if (!pack) return { status: "no-profile" };

	if (pack.requiredRoleId && !memberRoleIds.includes(pack.requiredRoleId)) {
		return { status: "missing-role", pack };
	}

	// The Sponsor Pack is a free claim gated by the Sponsor role, so it costs no
	// credit — but each player can only claim it once.
	if (pack.priceCents === 0) {
		const profile = await getPlayerProfile(`profile:${discordId.trim()}`);
		if (!profile) return { status: "no-profile" };

		const ledger = await getPackLedger(discordId.trim());
		if (ledger.purchases.some((purchase) => purchase.packId === pack.id)) {
			return { status: "already-claimed", pack };
		}

		// Read the sponsor balance before the claim is recorded rather than after
		// delivery. This is the only GitHub round trip on the free path, and
		// paying for it up front keeps the acknowledgement edit off the network's
		// critical path — a slow GitHub response must never outlive the
		// interaction and leave the player on an endless "thinking" state.
		const credit = await getSponsorCredit(discordId).catch(() => null);

		const purchase: PackPurchase = {
			packId: pack.id,
			packName: pack.name,
			purchasedAtMs: Date.now(),
			priceCents: 0,
		};
		const recorded = await recordPackPurchase(
			discordId.trim(),
			purchase,
			Number.MAX_SAFE_INTEGER,
		);
		if (!recorded) return { status: "conflict", pack };

		let deliveries: PackRewardDeliveryResult[];
		try {
			deliveries = await deliverPackRewards(discordId, pack, targetCharacterName);
		} catch (error) {
			// The claim is already on the ledger — release it before surfacing the
			// failure so the one-time pack is never burned by a bad delivery.
			await refundQuietly(discordId.trim(), purchase);
			if (error instanceof LockedCharacterError) {
				return { status: "no-character", pack, reason: error.message, deliveries: [] };
			}
			throw error;
		}
		if (hasNoSuccessfulDelivery(deliveries)) {
			await refundQuietly(discordId.trim(), purchase);
			return {
				status: "no-character",
				pack,
				reason: failedDeliveryReason(deliveries),
				deliveries,
			};
		}

		return {
			status: "ok",
			pack,
			deliveries,
			credit: credit ?? {
				githubUsername: profile.githubUsername ?? "",
				isSponsor: profile.isSponsor === true,
				sponsoredCents: null,
				bonusCents: ledger.bonusCents,
				usedCents: ledger.usedCents,
				balanceCents:
					ledger.bonusCents > 0 ? ledger.bonusCents - ledger.usedCents : null,
				purchases: [...ledger.purchases, purchase],
			},
		};
	}

	const credit = await getSponsorCredit(discordId);
	if (!credit) return { status: "no-profile" };
	if (!credit.isSponsor) return { status: "not-sponsor" };
	if (credit.balanceCents === null) return { status: "credit-unknown" };
	if (credit.balanceCents < pack.priceCents) {
		return { status: "insufficient", pack, balanceCents: credit.balanceCents };
	}

	// Charge first so a double-click can never double-deliver, then deliver.
	const purchase: PackPurchase = {
		packId: pack.id,
		packName: pack.name,
		priceCents: pack.priceCents,
		purchasedAtMs: Date.now(),
	};
	const recorded = await recordPackPurchase(
		discordId.trim(),
		purchase,
		credit.balanceCents - pack.priceCents,
	);
	if (!recorded) return { status: "conflict", pack };

	let deliveries: PackRewardDeliveryResult[];
	try {
		deliveries = await deliverPackRewards(discordId, pack, targetCharacterName);
	} catch (error) {
		// The charge is already on the ledger — revert it before surfacing the
		// failure so a broken delivery never costs the player money.
		await refundQuietly(discordId.trim(), purchase);
		if (error instanceof LockedCharacterError) {
			return { status: "no-character", pack, reason: error.message, deliveries: [] };
		}
		throw error;
	}
	if (hasNoSuccessfulDelivery(deliveries)) {
		await refundQuietly(discordId.trim(), purchase);
		return {
			status: "no-character",
			pack,
			reason: failedDeliveryReason(deliveries),
			deliveries,
		};
	}

	// The new balance is derived from the charge we just recorded. Re-reading the
	// credit here would add a profile lookup, three wallet searches and a second
	// GitHub request *after* delivery, which is exactly where a slow dependency
	// outlives the interaction and strands the player on "thinking…".
	return {
		status: "ok",
		pack,
		deliveries,
		credit: {
			...credit,
			usedCents: credit.usedCents + pack.priceCents,
			balanceCents:
				credit.balanceCents === null
					? null
					: Math.max(0, credit.balanceCents - pack.priceCents),
			purchases: [...credit.purchases, purchase],
		},
	};
}

/**
 * Rolls the pack's rewards and writes them into the buyer's game save. Every
 * reward is attempted independently so one failure does not block the rest.
 *
 * When the buyer picked a target character, the whole pack goes there and a
 * locked pick throws `LockedCharacterError` before anything is written. The
 * fallback is their most recently updated unlocked character — resolved from
 * the game user id so the write can only ever land on the buyer's own save.
 */
export async function deliverPackRewards(
	discordId: string,
	pack: SponsorPack,
	targetCharacterName?: string,
): Promise<PackRewardDeliveryResult[]> {
	const rewards = buildPackRewards(pack);
	if (rewards.length === 0) return [];

	const userId = await findGameUserIdForDiscord(discordId);
	if (userId === null) {
		return noCharacterResults(rewards, targetCharacterName);
	}

	let character: GameSaveCharacterRef | null = null;
	if (targetCharacterName) {
		const characters = await listGameSaveCharacters(discordId);
		const wanted = targetCharacterName.trim().toLowerCase();
		const match = characters.find((option) => option.name.toLowerCase() === wanted);
		if (!match) {
			return rewards.map((reward) => ({
				status: "failed" as const,
				delivery: { reward, characterName: targetCharacterName },
				error: "The chosen character no longer exists on your save. Pick another and buy the pack again.",
			}));
		}
		if (match.locked === true) {
			throw new LockedCharacterError(match.name);
		}
		character = { userId, characterName: match.name };
	}
	if (!character) {
		character = await findDefaultGameSaveCharacter(discordId, userId);
	}
	if (!character) {
		return noCharacterResults(rewards, targetCharacterName);
	}

	return applyPackRewardsToSave(character.userId, character.characterName, rewards);
}

function noCharacterResults(
	rewards: PackReward[],
	targetCharacterName?: string,
): PackRewardDeliveryResult[] {
	return rewards.map((reward) => ({
		status: "failed" as const,
		delivery: { reward, characterName: targetCharacterName ?? "(no character found)" },
		error: "No game save character found for your Discord account. Create one in-game, then claim the pack again.",
	}));
}
