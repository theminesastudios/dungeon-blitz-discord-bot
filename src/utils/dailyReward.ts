import { randomUUID } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";

/**
 * `/daily`: one claim per UTC day, paid in Royal Sigils, growing with the streak.
 *
 *   day 1 → 1, day 2 → 2, day 3 → 3, …
 *
 * A streak continues when the previous confirmed claim was on the UTC day before today,
 * and starts over at 1 when a day was missed. The day boundary is UTC midnight for
 * everyone, so the reply can show the same `<t:…>` reset time to every player.
 *
 * A claim is two steps, so a payment is never made twice and never counted unpaid:
 *
 *   1. `reserveDailyClaim` writes a `pending` payment — day, streak, amount, character and
 *      the `requestId` the game server will be asked with. Only one reservation can exist
 *      per player: the write is conditional on the document's `claimId`, and a document
 *      that already holds a pending payment refuses a new one.
 *   2. The caller pays through `/api/admin/rewards` with that `requestId`, then either
 *      `confirmDailyClaim` (the streak, day and total move only now) or
 *      `releaseDailyClaim` (the game said no: nothing was paid, the day is free again).
 *
 * A payment whose outcome is unknown — the game server did not answer — stays pending.
 * The next `/daily` asks again with the *same* `requestId`, which the game server answers
 * with the first result instead of paying again (it remembers request ids for 15 minutes,
 * RECENT_REQUEST_TTL_MS in its RewardAdminApi.ts). A pending payment older than that can
 * no longer be retried safely, so it is counted as paid rather than risk paying twice.
 *
 * Because the streak only moves on confirmation, a claim made after midnight while the
 * previous night's payment is still pending cannot build on it: the pending payment is
 * settled first.
 *
 * One document per Discord user in `dailyClaims`, next to `packClaims`:
 *   { _id: discordId, lastClaimDay?, streak, totalSigils, lastClaimAtMs, claimId, pending? }
 */

const DAY_MS = 86_400_000;

/** The game server's request-id memory; a retry after this could pay a second time. */
export const DAILY_RETRY_WINDOW_MS = 14 * 60_000;

/**
 * A payment younger than this may still be in flight in another invocation (the reward
 * request waits up to 14 s over two attempts), so it is not retried from here.
 */
export const DAILY_IN_FLIGHT_MS = 30_000;

export type DailyPendingPayment = {
	requestId: string;
	/** The UTC day being claimed. */
	day: number;
	streak: number;
	amount: number;
	userId: number;
	characterName: string;
	startedAtMs: number;
};

export type DailyClaimDocument = {
	_id: string;
	/** Days since the Unix epoch (UTC) of the last confirmed claim; absent before the first. */
	lastClaimDay?: number;
	/** Consecutive days claimed, counting the last confirmed claim. */
	streak: number;
	/** Every Royal Sigil `/daily` has paid this player. */
	totalSigils: number;
	lastClaimAtMs: number;
	/** Changes on every write, so each conditional write knows what it read. */
	claimId: string;
	pending?: DailyPendingPayment;
};

export type DailyState = { lastClaimDay?: number; streak: number };

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

function hasClaimed(state: DailyState | null): state is DailyState & { lastClaimDay: number } {
	return Boolean(state) && Number.isFinite(state!.lastClaimDay);
}

/** The streak a claim made today would reach, or `null` when today is already claimed. */
export function nextDailyStreak(state: DailyState | null, today: number): number | null {
	if (!hasClaimed(state)) return 1;
	if (state.lastClaimDay >= today) return null;
	if (state.lastClaimDay === today - 1) return Math.max(0, Math.floor(state.streak)) + 1;
	return 1;
}

/** The streak the player still holds today: it lapses once a whole UTC day goes unclaimed. */
export function currentDailyStreak(state: DailyState | null, today: number): number {
	if (!hasClaimed(state)) return 0;
	return state.lastClaimDay >= today - 1 ? Math.max(0, Math.floor(state.streak)) : 0;
}

/** What to do about a payment still pending: wait for it, ask again, or count it as paid. */
export function pendingAction(pending: DailyPendingPayment, nowMs: number): "in-flight" | "retry" | "assume-paid" {
	const age = nowMs - pending.startedAtMs;
	if (age < DAILY_IN_FLIGHT_MS) return "in-flight";
	if (age <= DAILY_RETRY_WINDOW_MS) return "retry";
	return "assume-paid";
}

