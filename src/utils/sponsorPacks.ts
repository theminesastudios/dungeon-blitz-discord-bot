import {
	getPackLedger,
	getPlayerProfile,
	recordPackPurchase,
	type PackPurchase,
} from "./gameWallet.js";
import { getSponsorDonationInfo } from "./githubSponsors.js";

/** Discord role that unlocks the free Sponsor Pack claim. */
export const SPONSOR_ROLE_ID = "1365618632415248444";

export type SponsorPack = {
	id: string;
	name: string;
	priceCents: number;
	emoji: string;
	color: number;
	items: string[];
	/** When set, only members with this Discord role can claim the pack. */
	requiredRoleId?: string;
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
	usedCents: number;
	balanceCents: number | null;
	purchases: PackPurchase[];
};

/**
 * A player's spendable credit is the donation total GitHub reports for their linked
 * account, minus whatever they have already spent on packs.
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
		usedCents: ledger.usedCents,
		balanceCents:
			sponsoredCents === null ? null : Math.max(0, sponsoredCents - ledger.usedCents),
		purchases: ledger.purchases,
	};
}

export type PackPurchaseResult =
	| { status: "ok"; pack: SponsorPack; credit: SponsorCredit }
	| { status: "no-profile" }
	| { status: "not-sponsor" }
	| { status: "credit-unknown" }
	| { status: "insufficient"; pack: SponsorPack; balanceCents: number }
	| { status: "missing-role"; pack: SponsorPack }
	| { status: "already-claimed"; pack: SponsorPack }
	| { status: "conflict"; pack: SponsorPack };

export async function purchaseSponsorPack(
	discordId: string,
	packId: string,
	memberRoleIds: string[] = [],
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

		const purchase: PackPurchase = {
			packId: pack.id,
			packName: pack.name,
			priceCents: 0,
			purchasedAtMs: Date.now(),
		};
		const recorded = await recordPackPurchase(
			discordId.trim(),
			purchase,
			Number.MAX_SAFE_INTEGER,
		);
		if (!recorded) return { status: "conflict", pack };

		const credit = await getSponsorCredit(discordId);
		return {
			status: "ok",
			pack,
			credit:
				credit ?? {
					githubUsername: profile.githubUsername ?? "",
					isSponsor: profile.isSponsor === true,
					sponsoredCents: null,
					usedCents: ledger.usedCents,
					balanceCents: null,
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

	const recorded = await recordPackPurchase(
		discordId.trim(),
		{
			packId: pack.id,
			packName: pack.name,
			priceCents: pack.priceCents,
			purchasedAtMs: Date.now(),
		},
		credit.balanceCents - pack.priceCents,
	);
	if (!recorded) return { status: "conflict", pack };

	const updated = await getSponsorCredit(discordId);
	return {
		status: "ok",
		pack,
		credit:
			updated ??
			{
				...credit,
				usedCents: credit.usedCents + pack.priceCents,
				balanceCents: credit.balanceCents - pack.priceCents,
			},
	};
}
