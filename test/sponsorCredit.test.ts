import assert from "node:assert/strict";
import {
	maxUsedCentsBeforeCharge,
	sponsorCreditCentsFromDonation,
} from "../src/utils/sponsorPacks.js";

type Donation = Parameters<typeof sponsorCreditCentsFromDonation>[0];

function donation(overrides: Partial<NonNullable<Donation>> = {}): Donation {
	return {
		isActive: true,
		amountInCents: 300,
		...overrides,
	};
}

// An active sponsorship is worth exactly the tier they are paying now. The pack
// sheet's cheapest priced pack is the $3.00 Supporter Pack, so a $3/month tier
// buys that and nothing more — no matter how long they have been subscribed.
assert.equal(sponsorCreditCentsFromDonation(donation()), 300);
assert.equal(
	sponsorCreditCentsFromDonation(donation({ amountInCents: 2500 })),
	2500,
);

// A cancelled sponsorship is worth nothing. This is the regression: credit used to
// come from `estimatedTotalInCents`, a wall-clock projection that kept a $3/month
// sponsor's balance climbing to $9.00 and left it there after they cancelled.
assert.equal(
	sponsorCreditCentsFromDonation(donation({ isActive: false })),
	0,
	"a cancelled sponsorship must contribute no credit",
);
assert.equal(
	sponsorCreditCentsFromDonation(
		donation({ isActive: false, amountInCents: 2500 }),
	),
	0,
	"a cancelled high tier must not leave credit behind",
);

// `null` stays reserved for "GitHub would not say", so the balance reads as unknown
// rather than silently dropping to a misleading zero.
assert.equal(
	sponsorCreditCentsFromDonation(null),
	null,
	"no sponsorship record is unknown, not zero",
);
assert.equal(
	sponsorCreditCentsFromDonation(donation({ amountInCents: null })),
	null,
	"an active tier with a hidden price is unknown, not zero",
);

// `recordPackPurchase` charges only while `packUsedCents <= cap`, so the cap is what a player may
// already have spent. Regression: it was the post-purchase balance, which refused the Hero Pack
// as a "conflict" to a $40 sponsor who had already bought the Supporter and Adventurer packs.
const charges = (used: number, total: number, price: number) =>
	used <= maxUsedCentsBeforeCharge(used, total - used, price);
assert.ok(charges(1_300, 4_000, 2_500), "$27 left buys the $25 Hero Pack after $13 spent");
assert.ok(charges(0, 2_500, 2_500), "a first purchase may spend the whole balance");
assert.ok(charges(1_500, 4_000, 2_500), "spending exactly the rest is affordable");
assert.ok(!charges(1_600, 4_000, 2_500), "$24 left cannot buy the $25 Hero Pack");
