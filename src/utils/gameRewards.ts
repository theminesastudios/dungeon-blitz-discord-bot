import { MongoClient, type Collection, type Filter } from "mongodb";
import type { PackReward, PackRewardDeliveryResult } from "./sponsorPacks.js";
import {
	CONSUMABLE_ID_BY_KIND,
	EXCLUSIVE_MOUNT_IDS,
	LEGENDARY_DYE_IDS,
	NON_EXCLUSIVE_MOUNT_IDS,
} from "./sponsorPacks.js";

type RewardDocument = Document & {
	_id: string;
	user_id?: number;
	characters?: Document[];
	updatedAt?: Date;
};

type AccountDocument = Document & {
	_id: string;
	user_id?: number;
	discordId?: string;
};

export type GameSaveCharacterRef = {
	userId: number;
	characterName: string;
};

/** Character option surfaced in the shop's delivery-target picker. */
export type GameCharacterOption = {
	name: string;
	level: number;
	class: string;
	/** The game locks characters the player has not chosen yet; rewards written there are lost. */
	locked?: boolean;
};

/**
 * Thrown when the buyer explicitly picked a character that the game has locked.
 * The purchase stays recorded, so callers surface this and let the player pick
 * another character instead of silently eating the pack.
 */
export class LockedCharacterError extends Error {
	constructor(characterName: string) {
		super(
			`The character "${characterName}" is currently locked in-game. Unlock it (or pick another character) and buy the pack again.`,
		);
		this.name = "LockedCharacterError";
	}
}

/**
 * Resolves the Dungeon Blitz user ID linked to a Discord account, or null.
 */
export async function findGameUserIdForDiscord(discordId: string): Promise<number | null> {
	const normalized = String(discordId ?? "").trim();
	if (!normalized) return null;

	const accounts = await getAccountsCollection();
	const account = await accounts
		.findOne({ discordId: normalized } as Filter<AccountDocument>, { projection: { user_id: 1 } })
		.catch(() => null);
	const userId = normalizeAmount(account?.user_id);
	return userId > 0 ? userId : null;
}

/**
 * Lists the characters on the buyer's game save so the shop can offer a
 * delivery-target picker. Falls back to an empty list when nothing is linked.
 */
export async function listGameSaveCharacters(
	discordId: string,
): Promise<GameCharacterOption[]> {
	const normalized = String(discordId ?? "").trim();
	if (!normalized) return [];

	const accounts = await getAccountsCollection();
	const account = await accounts
		.findOne({ discordId: normalized } as Filter<AccountDocument>, { projection: { user_id: 1 } })
		.catch(() => null);
	const userId = normalizeAmount(account?.user_id);
	if (!userId) return [];

	return listSaveCharactersForUser(userId);
}

/**
 * Named characters on one save document. The game itself writes this document,
 * so the shop must only ever touch the save that belongs to `userId` — never a
 * similarly-named character on someone else's save.
 */
async function listSaveCharactersForUser(userId: number): Promise<GameCharacterOption[]> {
	const saves = await getSavesCollection();
	const save = await saves
		.findOne({ user_id: userId } as Filter<RewardDocument>, { sort: { updatedAt: -1 } })
		.catch(() => null);
	const characters = Array.isArray(save?.characters) ? save!.characters! : [];
	return characters
		.map((character) => {
			const record = character as
				| { name?: unknown; level?: unknown; class?: unknown; locked?: unknown }
				| null;
			const name = String(record?.name ?? "").trim();
			if (!name) return null;
			return {
				name,
				level: normalizeAmount(record?.level),
				class: String(record?.class ?? "").trim(),
				...(record?.locked === true ? { locked: true } : {}),
			};
		})
		.filter((character): character is GameCharacterOption => character !== null);
}

let clientPromise: Promise<MongoClient> | null = null;

/** Kept well inside the interaction function's time budget so a stalled DB surfaces as an error. */
const MONGO_SERVER_SELECTION_TIMEOUT_MS = 5_000;
const MONGO_SOCKET_TIMEOUT_MS = 8_000;

