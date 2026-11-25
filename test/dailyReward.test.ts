import assert from "node:assert/strict";
import {
	DAILY_IN_FLIGHT_MS,
	DAILY_RETRY_WINDOW_MS,
	confirmDailyClaim,
	currentDailyStreak,
	dailyRewardForStreak,
	nextDailyStreak,
	pendingAction,
	releaseDailyClaim,
	reserveDailyClaim,
	setDailyCollectionForTests,
	utcDay,
	utcDayStartMs,
	type DailyClaimDocument,
	type DailyReservation,
} from "../src/utils/dailyReward.js";
import { pickDailyCharacter } from "../src/commands/daily.js";

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
assert.equal(nextDailyStreak({ streak: 0 }, today), 1, "a document with no confirmed claim yet");
assert.equal(nextDailyStreak({ lastClaimDay: today - 1, streak: 4 }, today), 5, "yesterday's claim continues it");
assert.equal(nextDailyStreak({ lastClaimDay: today - 2, streak: 4 }, today), 1, "a missed day starts over");
assert.equal(nextDailyStreak({ lastClaimDay: today, streak: 4 }, today), null, "today is claimed once");

assert.equal(currentDailyStreak({ lastClaimDay: today, streak: 3 }, today), 3);
assert.equal(currentDailyStreak({ lastClaimDay: today - 1, streak: 3 }, today), 3, "still claimable today");
assert.equal(currentDailyStreak({ lastClaimDay: today - 2, streak: 3 }, today), 0, "lapsed");

{
	const pending = { requestId: "r", day: today, streak: 1, amount: 1, userId: 1, characterName: "A", startedAtMs: 0 };
	assert.equal(pendingAction(pending, DAILY_IN_FLIGHT_MS - 1), "in-flight");
	assert.equal(pendingAction(pending, DAILY_IN_FLIGHT_MS), "retry");
	assert.equal(pendingAction(pending, DAILY_RETRY_WINDOW_MS + 1), "assume-paid", "past the game server's request-id memory");
}

// The default character is the one played last, not the first in the save.
{
	const options = [
		{ name: "Aria", level: 50, class: "Mage" },
		{ name: "Bram", level: 10, class: "Rogue" },
		{ name: "Cole", level: 60, class: "Paladin", locked: true },
	];
	const played = new Map([["aria", 1_000], ["bram", 5_000], ["cole", 9_000]]);
	assert.equal(pickDailyCharacter(options, played)?.name, "Bram", "most recently played, locked skipped");
	assert.equal(pickDailyCharacter(options, new Map())?.name, "Aria", "highest level when no play is recorded");
	assert.equal(pickDailyCharacter([options[2]], played), null, "no unlocked character");
}

/** The calls dailyReward.ts makes: equality, `$exists` and dotted-path filters; `$set` / `$unset`. */
function memoryCollection() {
	const docs = new Map<string, DailyClaimDocument>();
	const read = (doc: unknown, path: string) =>
		path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], doc);
	const matches = (doc: DailyClaimDocument, filter: Record<string, unknown>) =>
		Object.entries(filter).every(([key, expected]) => {
			const actual = read(doc, key);
			if (expected && typeof expected === "object" && "$exists" in expected) {
				return (actual !== undefined) === (expected as { $exists: boolean }).$exists;
			}
			return actual === expected;
		});
	return {
		docs,
		async findOne(filter: Record<string, unknown>) {
			const doc = docs.get(String(filter._id));
			return doc && matches(doc, filter) ? structuredClone(doc) : null;
		},
		async insertOne(doc: DailyClaimDocument) {
			if (docs.has(doc._id)) throw Object.assign(new Error("duplicate key"), { code: 11000 });
			docs.set(doc._id, structuredClone(doc));
			return { acknowledged: true, insertedId: doc._id };
		},
		async updateOne(
			filter: Record<string, unknown>,
			update: { $set?: Partial<DailyClaimDocument>; $unset?: Record<string, unknown> },
		) {
			const doc = docs.get(String(filter._id));
			if (!doc || !matches(doc, filter)) return { matchedCount: 0, modifiedCount: 0 };
			const next = { ...doc, ...structuredClone(update.$set ?? {}) } as Record<string, unknown>;
			for (const key of Object.keys(update.$unset ?? {})) delete next[key];
			docs.set(doc._id, next as DailyClaimDocument);
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
}

const USER = "123456789012345678";
const TARGET = { userId: 7, characterName: "Aria" };

type Reserved = Extract<DailyReservation, { status: "reserved" }>;
async function claimAndPay(nowMs: number): Promise<Reserved> {
	const reservation = await reserveDailyClaim(USER, TARGET, nowMs);
	assert.equal(reservation.status, "reserved");
	const reserved = reservation as Reserved;
	assert.equal(await confirmDailyClaim(USER, reserved, nowMs), true);
	return reserved;
}

// Three days in a row pay 1, 2, 3; the second claim on a day is refused.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);

	assert.equal((await claimAndPay(midnight + 1_000)).pending.amount, 1);
	const again = await reserveDailyClaim(USER, TARGET, midnight + 60_000);
	assert.equal(again.status, "already-claimed");
	assert.equal(again.status === "already-claimed" && again.nextClaimAtMs, midnight + DAY);

	assert.equal((await claimAndPay(midnight + DAY + 1_000)).pending.amount, 2);
	assert.equal((await claimAndPay(midnight + 2 * DAY + 23 * 3_600_000)).pending.amount, 3);
	assert.equal(collection.docs.get(USER)?.totalSigils, 6);

	// Skipping a day starts over at 1.
	assert.equal((await claimAndPay(midnight + 4 * DAY)).pending.streak, 1);
	assert.equal(collection.docs.get(USER)?.totalSigils, 7);
	assert.equal(collection.docs.get(USER)?.pending, undefined);
}

