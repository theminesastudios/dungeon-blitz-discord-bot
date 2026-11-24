import { randomUUID } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";

/**
 * `/daily`: one claim per UTC day, paid in Royal Sigils, growing with the streak.
 *
 *   day 1 → 1, day 2 → 2, day 3 → 3, …
 *
 * A streak continues when the previous claim was on the UTC day before today, and starts
 * over at 1 when a day was missed. The day boundary is UTC midnight for everyone, so the
 * reply can show the same `<t:…>` reset time to every player.
 *
 * The claim is recorded *before* the sigils are paid, so two clicks racing each other can
 * never pay twice: only one of them moves `lastClaimDay` to today. If the game server then
 * refuses or cannot be reached, the claim is put back exactly as it was (`revertDailyClaim`,
 * matched on the claim's own id) and the player can try again the same day.
 *
 * One document per Discord user in `dailyClaims`, next to `packClaims`:
 *   { _id: discordId, lastClaimDay, streak, totalSigils, lastClaimAtMs, claimId }
 */

const DAY_MS = 86_400_000;

export type DailyClaimDocument = {
	_id: string;
	/** Days since the Unix epoch (UTC) of the last claim. */
	lastClaimDay: number;
	/** Consecutive days claimed, counting the last claim. */
	streak: number;
	/** Every Royal Sigil `/daily` has paid this player. */
	totalSigils: number;
	lastClaimAtMs: number;
	/** Identifies one claim, so a revert can only undo the claim it belongs to. */
	claimId: string;
};

export type DailyState = Pick<DailyClaimDocument, "lastClaimDay" | "streak">;

/** The UTC day number of a timestamp. */
export function utcDay(nowMs: number): number {
	return Math.floor(nowMs / DAY_MS);
}

/** When a UTC day starts, in ms. */
export function utcDayStartMs(day: number): number {
	return day * DAY_MS;
}

/** Royal Sigils paid for the `streak`-th consecutive day: one per day of the streak. */
export function dailyRewardForStreak(streak: number): number {
	return Math.max(1, Math.floor(streak));
}

/** The streak a claim made today would reach, or `null` when today is already claimed. */
export function nextDailyStreak(state: DailyState | null, today: number): number | null {
	if (!state) return 1;
	if (state.lastClaimDay >= today) return null;
	if (state.lastClaimDay === today - 1) return Math.max(0, Math.floor(state.streak)) + 1;
	return 1;
}

/** The streak the player still holds today: it lapses once a whole UTC day goes unclaimed. */
export function currentDailyStreak(state: DailyState | null, today: number): number {
	if (!state) return 0;
	return state.lastClaimDay >= today - 1 ? Math.max(0, Math.floor(state.streak)) : 0;
}

/* ------------------------------------------------------------------
 * Storage
 * ------------------------------------------------------------------ */

type DailyCollection = Pick<
	Collection<DailyClaimDocument>,
	"findOne" | "insertOne" | "updateOne" | "deleteOne"
>;

let collectionOverride: DailyCollection | null = null;
let clientPromise: Promise<MongoClient> | null = null;

/** Tests swap in an in-memory collection; `null` restores MongoDB. */
export function setDailyCollectionForTests(collection: unknown): void {
	collectionOverride = collection as DailyCollection | null;
}

async function getDailyCollection(): Promise<DailyCollection> {
	if (collectionOverride) return collectionOverride;
	if (!clientPromise) {
		const uri = process.env.GAME_MONGODB_URI?.trim() || process.env.MONGODB_URI?.trim();
		if (!uri) throw new Error("GAME_MONGODB_URI or MONGODB_URI is required");
		clientPromise = (async () => {
			// Fail fast: an interaction lives for minutes, the driver's default stall is 30s.
			const client = new MongoClient(uri, {
				ignoreUndefined: true,
				serverSelectionTimeoutMS: 5_000,
				connectTimeoutMS: 5_000,
				socketTimeoutMS: 10_000,
			});
			await client.connect();
			return client;
		})().catch((error) => {
			clientPromise = null;
			throw error;
		});
	}
	return (await clientPromise)
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<DailyClaimDocument>("dailyClaims");
}

export async function getDailyState(discordId: string): Promise<DailyClaimDocument | null> {
	const id = discordId.trim();
	if (!id) return null;
	return (await getDailyCollection()).findOne({ _id: id });
}

export type DailyClaim =
	| {
			status: "claimed";
			streak: number;
			reward: number;
			day: number;
			claimId: string;
			/** What the document held before, so the claim can be undone. `null`: there was none. */
			previous: DailyClaimDocument | null;
	  }
	| { status: "already-claimed"; streak: number; nextClaimAtMs: number };

/**
 * Records today's claim, or reports that today is already claimed. Never pays anything:
 * the caller pays `reward` and calls `revertDailyClaim` if the payment fails.
 *
 * Every write is conditional on the document still being what was read, so of two claims
 * racing each other exactly one wins and the other reads back as `already-claimed`.
 */
export async function recordDailyClaim(discordId: string, nowMs = Date.now()): Promise<DailyClaim> {
	const id = discordId.trim();
	if (!id) throw new Error("A Discord id is required to claim the daily reward");
	const collection = await getDailyCollection();
	const today = utcDay(nowMs);
	const nextClaimAtMs = utcDayStartMs(today + 1);

	const previous = await collection.findOne({ _id: id });
	const streak = nextDailyStreak(previous, today);
	if (streak === null) {
		return { status: "already-claimed", streak: previous?.streak ?? 0, nextClaimAtMs };
	}

	const reward = dailyRewardForStreak(streak);
	const claimId = randomUUID();
	const next: DailyClaimDocument = {
		_id: id,
		lastClaimDay: today,
		streak,
		totalSigils: Math.max(0, Math.floor(previous?.totalSigils ?? 0)) + reward,
		lastClaimAtMs: nowMs,
		claimId,
	};

	if (!previous) {
		try {
			await collection.insertOne(next);
		} catch (error) {
			// Another claim created the document first: it claimed today.
			if ((error as { code?: number }).code === 11000) {
				return { status: "already-claimed", streak: 1, nextClaimAtMs };
			}
			throw error;
		}
	} else {
		const { _id, ...fields } = next;
		const written = await collection.updateOne(
			{ _id: id, lastClaimDay: previous.lastClaimDay, claimId: previous.claimId },
			{ $set: fields },
		);
		if (written.matchedCount !== 1) {
			const current = await collection.findOne({ _id: id });
			return { status: "already-claimed", streak: current?.streak ?? streak, nextClaimAtMs };
		}
	}

	return { status: "claimed", streak, reward, day: today, claimId, previous };
}

/**
 * Undoes a claim whose sigils were not paid, so the player can claim again today. Matching
 * on `claimId` means a stale revert can never undo a later claim.
 */
export async function revertDailyClaim(
	discordId: string,
	claim: Extract<DailyClaim, { status: "claimed" }>,
): Promise<boolean> {
	const id = discordId.trim();
	const collection = await getDailyCollection();
	if (!claim.previous) {
		const removed = await collection.deleteOne({ _id: id, claimId: claim.claimId });
		return removed.deletedCount === 1;
	}
	const { _id, ...fields } = claim.previous;
	const restored = await collection.updateOne(
		{ _id: id, claimId: claim.claimId },
		{ $set: fields },
	);
	return restored.matchedCount === 1;
}
