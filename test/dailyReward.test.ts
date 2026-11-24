import assert from "node:assert/strict";
import {
	currentDailyStreak,
	dailyRewardForStreak,
	nextDailyStreak,
	recordDailyClaim,
	revertDailyClaim,
	setDailyCollectionForTests,
	utcDay,
	utcDayStartMs,
	type DailyClaimDocument,
} from "../src/utils/dailyReward.js";

const DAY = 86_400_000;

// Day numbers are UTC: 23:59 and 00:00 the next day are different days.
const midnight = Date.UTC(2026, 10, 24);
assert.equal(utcDay(midnight) - utcDay(midnight - 60_000), 1);
assert.equal(utcDayStartMs(utcDay(midnight + 5 * 3_600_000)), midnight);

// Day 1 → 1, day 2 → 2, …: one Royal Sigil per day of the streak.
assert.equal(dailyRewardForStreak(1), 1);
assert.equal(dailyRewardForStreak(2), 2);
assert.equal(dailyRewardForStreak(30), 30);

const today = utcDay(midnight);
assert.equal(nextDailyStreak(null, today), 1, "a first claim starts a streak");
assert.equal(nextDailyStreak({ lastClaimDay: today - 1, streak: 4 }, today), 5, "yesterday's claim continues it");
assert.equal(nextDailyStreak({ lastClaimDay: today - 2, streak: 4 }, today), 1, "a missed day starts over");
assert.equal(nextDailyStreak({ lastClaimDay: today, streak: 4 }, today), null, "today is claimed once");

assert.equal(currentDailyStreak({ lastClaimDay: today, streak: 3 }, today), 3);
assert.equal(currentDailyStreak({ lastClaimDay: today - 1, streak: 3 }, today), 3, "still claimable today");
assert.equal(currentDailyStreak({ lastClaimDay: today - 2, streak: 3 }, today), 0, "lapsed");

/** The four collection calls dailyReward.ts makes, with equality-only filters. */
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

// Three days in a row pay 1, 2, 3; the second click on a day pays nothing.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);

	const first = await recordDailyClaim(USER, midnight + 1_000);
	assert.equal(first.status, "claimed");
	assert.equal(first.status === "claimed" && first.reward, 1);

	const again = await recordDailyClaim(USER, midnight + 60_000);
	assert.equal(again.status, "already-claimed");
	assert.equal(again.status === "already-claimed" && again.nextClaimAtMs, midnight + DAY);

	const second = await recordDailyClaim(USER, midnight + DAY + 1_000);
	assert.equal(second.status === "claimed" && second.reward, 2);
	const third = await recordDailyClaim(USER, midnight + 2 * DAY + 23 * 3_600_000);
	assert.equal(third.status === "claimed" && third.reward, 3);
	assert.equal(collection.docs.get(USER)?.totalSigils, 6);

	// Skipping a day starts over at 1.
	const restart = await recordDailyClaim(USER, midnight + 4 * DAY);
	assert.equal(restart.status === "claimed" && restart.streak, 1);
	assert.equal(collection.docs.get(USER)?.totalSigils, 7);
}

// Two clicks racing on the same day: exactly one claim wins.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);
	const results = await Promise.all([
		recordDailyClaim(USER, midnight + 1_000),
		recordDailyClaim(USER, midnight + 2_000),
	]);
	assert.deepEqual(results.map((result) => result.status).sort(), ["already-claimed", "claimed"]);

	await recordDailyClaim(USER, midnight + DAY); // day 2, streak 2
	const racing = await Promise.all([
		recordDailyClaim(USER, midnight + 2 * DAY),
		recordDailyClaim(USER, midnight + 2 * DAY + 1),
	]);
	assert.equal(racing.filter((result) => result.status === "claimed").length, 1);
	assert.equal(collection.docs.get(USER)?.streak, 3);
}

// A failed payment gives the day back: the first claim is deleted, a later one restored.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);

	const first = await recordDailyClaim(USER, midnight);
	assert.ok(first.status === "claimed");
	assert.equal(await revertDailyClaim(USER, first), true);
	assert.equal(collection.docs.has(USER), false);

	const retried = await recordDailyClaim(USER, midnight + 5_000);
	assert.ok(retried.status === "claimed" && retried.reward === 1, "the day can be claimed again");

	const dayTwo = await recordDailyClaim(USER, midnight + DAY);
	assert.ok(dayTwo.status === "claimed" && dayTwo.reward === 2);
	assert.equal(await revertDailyClaim(USER, dayTwo), true);
	const restored = collection.docs.get(USER);
	assert.equal(restored?.lastClaimDay, today);
	assert.equal(restored?.streak, 1);
	assert.equal(restored?.totalSigils, 1);

	const dayTwoRetry = await recordDailyClaim(USER, midnight + DAY + 10);
	assert.ok(dayTwoRetry.status === "claimed" && dayTwoRetry.reward === 2, "the streak survives a failed payment");

	// A stale revert of the undone claim cannot undo the retry.
	assert.equal(await revertDailyClaim(USER, dayTwo), false);
	assert.equal(collection.docs.get(USER)?.streak, 2);
}

setDailyCollectionForTests(null);
console.log("dailyReward: ok");