// Two clicks racing: exactly one reservation wins, on a new document and on an existing one.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);
	const first = await Promise.all([
		reserveDailyClaim(USER, TARGET, midnight + 1_000),
		reserveDailyClaim(USER, TARGET, midnight + 2_000),
	]);
	assert.equal(first.filter((result) => result.status === "reserved").length, 1);
	await confirmDailyClaim(USER, first.find((result) => result.status === "reserved") as Reserved, midnight + 3_000);

	const racing = await Promise.all([
		reserveDailyClaim(USER, TARGET, midnight + DAY),
		reserveDailyClaim(USER, TARGET, midnight + DAY + 1),
	]);
	assert.equal(racing.filter((result) => result.status === "reserved").length, 1);
	assert.ok(racing.some((result) => result.status === "conflict" || result.status === "pending"));
}

// A refused payment frees the day; a stale release cannot drop a later reservation.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);

	const refused = (await reserveDailyClaim(USER, TARGET, midnight)) as Reserved;
	assert.equal(await releaseDailyClaim(USER, refused), true);
	assert.equal(collection.docs.get(USER)?.lastClaimDay, undefined, "nothing was counted");

	const retried = (await reserveDailyClaim(USER, TARGET, midnight + 5_000)) as Reserved;
	assert.equal(retried.status, "reserved");
	assert.equal(retried.pending.amount, 1, "the day can be claimed again");
	assert.equal(await releaseDailyClaim(USER, refused), false, "a stale release does nothing");
	assert.equal(collection.docs.get(USER)?.pending?.requestId, retried.pending.requestId);
}

// Devin's midnight case: yesterday's payment is still pending after midnight. Today cannot
// build on it until it is settled; if the game then refuses it, today starts a fresh streak.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);

	const late = (await reserveDailyClaim(USER, TARGET, midnight + DAY - 1_000)) as Reserved;
	const afterMidnight = await reserveDailyClaim(USER, TARGET, midnight + DAY + 1_000);
	assert.equal(afterMidnight.status, "pending", "the pending payment blocks a new reservation");

	assert.equal(await releaseDailyClaim(USER, late), true, "the game refused yesterday's payment");
	const fresh = (await reserveDailyClaim(USER, TARGET, midnight + DAY + 2_000)) as Reserved;
	assert.equal(fresh.pending.streak, 1, "an unpaid day never counts toward the streak");
	await confirmDailyClaim(USER, fresh, midnight + DAY + 3_000);
	assert.equal(collection.docs.get(USER)?.totalSigils, 1, "the total counts only what was paid");
}

// A lost confirmation keeps the payment pending with its request id, so asking again reuses it.
{
	const collection = memoryCollection();
	setDailyCollectionForTests(collection);

	const lost = (await reserveDailyClaim(USER, TARGET, midnight)) as Reserved;
	const later = await reserveDailyClaim(USER, TARGET, midnight + 60_000);
	assert.equal(later.status, "pending");
	assert.equal(later.status === "pending" && later.pending.requestId, lost.pending.requestId, "the retry carries the same id");
	assert.equal(later.status === "pending" && later.claimId, lost.claimId);

	assert.equal(await confirmDailyClaim(USER, { claimId: lost.claimId, pending: lost.pending }, midnight + 61_000), true);
	assert.equal(await confirmDailyClaim(USER, lost, midnight + 62_000), false, "a second confirmation counts nothing");
	assert.equal(collection.docs.get(USER)?.totalSigils, 1);
	assert.equal((await reserveDailyClaim(USER, TARGET, midnight + 63_000)).status, "already-claimed");
}

setDailyCollectionForTests(null);
console.log("dailyReward: ok");