/* ------------------------------------------------------------------
 * Storage
 * ------------------------------------------------------------------ */

type DailyCollection = Pick<Collection<DailyClaimDocument>, "findOne" | "insertOne" | "updateOne">;

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
			// Fail fast: the driver's default 30s stall would outlive the interaction's patience.
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

export type DailyReservation =
	| { status: "reserved"; claimId: string; pending: DailyPendingPayment }
	| { status: "already-claimed"; streak: number; nextClaimAtMs: number }
	/** Another payment is still pending; settle it (`pendingAction`) before claiming. */
	| { status: "pending"; claimId: string; pending: DailyPendingPayment }
	/** Another invocation wrote first; read the state again. */
	| { status: "conflict" };

/**
 * Reserves today's claim for one character, or reports why it cannot. Pays nothing: the
 * caller pays `pending.amount` with `pending.requestId`, then confirms or releases.
 */
export async function reserveDailyClaim(
	discordId: string,
	target: { userId: number; characterName: string },
	nowMs = Date.now(),
): Promise<DailyReservation> {
	const id = discordId.trim();
	if (!id) throw new Error("A Discord id is required to claim the daily reward");
	const collection = await getDailyCollection();
	const today = utcDay(nowMs);
	const nextClaimAtMs = utcDayStartMs(today + 1);

	const current = await collection.findOne({ _id: id });
	if (current?.pending) return { status: "pending", claimId: current.claimId, pending: current.pending };

	const streak = nextDailyStreak(current, today);
	if (streak === null) {
		return { status: "already-claimed", streak: current?.streak ?? 0, nextClaimAtMs };
	}

	const pending: DailyPendingPayment = {
		requestId: randomUUID(),
		day: today,
		streak,
		amount: dailyRewardForStreak(streak),
		userId: target.userId,
		characterName: target.characterName,
		startedAtMs: nowMs,
	};
	const claimId = randomUUID();

	if (!current) {
		try {
			await collection.insertOne({
				_id: id,
				streak: 0,
				totalSigils: 0,
				lastClaimAtMs: 0,
				claimId,
				pending,
			});
		} catch (error) {
			if ((error as { code?: number }).code === 11000) return { status: "conflict" };
			throw error;
		}
		return { status: "reserved", claimId, pending };
	}

	const written = await collection.updateOne(
		{ _id: id, claimId: current.claimId, pending: { $exists: false } },
		{ $set: { claimId, pending } },
	);
	if (written.matchedCount !== 1) return { status: "conflict" };
	return { status: "reserved", claimId, pending };
}

/** The game paid: the day, streak and total move, and the pending payment is cleared. */
export async function confirmDailyClaim(
	discordId: string,
	claim: { claimId: string; pending: DailyPendingPayment },
	nowMs = Date.now(),
): Promise<boolean> {
	const id = discordId.trim();
	const collection = await getDailyCollection();
	const current = await collection.findOne({ _id: id, claimId: claim.claimId });
	if (!current?.pending || current.pending.requestId !== claim.pending.requestId) return false;
	const written = await collection.updateOne(
		{ _id: id, claimId: claim.claimId },
		{
			$set: {
				lastClaimDay: claim.pending.day,
				streak: claim.pending.streak,
				totalSigils: Math.max(0, Math.floor(current.totalSigils ?? 0)) + claim.pending.amount,
				lastClaimAtMs: nowMs,
				claimId: randomUUID(),
			},
			$unset: { pending: "" },
		},
	);
	return written.matchedCount === 1;
}

/** The game paid nothing: the pending payment is dropped and the day can be claimed again. */
export async function releaseDailyClaim(
	discordId: string,
	claim: { claimId: string; pending: DailyPendingPayment },
): Promise<boolean> {
	const id = discordId.trim();
	const collection = await getDailyCollection();
	const written = await collection.updateOne(
		{ _id: id, claimId: claim.claimId, "pending.requestId": claim.pending.requestId },
		{ $set: { claimId: randomUUID() }, $unset: { pending: "" } },
	);
	return written.matchedCount === 1;
}
