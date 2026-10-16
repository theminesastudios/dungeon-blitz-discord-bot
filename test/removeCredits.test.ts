import assert from "node:assert/strict";
import { setWalletCollectionsForTests } from "../src/utils/gameWallet.js";
import { removeCreditsFromPlayer } from "../src/utils/sponsorPacks.js";

/**
 * `/admin credits mode: remove` takes back bonus credit an admin added. It must never take
 * more than the player holds (the balance cannot go below zero, even with two removals
 * racing), and it must leave an audit entry next to the grant it undoes.
 *
 * The fake collection understands exactly the filters `removeBonusCredit` sends: the owner
 * `$or` on `_id` / `userId`, optionally `$and`-ed with `bonusCreditCents: { $gte }`.
 */

type Profile = { _id: string; bonusCreditCents?: number; creditGrants?: Array<Record<string, unknown>> };
type OwnerFilter = { $or: Array<{ _id?: string; userId?: string }> };
type RemoveFilter = OwnerFilter | { $and: [OwnerFilter, { bonusCreditCents: { $gte: number } }] };

const profiles = new Map<string, Profile>();

function find(filter: RemoveFilter): Profile | null {
	const owner = "$and" in filter ? filter.$and[0] : filter;
	const id = owner.$or[0]._id ?? "";
	const profile = profiles.get(id) ?? null;
	if (!profile) return null;
	if ("$and" in filter && (profile.bonusCreditCents ?? 0) < filter.$and[1].bonusCreditCents.$gte) {
		return null;
	}
	return profile;
}

setWalletCollectionsForTests({
	profiles: {
		async findOne(filter: RemoveFilter) {
			const profile = find(filter);
			return profile ? { ...profile } : null;
		},
		async findOneAndUpdate(
			filter: RemoveFilter,
			update: { $inc: { bonusCreditCents: number }; $push: { creditGrants: Record<string, unknown> } },
		) {
			const profile = find(filter);
			if (!profile) return null;
			profile.bonusCreditCents = (profile.bonusCreditCents ?? 0) + update.$inc.bonusCreditCents;
			profile.creditGrants = [...(profile.creditGrants ?? []), update.$push.creditGrants];
			return { ...profile };
		},
	},
});

profiles.set("111", { _id: "111", bonusCreditCents: 1_250 });

// Removing part of the bonus leaves the rest, and the audit entry is a negative grant.
const partial = await removeCreditsFromPlayer({
	discordId: "111",
	dollars: 5,
	removedByDiscordId: "admin",
	note: "typo",
});
assert.deepEqual(partial, { status: "ok", cents: 500, totalBonusCents: 750 });
assert.equal(profiles.get("111")?.bonusCreditCents, 750);
const audit = profiles.get("111")?.creditGrants?.[0];
assert.equal(audit?.cents, -500);
assert.equal(audit?.grantedByDiscordId, "admin");
assert.equal(audit?.note, "typo");

// More than the player holds is refused, says how much there is, and changes nothing.
const tooMuch = await removeCreditsFromPlayer({ discordId: "111", dollars: 10, removedByDiscordId: "admin" });
assert.deepEqual(tooMuch, { status: "insufficient", cents: 1_000, totalBonusCents: 750 });
assert.equal(profiles.get("111")?.bonusCreditCents, 750);
assert.equal(profiles.get("111")?.creditGrants?.length, 1);

// Removing exactly what is left empties it.
const rest = await removeCreditsFromPlayer({ discordId: "111", dollars: 7.5, removedByDiscordId: "admin" });
assert.deepEqual(rest, { status: "ok", cents: 750, totalBonusCents: 0 });

// A profile that never had bonus credit has nothing to remove.
profiles.set("222", { _id: "222" });
assert.deepEqual(
	await removeCreditsFromPlayer({ discordId: "222", dollars: 1, removedByDiscordId: "admin" }),
	{ status: "insufficient", cents: 100, totalBonusCents: 0 },
);

// An unknown player is reported as such, not as "insufficient".
assert.deepEqual(
	await removeCreditsFromPlayer({ discordId: "999", dollars: 1, removedByDiscordId: "admin" }),
	{ status: "no-profile" },
);

// A zero or negative amount is a caller error.
await assert.rejects(removeCreditsFromPlayer({ discordId: "111", dollars: 0, removedByDiscordId: "admin" }));

setWalletCollectionsForTests(null);
console.log("remove credits tests passed");
