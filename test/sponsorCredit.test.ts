import assert from "node:assert/strict";
import { sponsorCreditCentsFromDonation } from "../src/utils/sponsorPacks.js";

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
