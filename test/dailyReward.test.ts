import assert from "node:assert/strict";
import {
	DAILY_COOLDOWN_MS,
	dailyRewardForStreak,
	nextDailyStreak,
	recordDailyClaim,
	setDailyCollectionForTests,
	undoDailyClaim,
	type DailyClaimDocument,
} from "../src/utils/dailyReward.js";
import { pickDailyCharacter } from "../src/commands/daily.js";

const HOUR = 3_600_000;
const start = Date.UTC(2026, 10, 24, 15);

// 1st day → 1, 2nd → 2, …
assert.equal(dailyRewardForStreak(1), 1);
assert.equal(dailyRewardForStreak(2), 2);
assert.equal(dailyRewardForStreak(30), 30);

// Real time from the last claim: 24 h to the next, kept within 48 h.
const last: DailyClaimDocument = { _id: "u", lastClaimAtMs: start, streak: 4, totalSigils: 10 };
assert.equal(nextDailyStreak(null, start), 1);
assert.equal(nextDailyStreak(last, start + 23 * HOUR), null, "not before 24 hours");
assert.equal(nextDailyStreak(last, start + 24 * HOUR), 5);
assert.equal(nextDailyStreak(last, start + 48 * HOUR), 5);
assert.equal(nextDailyStreak(last, start + 49 * HOUR), 1, "more than 48 hours starts over");

// The default character is the one played last, not the first in the save.
{
	const options = [
		{ name: "Aria", level: 50, class: "Mage" },
		{ name: "Bram", level: 10, class: "Rogue" },
		{ name: "Cole", level: 60, class: "Paladin", locked: true },
	];
	const played = new Map([["aria", 1_000], ["bram", 5_000], ["cole", 9_000]]);
	assert.equal(pickDailyCharacter(options, played)?.name, "Bram");
	assert.equal(pickDailyCharacter(options, new Map())?.name, "Aria", "highest level when no play is recorded");
	assert.equal(pickDailyCharacter([options[2]], played), null);
}

function memoryCollection() {
	const docs = new Map<string, DailyClaimDocument>();
	const matches = (doc: DailyClaimDocument, filter: Record<string, unknown>) =>
		Object.entries(filter).every(([key, value]) => (doc as Record<string, unknown>)[key] === value);
	return {
		docs,
		async findOne(filter: Record<string, unknown>) {
			const doc = docs.get(String(filter._id));
			return doc && matches(doc, filter) ? { ...doc } : null;
		},
		async insertOne(doc: DailyClaimDocument) {
			if (docs.has(doc._id)) throw Object.assign(new Error("duplicate key"), { code: 11000 });
			docs.set(doc._id, { ...doc });
			return { acknowledged: true, insertedId: doc._id };
		},
		async updateOne(filter: Record<string, unknown>, update: { $set: Partial<DailyClaimDocument> }) {
			const doc = docs.get(String(filter._id));
			if (!doc || !matches(doc, filter)) return { matchedCount: 0, modifiedCount: 0 };
			docs.set(doc._id, { ...doc, ...update.$set });
			return { matchedCount: 1, modifiedCount: 1 };
		},
		async deleteOne(filter: Record<string, unknown>) {
			const doc = docs.get(String(filter._id));
			if (!doc || !matches(doc, filter)) return { deletedCount: 0 };
			docs.delete(doc._id);
			return { deletedCount: 1 };
		},
	};
}

const USER = "123456789012345678";

// Three days in a row pay 1, 2, 3; a claim inside the 24 hours waits.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);
	const first = await recordDailyClaim(USER, start);
	assert.equal(first.status === "claimed" && first.reward, 1);
	const early = await recordDailyClaim(USER, start + 2 * HOUR);
	assert.equal(early.status, "cooldown");
	assert.equal(early.status === "cooldown" && early.nextClaimAtMs, start + DAILY_COOLDOWN_MS);
	const second = await recordDailyClaim(USER, start + 25 * HOUR);
	assert.equal(second.status === "claimed" && second.reward, 2);
	const third = await recordDailyClaim(USER, start + 50 * HOUR);
	assert.equal(third.status === "claimed" && third.reward, 3);
	assert.equal(collection.docs.get(USER)?.totalSigils, 6);
	const lapsed = await recordDailyClaim(USER, start + 120 * HOUR);
	assert.equal(lapsed.status === "claimed" && lapsed.streak, 1);
}

// Two clicks at once: one claim.
{
	setDailyCollectionForTests(memoryCollection());
	const clicks = await Promise.all([recordDailyClaim(USER, start), recordDailyClaim(USER, start + 1)]);
	assert.deepEqual(clicks.map((click) => click.status).sort(), ["claimed", "cooldown"]);
}

// A refused payment is undone, so the daily can be claimed again with the same streak.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);
	const first = await recordDailyClaim(USER, start);
	assert.ok(first.status === "claimed");
	assert.equal(await undoDailyClaim(USER, first), true);
	assert.equal(collection.docs.has(USER), false);

	await recordDailyClaim(USER, start + 1_000);
	const second = await recordDailyClaim(USER, start + 25 * HOUR);
	assert.ok(second.status === "claimed" && second.reward === 2);
	assert.equal(await undoDailyClaim(USER, second), true);
	assert.equal(collection.docs.get(USER)?.streak, 1);
	const retry = await recordDailyClaim(USER, start + 25 * HOUR + 5_000);
	assert.ok(retry.status === "claimed" && retry.reward === 2, "the streak survives a refused payment");
}

setDailyCollectionForTests(null);
console.log("dailyReward: ok");
