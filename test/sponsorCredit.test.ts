import assert from "node:assert/strict";
import { maxUsedCentsBeforeCharge } from "../src/utils/sponsorPacks.js";
import {
	buildSponsorHistory,
	formatSponsorHistory,
	githubEventsFromActivities,
	patreonEventsFromPledges,
	type GithubSponsorActivity,
} from "../src/utils/sponsorHistory.js";

const monthly = (cents: number, name = "Tier") => ({ monthlyPriceInCents: cents, isOneTime: false, name });
const activity = (action: string, timestamp: string, tier = monthly(300)): GithubSponsorActivity => ({
	action,
	timestamp,
	sponsorLogin: "player",
	tier,
});

// $3/month from 10 Jan, cancelled 20 Mar, back on 5 May at $5, read on 1 Jun:
// charges 10 Jan, 10 Feb, 10 Mar ($9) and 5 May ($5) = 1,400 Royal Sigils.
const now = Date.parse("2026-06-01T00:00:00Z");
const events = githubEventsFromActivities(
	[
		activity("NEW_SPONSORSHIP", "2026-01-10T12:00:00Z"),
		activity("CANCELLED_SPONSORSHIP", "2026-03-20T12:00:00Z"),
		activity("NEW_SPONSORSHIP", "2026-05-05T12:00:00Z", monthly(500)),
	],
	now,
);
const history = buildSponsorHistory(events, now);
assert.equal(history.totalCents, 1_400);
assert.equal(history.active, true);
assert.deepEqual(
	events.map((event) => event.kind),
	["subscribed", "payment", "payment", "payment", "cancelled", "resubscribed", "payment"],
);

// A one-time payment counts once, whenever it was made.
const oneTime = githubEventsFromActivities(
	[activity("NEW_SPONSORSHIP", "2026-02-01T00:00:00Z", { monthlyPriceInCents: 2_500, isOneTime: true, name: "One-time" })],
	now,
);
assert.equal(buildSponsorHistory(oneTime, now).totalCents, 2_500);
assert.equal(buildSponsorHistory(oneTime, now).active, false);

// A tier change re-prices the charges after the month already paid.
const upgraded = githubEventsFromActivities(
	[activity("NEW_SPONSORSHIP", "2026-04-01T00:00:00Z"), activity("TIER_CHANGE", "2026-04-15T00:00:00Z", monthly(1_000))],
	now,
);
assert.equal(buildSponsorHistory(upgraded, now).totalCents, 300 + 1_000 + 1_000, "1 Apr at $3, 1 May and 1 Jun at $10");

// Patreon: paid charges count, failed ones do not; a delete is a cancellation.
const patreon = patreonEventsFromPledges([
	{ type: "pledge_start", date: "2026-01-01T00:00:00Z", amountCents: 500, paymentStatus: null, tierTitle: "Hero" },
	{ type: "subscription", date: "2026-01-01T00:00:00Z", amountCents: 500, paymentStatus: "Paid", tierTitle: "Hero" },
	{ type: "subscription", date: "2026-02-01T00:00:00Z", amountCents: 500, paymentStatus: "Declined", tierTitle: "Hero" },
	{ type: "pledge_delete", date: "2026-02-03T00:00:00Z", amountCents: 0, paymentStatus: null, tierTitle: null },
]);
const combined = buildSponsorHistory([...events, ...patreon], now);
assert.equal(combined.totalCents, 1_900);

const lines = formatSponsorHistory(combined);
assert.equal(lines[0], "**May 2026**");
assert.ok(lines.includes("- 20: cancelled on GitHub"));
assert.ok(lines.includes("- 5: subscribed again on GitHub (Tier)"));
assert.ok(lines.includes("- 3: cancelled on Patreon"));

// `recordPackPurchase` charges only while `packUsedCents <= cap`, so the cap is what a player may
// already have spent. Regression: it was the post-purchase balance, which refused the Hero Pack
// as a "conflict" to a $40 sponsor who had already bought the Supporter and Adventurer packs.
const charges = (used: number, total: number, price: number) =>
	used <= maxUsedCentsBeforeCharge(used, total - used, price);
assert.ok(charges(1_300, 4_000, 2_500), "$27 left buys the $25 Hero Pack after $13 spent");
assert.ok(charges(0, 2_500, 2_500), "a first purchase may spend the whole balance");
assert.ok(charges(1_500, 4_000, 2_500), "spending exactly the rest is affordable");
assert.ok(!charges(1_600, 4_000, 2_500), "$24 left cannot buy the $25 Hero Pack");