function normalizeAmount(value: unknown): number {
	const amount = Number(value ?? 0);
	return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function getMongoUri(): string {
	const uri = process.env.GAME_MONGODB_URI?.trim() || process.env.MONGODB_URI?.trim();
	if (!uri) throw new Error("GAME_MONGODB_URI or MONGODB_URI is required");
	return uri;
}

async function getClient(): Promise<MongoClient> {
	if (clientPromise) return clientPromise;
	clientPromise = (async () => {
		const client = new MongoClient(getMongoUri(), {
			ignoreUndefined: true,
			// Delivery must fail fast when the save DB is unreachable: an unbounded
			// wait outlives the Discord interaction and hides the error behind a
			// permanent "thinking…" state.
			serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
			connectTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
			socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
		});
		await client.connect();
		return client;
	})().catch((error) => {
		clientPromise = null;
		throw error;
	});
	return clientPromise;
}

async function getAccountsCollection(): Promise<Collection<AccountDocument>> {
	const client = await getClient();
	return client
		.db(
			process.env.GAME_MONGODB_DB_NAME?.trim() ||
				process.env.MONGODB_DB_NAME?.trim() ||
				"minidb",
		)
		.collection<AccountDocument>(
			process.env.MONGODB_ACCOUNTS_COLLECTION?.trim() || "accounts",
		);
}

async function getSavesCollection(): Promise<Collection<RewardDocument>> {
	const client = await getClient();
	return client
		.db(
			process.env.GAME_MONGODB_DB_NAME?.trim() ||
				process.env.MONGODB_DB_NAME?.trim() ||
				"minidb",
		)
		.collection<RewardDocument>(
			process.env.MONGODB_SAVES_COLLECTION?.trim() || "saves",
		);
}

/**
 * Picks the buyer's game character for reward delivery. `userId` comes from the
 * accounts collection matched by Discord ID — the fallback character is always
 * chosen from that player's own save document, never by searching all saves.
 *
 * The game locks characters the player has not chosen yet, so the most recently
 * updated *unlocked* character is preferred; a locked character is only used as
 * a last resort (and delivery onto it is reported as failed).
 */
export async function findDefaultGameSaveCharacter(
	discordId: string,
	knownUserId?: number,
): Promise<GameSaveCharacterRef | null> {
	const normalized = String(discordId ?? "").trim();
	if (!normalized) return null;

	const userId = knownUserId ?? (await findGameUserIdForDiscord(normalized));
	if (!userId) return null;

	const characters = await listSaveCharactersForUser(userId);
	if (characters.length === 0) return null;

	const unlocked = characters.filter((character) => character.locked !== true);
	const pick = unlocked[0] ?? characters[0];
	return { userId, characterName: pick.name };
}

export type PackRewardStripCharacter = {
	name: string;
	removedDyes: number[];
	removedMounts: number[];
	remainingDyes: number[];
	remainingMounts: number[];
};

export type PackRewardStripResult = {
	userId: number;
	characters: PackRewardStripCharacter[];
};

function toNumberArray(value: unknown): number[] {
	return Array.isArray(value)
		? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
		: [];
}

function characterInventory(character: unknown, field: "OwnedDyes" | "mounts"): number[] {
	const record = character as { OwnedDyes?: unknown; mounts?: unknown } | null;
	if (!record) return [];
	return toNumberArray(field === "OwnedDyes" ? record.OwnedDyes : record.mounts);
}

/**
 * Removes the mounts and legendary dyes the pack shop wrote into a save
 * (`applyPackRewardsToSave`), so a test purchase can be undone. Only the ids the
 * shop grants are pulled — anything else the player owns stays untouched.
 *
 * Returns the ids that were actually removed, read back from the save, or null
 * when the Discord account has no game account/save.
 */
export async function stripPackRewards(
	discordId: string,
	characterName?: string,
): Promise<PackRewardStripResult | null> {
	// Read the pack id pools here rather than at module scope: this module and
	// `sponsorPacks` import each other, so a top-level read runs while that
	// module is still evaluating and would spread `undefined`.
	const packDyeIds: number[] = [...LEGENDARY_DYE_IDS];
	const packMountIds: number[] = [
		...NON_EXCLUSIVE_MOUNT_IDS,
		...EXCLUSIVE_MOUNT_IDS,
	];

	const userId = await findGameUserIdForDiscord(discordId);
	if (!userId) return null;

	const saves = await getSavesCollection();
	const save = await saves
		.findOne({ user_id: userId } as Filter<RewardDocument>, { sort: { updatedAt: -1 } })
		.catch(() => null);
	const before = Array.isArray(save?.characters) ? save!.characters! : [];
	if (before.length === 0) return { userId, characters: [] };

	const wanted = characterName?.trim().toLowerCase();
	const names = before
		.map((character) => String((character as { name?: unknown } | null)?.name ?? "").trim())
		.filter((name) => name.length > 0 && (!wanted || name.toLowerCase() === wanted));
	if (names.length === 0) return { userId, characters: [] };

	for (const name of names) {
		await saves.updateOne(
			{ user_id: userId, "characters.name": name } as Filter<RewardDocument>,
			{
				$pull: {
					"characters.$[char].OwnedDyes": { $in: packDyeIds },
					"characters.$[char].mounts": { $in: packMountIds },
				},
				$set: { updatedAt: new Date() },
			} as never,
			{ arrayFilters: [{ "char.name": name }] } as never,
		);
	}

	const characters: PackRewardStripCharacter[] = [];
	for (const name of names) {
		const beforeDyes = characterInventory(
			before.find(
				(character) =>
					String((character as { name?: unknown } | null)?.name ?? "").trim() === name,
			),
			"OwnedDyes",
		);
		const beforeMounts = characterInventory(
			before.find(
				(character) =>
					String((character as { name?: unknown } | null)?.name ?? "").trim() === name,
			),
			"mounts",
		);
		const remainingDyes = beforeDyes.filter((id) => !packDyeIds.includes(id));
		const remainingMounts = beforeMounts.filter((id) => !packMountIds.includes(id));
		characters.push({
			name,
			removedDyes: beforeDyes.filter((id) => !remainingDyes.includes(id)),
			removedMounts: beforeMounts.filter((id) => !remainingMounts.includes(id)),
			remainingDyes,
			remainingMounts,
		});
	}

	return { userId, characters };
}

/** Formats one reward into a short "what you got" line for the shop confirmation. */
export function formatRewardLine(reward: PackReward): string {
	switch (reward.kind) {
		case "mount":
			return reward.mountIds && reward.mountIds.length > 1
				? `${reward.mountIds.length} mounts`
				: `Mount #${reward.mountId}${reward.exclusive ? " (exclusive)" : ""}`;
		case "dye":
			return `Legendary dye #${reward.dyeId}`;
		case "lockbox":
			return `${reward.count.toLocaleString()}× Trove Chest`;
		case "consumable":
			return `${reward.count}× ${reward.consumableId} potion`;
		case "gold":
			return `${reward.amount.toLocaleString()} gold`;
		case "sigils":
			return `${reward.amount.toLocaleString()} Silver Sigils`;
	}
}

type CharacterUpdate = {
	$addToSet?: Record<string, unknown>;
	$push?: Record<string, unknown>;
	$inc?: Record<string, unknown>;
	$set?: Record<string, unknown>;
};

type CharacterUpdateOptions = {
	/** Extra array filters, e.g. a stacked entry selector inside the character. */
	arrayFilters?: Record<string, unknown>[];
	/**
	 * When true, a match with no modification (the entry already existed) counts
	 * as delivered — used by $addToSet rewards that are duplicate-free by design.
	 */
	noopCountsAsDelivered?: boolean;
};

type CharacterUpdateOutcome =
	| "delivered"
	| "character-not-found"
	| "field-missing";

/**
 * Runs one atomic update against the target character using arrayFilters, so a
 * concurrent game-server save can never clobber an unrelated field.
 *
 * The discriminator `"characters.name": characterName` inside the filter is what
 * keeps the write on the buyer's own save: together with the `user_id` match it
 * cannot hit a character of the same name on another player's save.
 */
async function runCharacterUpdate(
	saves: Collection<RewardDocument>,
	userId: number,
	characterName: string,
	update: CharacterUpdate,
	options: CharacterUpdateOptions = {},
): Promise<CharacterUpdateOutcome> {
	const result = await saves.updateOne(
		{ user_id: userId, "characters.name": characterName } as Filter<RewardDocument>,
		{
			...update,
			$set: { ...(update.$set ?? {}), updatedAt: new Date() },
		} as never,
		{ arrayFilters: [{ "char.name": characterName }, ...(options.arrayFilters ?? [])] } as never,
	);
	if (result.matchedCount === 0) return "character-not-found";
	if (result.modifiedCount === 0 && !options.noopCountsAsDelivered) return "field-missing";
	return "delivered";
}

function outcomeError(outcome: Exclude<CharacterUpdateOutcome, "delivered">): string {
	switch (outcome) {
		case "character-not-found":
			return "Character not found in the game save.";
		case "field-missing":
			return "The character's save does not have this inventory field yet — play once more in-game, then claim the pack again.";
	}
}

function fail(
	reward: PackReward,
	characterName: string,
	error: string,
): PackRewardDeliveryResult {
	return { status: "failed", delivery: { reward, characterName }, error };
}

/**
 * Writes every reward into the target character's save document using atomic
 * per-field updates. Every reward is attempted independently so one failure
 * does not block the rest.
 */
export async function applyPackRewardsToSave(
	userId: number,
	characterName: string,
	rewards: PackReward[],
): Promise<PackRewardDeliveryResult[]> {
	const saves = await getSavesCollection();
	const results: PackRewardDeliveryResult[] = [];

	for (const reward of rewards) {
		try {
			results.push(await applySingleReward(saves, userId, characterName, reward));
		} catch (error) {
			results.push({
				status: "failed",
				delivery: { reward, characterName },
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

async function applySingleReward(
	saves: Collection<RewardDocument>,
	userId: number,
	characterName: string,
	reward: PackReward,
): Promise<PackRewardDeliveryResult> {
	switch (reward.kind) {
		case "mount": {
			// $addToSet keeps the mount list duplicate-free even if the game client
			// already granted the same mount.
			const mountIds = reward.mountIds ?? [reward.mountId];
			const outcome = await runCharacterUpdate(
				saves,
				userId,
				characterName,
				{ $addToSet: { "characters.$[char].mounts": { $each: mountIds } } },
				{ noopCountsAsDelivered: true },
			);
			if (outcome !== "delivered") {
				return fail(reward, characterName, outcomeError(outcome));
			}
			break;
		}
		case "dye": {
			const outcome = await runCharacterUpdate(
				saves,
				userId,
				characterName,
				{ $addToSet: { "characters.$[char].OwnedDyes": reward.dyeId } },
				{ noopCountsAsDelivered: true },
			);
			if (outcome !== "delivered") {
				return fail(reward, characterName, outcomeError(outcome));
			}
			break;
		}
		case "lockbox": {
			const outcome = await bumpStackedEntry(
				saves,
				userId,
				characterName,
				"lockboxes",
				"lockboxID",
				reward.lockboxId,
				reward.count,
			);
			if (outcome !== "delivered") {
				return fail(reward, characterName, outcomeError(outcome));
			}
			break;
		}
		case "consumable": {
			const consumableId = CONSUMABLE_ID_BY_KIND[reward.consumableId];
			const outcome = await bumpStackedEntry(
				saves,
				userId,
				characterName,
				"consumables",
				"consumableID",
				consumableId,
				reward.count,
			);
			if (outcome !== "delivered") {
				return fail(reward, characterName, outcomeError(outcome));
			}
			break;
		}
		case "gold": {
			const outcome = await runCharacterUpdate(saves, userId, characterName, {
				$inc: { "characters.$[char].gold": reward.amount },
			});
			if (outcome !== "delivered") {
				return fail(reward, characterName, outcomeError(outcome));
			}
			break;
		}
		case "sigils": {
			const outcome = await runCharacterUpdate(saves, userId, characterName, {
				$inc: { "characters.$[char].SilverSigils": reward.amount },
			});
			if (outcome !== "delivered") {
				return fail(reward, characterName, outcomeError(outcome));
			}
			break;
		}
	}

	return { status: "delivered", delivery: { reward, characterName } };
}

/**
 * Adds `count` to a stacked array entry such as lockboxes/consumables. Tries an
 * atomic $inc on the matching entry first; when the character does not own that
 * stack yet (modifiedCount 0 despite a match), upserts the entry by pushing it
 * with the full count, or creates the array itself when the character has none.
 */
async function bumpStackedEntry(
	saves: Collection<RewardDocument>,
	userId: number,
	characterName: string,
	field: "lockboxes" | "consumables",
	idField: "lockboxID" | "consumableID",
	entryId: number,
	count: number,
): Promise<CharacterUpdateOutcome> {
	const increment = await runCharacterUpdate(
		saves,
		userId,
		characterName,
		{ $inc: { [`characters.$[char].${field}.$[entry].count`]: count } },
		{ arrayFilters: [{ [`entry.${idField}`]: entryId }] },
	);
	if (increment !== "field-missing") return increment;

	// The character exists but does not own this stack yet — create it.
	const push = await runCharacterUpdate(
		saves,
		userId,
		characterName,
		{ $push: { [`characters.$[char].${field}`]: { [idField]: entryId, count } } },
	);
	if (push !== "field-missing") return push;

	// The character has no array at all (e.g. a brand-new save) — create it.
	const create = await runCharacterUpdate(
		saves,
		userId,
		characterName,
		{ $set: { [`characters.$[char].${field}`]: [{ [idField]: entryId, count }] } },
	);
	return create;
}
