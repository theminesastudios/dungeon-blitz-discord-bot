import { MongoClient, type Collection } from "mongodb";

/**
 * `/daily`: claimable once every 24 hours, paid in Royal Sigils, growing with the streak.
 *
 *   1st day → 1, 2nd → 2, 3rd → 3, …
 *
 * The clock is real time from the player's own last claim, not a shared daily reset: the
 * next claim opens 24 hours after the last one, and the streak continues if it is made
 * within 48 hours of it; later than that, it starts over at 1.
 *
 * One document per Discord user in `dailyClaims`, next to `packClaims`:
 *   { _id: discordId, lastClaimAtMs, streak, totalSigils }
 */

export const DAILY_COOLDOWN_MS = 24 * 3_600_000;
/** The streak is kept when the next claim comes within this long of the last one. */
export const DAILY_STREAK_WINDOW_MS = 48 * 3_600_000;

export type DailyClaimDocument = {
	_id: string;
	lastClaimAtMs: number;
	streak: number;
	totalSigils: number;
};

/** Royal Sigils for the `streak`-th day in a row: one per day of the streak. */
export function dailyRewardForStreak(streak: number): number {
	return Math.max(1, Math.floor(streak));
}

/** The streak a claim made now reaches, or `null` while the 24 hours are not up. */
export function nextDailyStreak(state: DailyClaimDocument | null, nowMs: number): number | null {
	if (!state) return 1;
	const since = nowMs - state.lastClaimAtMs;
	if (since < DAILY_COOLDOWN_MS) return null;
	return since <= DAILY_STREAK_WINDOW_MS ? Math.max(0, Math.floor(state.streak)) + 1 : 1;
}

type DailyCollection = Pick<Collection<DailyClaimDocument>, "findOne" | "insertOne" | "updateOne" | "deleteOne">;

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
		clientPromise = new MongoClient(uri, {
			ignoreUndefined: true,
			serverSelectionTimeoutMS: 5_000,
			connectTimeoutMS: 5_000,
			socketTimeoutMS: 10_000,
		})
			.connect()
			.catch((error) => {
				clientPromise = null;
				throw error;
			});
	}
	return (await clientPromise)
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<DailyClaimDocument>("dailyClaims");
}

export type DailyClaim =
	| { status: "claimed"; streak: number; reward: number; previous: DailyClaimDocument | null; claimedAtMs: number }
	| { status: "cooldown"; streak: number; nextClaimAtMs: number };

/**
 * Records a claim now, or reports when the next one opens. The write is conditional on the
 * document still being what was read, so two clicks at once record (and pay) only one claim.
 */
export async function recordDailyClaim(discordId: string, nowMs = Date.now()): Promise<DailyClaim> {
	const id = discordId.trim();
	if (!id) throw new Error("A Discord id is required to claim the daily reward");
	const collection = await getDailyCollection();
	const previous = await collection.findOne({ _id: id });
	const streak = nextDailyStreak(previous, nowMs);
	const cooldown = (state: DailyClaimDocument | null): DailyClaim => ({
		status: "cooldown",
		streak: state?.streak ?? 0,
		nextClaimAtMs: (state?.lastClaimAtMs ?? nowMs) + DAILY_COOLDOWN_MS,
	});
	if (streak === null) return cooldown(previous);

	const reward = dailyRewardForStreak(streak);
	const next = { lastClaimAtMs: nowMs, streak, totalSigils: (previous?.totalSigils ?? 0) + reward };
	if (!previous) {
		try {
			await collection.insertOne({ _id: id, ...next });
		} catch (error) {
			if ((error as { code?: number }).code === 11000) return cooldown(await collection.findOne({ _id: id }));
			throw error;
		}
	} else {
		const written = await collection.updateOne(
			{ _id: id, lastClaimAtMs: previous.lastClaimAtMs },
			{ $set: next },
		);
		if (written.matchedCount !== 1) return cooldown(await collection.findOne({ _id: id }));
	}
	return { status: "claimed", streak, reward, previous, claimedAtMs: nowMs };
}

/** Undoes a claim the game server refused to pay, so the player can claim again now. */
export async function undoDailyClaim(
	discordId: string,
	claim: Extract<DailyClaim, { status: "claimed" }>,
): Promise<boolean> {
	const id = discordId.trim();
	const collection = await getDailyCollection();
	if (!claim.previous) {
		return (await collection.deleteOne({ _id: id, lastClaimAtMs: claim.claimedAtMs })).deletedCount === 1;
	}
	const { _id, ...fields } = claim.previous;
	const written = await collection.updateOne({ _id: id, lastClaimAtMs: claim.claimedAtMs }, { $set: fields });
	return written.matchedCount === 1;
}
