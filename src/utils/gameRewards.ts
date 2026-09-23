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
	const save = await resolveSaveDocument(saves, userId);
	const characters = save?.characters ?? [];
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

/**
 * The buyer's save document, resolved once per operation.
 *
 * Every read and write in this module goes through this handle. Matching writes on `user_id`
 * alone would let a second document that carries the same `user_id` — a legacy or duplicate
 * save — satisfy the write while the shop reported success, which reads to the player as "the
 * pack took my credit and delivered nothing". Addressing the exact `_id` we read makes that
 * impossible: either the character we listed is updated, or the write fails loudly.
 */
type SaveDocumentHandle = {
	id: RewardDocument["_id"];
	characters: Document[];
};

async function resolveSaveDocument(
	saves: Collection<RewardDocument>,
	userId: number,
): Promise<SaveDocumentHandle | null> {
	const save = await saves
		.findOne({ user_id: userId } as Filter<RewardDocument>, { sort: { updatedAt: -1 } })
		.catch(() => null);
	if (!save) return null;
	return {
		id: save._id,
		characters: Array.isArray(save.characters) ? save.characters : [],
	};
}

/** The character entry inside a save document, matched the way the database matches it. */
function findCharacter(
	characters: readonly Document[],
	characterName: string,
): Document | null {
	const wanted = characterName.trim();
	const found = characters.find(
		(character) => String((character as { name?: unknown }).name ?? "").trim() === wanted,
	);
	return (found as Document | undefined) ?? null;
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
	const save = await resolveSaveDocument(saves, userId);
	const before = save?.characters ?? [];
	if (!save || before.length === 0) return { userId, characters: [] };

	const wanted = characterName?.trim().toLowerCase();
	const names = before
		.map((character) => String((character as { name?: unknown } | null)?.name ?? "").trim())
		.filter((name) => name.length > 0 && (!wanted || name.toLowerCase() === wanted));
	if (names.length === 0) return { userId, characters: [] };

	for (const name of names) {
		await saves.updateOne(
			{ _id: save.id, "characters.name": name } as Filter<RewardDocument>,
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

/**
 * Runs one atomic update against the target character using arrayFilters, so a
 * concurrent game-server save can never clobber an unrelated field.
 *
 * The write is addressed by the save document's own `_id` plus the character name, so it can
 * only land on the document the shop read from and on the buyer's own character.
 */
async function runCharacterUpdate(
	saves: Collection<RewardDocument>,
	saveId: RewardDocument["_id"],
	characterName: string,
	update: CharacterUpdate,
	options: { arrayFilters?: Record<string, unknown>[] } = {},
): Promise<"written" | "character-not-found"> {
	const result = await saves.updateOne(
		{ _id: saveId, "characters.name": characterName } as Filter<RewardDocument>,
		{
			...update,
			$set: { ...(update.$set ?? {}), updatedAt: new Date() },
		} as never,
		{ arrayFilters: [{ "char.name": characterName }, ...(options.arrayFilters ?? [])] } as never,
	);
	return result.matchedCount === 0 ? "character-not-found" : "written";
}

const CHARACTER_GONE = "Character not found in the save document the shop writes to.";

function fail(
	reward: PackReward,
	characterName: string,
	error: string,
	saveId?: string,
	verified?: string,
): PackRewardDeliveryResult {
	return {
		status: "failed",
		delivery: { reward, characterName },
		error,
		...(saveId ? { saveId } : {}),
		...(verified ? { verified } : {}),
	};
}

function numberField(character: Document | null, field: string): number {
	const value = Number((character as Record<string, unknown> | null)?.[field] ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function stackCount(
	character: Document | null,
	field: "lockboxes" | "consumables",
	idField: "lockboxID" | "consumableID",
	entryId: number,
): number {
	const entries = (character as Record<string, unknown> | null)?.[field];
	if (!Array.isArray(entries)) return 0;
	const entry = entries.find(
		(candidate) => Number((candidate as Record<string, unknown> | null)?.[idField] ?? NaN) === entryId,
	);
	const count = Number((entry as Record<string, unknown> | undefined)?.count ?? 0);
	return Number.isFinite(count) ? count : 0;
}

/** The result of comparing the save before and after a reward write. */
export type RewardVerification = {
	/** True only when the value the reward promised is present in the save. */
	ok: boolean;
	/** What the affected field reads now, for the operator log. */
	detail: string;
	/** Set when the value is provably absent from the save. */
	error?: string;
};

function checkIdsAdded(
	field: string,
	beforeIds: number[],
	afterIds: number[],
	wanted: number[],
): RewardVerification {
	const missing = wanted.filter((id) => !afterIds.includes(id));
	if (missing.length > 0) {
		return {
			ok: false,
			detail: `${field}: ${afterIds.join(", ") || "empty"}`,
			error: `"${field}" is missing ${missing.join(", ")} after the write — the save update did not persist.`,
		};
	}
	const added = wanted.filter((id) => !beforeIds.includes(id));
	return {
		ok: true,
		detail:
			added.length > 0
				? `${field} +${added.join(", ")}`
				: `${field} already owned (${wanted.join(", ")})`,
	};
}

function checkGain(
	field: string,
	beforeValue: number,
	afterValue: number,
	amount: number,
): RewardVerification {
	if (afterValue >= beforeValue + amount) {
		return {
			ok: true,
			detail: `${field} ${beforeValue.toLocaleString()} → ${afterValue.toLocaleString()}`,
		};
	}
	return {
		ok: false,
		detail: `${field}: ${afterValue.toLocaleString()}`,
		error: `"${field}" reads ${afterValue.toLocaleString()} after adding ${amount.toLocaleString()} to ${beforeValue.toLocaleString()} — the save update did not persist.`,
	};
}

/**
 * Compares what one reward promised against the save read back afterwards.
 *
 * MongoDB answers for the write it accepted, not for what the game will keep, and a duplicate
 * or legacy save document can absorb an update that the player never sees. This is the check
 * that turns "credit gone, nothing delivered" from a silent outcome into a reported failure
 * (and, because nothing landed, an automatic refund).
 */
export function verifyRewardDelivery(
	reward: PackReward,
	before: Document | null,
	after: Document | null,
): RewardVerification {
	switch (reward.kind) {
		case "mount": {
			const mountIds = reward.mountIds ?? [reward.mountId];
			return checkIdsAdded(
				"mounts",
				toNumberArray((before as { mounts?: unknown } | null)?.mounts),
				toNumberArray((after as { mounts?: unknown } | null)?.mounts),
				mountIds,
			);
		}
		case "dye":
			return checkIdsAdded(
				"OwnedDyes",
				toNumberArray((before as { OwnedDyes?: unknown } | null)?.OwnedDyes),
				toNumberArray((after as { OwnedDyes?: unknown } | null)?.OwnedDyes),
				[reward.dyeId],
			);
		case "gold":
			return checkGain(
				"gold",
				numberField(before, "gold"),
				numberField(after, "gold"),
				reward.amount,
			);
		case "sigils":
			return checkGain(
				"SilverSigils",
				numberField(before, "SilverSigils"),
				numberField(after, "SilverSigils"),
				reward.amount,
			);
		case "lockbox":
			return checkGain(
				`lockboxes[${reward.lockboxId}]`,
				stackCount(before, "lockboxes", "lockboxID", reward.lockboxId),
				stackCount(after, "lockboxes", "lockboxID", reward.lockboxId),
				reward.count,
			);
		case "consumable":
			return checkGain(
				`consumables[${CONSUMABLE_ID_BY_KIND[reward.consumableId]}]`,
				stackCount(before, "consumables", "consumableID", CONSUMABLE_ID_BY_KIND[reward.consumableId]),
				stackCount(after, "consumables", "consumableID", CONSUMABLE_ID_BY_KIND[reward.consumableId]),
				reward.count,
			);
	}
}

/** Reads one character back out of a save document, to confirm what a write left behind. */
async function readSaveCharacter(
	saves: Collection<RewardDocument>,
	saveId: RewardDocument["_id"],
	characterName: string,
): Promise<Document | null> {
	const save = await saves.findOne({ _id: saveId } as Filter<RewardDocument>, {
		projection: { characters: 1 },
	});
	return findCharacter(Array.isArray(save?.characters) ? save!.characters! : [], characterName);
}

/**
 * Writes every reward into the target character's save document, then reads the character back
 * and reports each reward as delivered only if its value is really there.
 *
 * Every reward is attempted independently so one failure does not block the rest. A write that
 * MongoDB accepts but the save does not show is reported as failed — for the shop that means an
 * automatic refund instead of a charge for rewards nobody can find.
 */
export async function applyPackRewardsToSave(
	userId: number,
	characterName: string,
	rewards: PackReward[],
): Promise<PackRewardDeliveryResult[]> {
	const saves = await getSavesCollection();
	const save = await resolveSaveDocument(saves, userId);
	if (!save) {
		return rewards.map((reward) =>
			fail(
				reward,
				characterName,
				"No game save exists for this player yet — play once in-game, then claim the pack again.",
			),
		);
	}

	const saveId = String(save.id);
	const before = findCharacter(save.characters, characterName);
	if (!before) {
		return rewards.map((reward) =>
			fail(
				reward,
				characterName,
				`Character "${characterName}" is not in the save document the shop writes to.`,
				saveId,
			),
		);
	}

	// Each write is independent: one failing reward must not block the others.
	const writeErrors = new Map<PackReward, string>();
	for (const reward of rewards) {
		try {
			const error = await applySingleReward(saves, save.id, characterName, reward);
			if (error) writeErrors.set(reward, error);
		} catch (error) {
			writeErrors.set(reward, error instanceof Error ? error.message : String(error));
		}
	}

	let after: Document | null = null;
	let readBackError: string | null = null;
	try {
		after = await readSaveCharacter(saves, save.id, characterName);
	} catch (error) {
		readBackError = error instanceof Error ? error.message : String(error);
	}

	return rewards.map((reward) => {
		const writeError = writeErrors.get(reward);
		if (writeError) return fail(reward, characterName, writeError, saveId);

		if (readBackError) {
			// The read-back itself failed, which is not evidence that the reward was lost: keep the
			// write's answer and carry the doubt into the operator log rather than refunding a
			// delivery that probably landed.
			return {
				status: "delivered" as const,
				delivery: { reward, characterName },
				saveId,
				verified: `unverified: ${readBackError}`,
			};
		}
		if (after === null) {
			return fail(
				reward,
				characterName,
				"The character disappeared from the save while the pack was being delivered.",
				saveId,
			);
		}

		const verification = verifyRewardDelivery(reward, before, after);
		if (!verification.ok) {
			return fail(
				reward,
				characterName,
				`${verification.error} (save ${saveId})`,
				saveId,
				verification.detail,
			);
		}
		return {
			status: "delivered" as const,
			delivery: { reward, characterName },
			saveId,
			verified: verification.detail,
		};
	});
}

/** Returns an error message when the write could not be placed, or null when it was accepted. */
async function applySingleReward(
	saves: Collection<RewardDocument>,
	saveId: RewardDocument["_id"],
	characterName: string,
	reward: PackReward,
): Promise<string | null> {
	switch (reward.kind) {
		case "mount": {
			// $addToSet keeps the mount list duplicate-free even if the game client
			// already granted the same mount.
			const mountIds = reward.mountIds ?? [reward.mountId];
			const outcome = await runCharacterUpdate(saves, saveId, characterName, {
				$addToSet: { "characters.$[char].mounts": { $each: mountIds } },
			});
			return outcome === "written" ? null : CHARACTER_GONE;
		}
		case "dye": {
			const outcome = await runCharacterUpdate(saves, saveId, characterName, {
				$addToSet: { "characters.$[char].OwnedDyes": reward.dyeId },
			});
			return outcome === "written" ? null : CHARACTER_GONE;
		}
		case "lockbox":
			return bumpStackedEntry(
				saves,
				saveId,
				characterName,
				"lockboxes",
				"lockboxID",
				reward.lockboxId,
				reward.count,
			);
		case "consumable":
			return bumpStackedEntry(
				saves,
				saveId,
				characterName,
				"consumables",
				"consumableID",
				CONSUMABLE_ID_BY_KIND[reward.consumableId],
				reward.count,
			);
		case "gold": {
			const outcome = await runCharacterUpdate(saves, saveId, characterName, {
				$inc: { "characters.$[char].gold": reward.amount },
			});
			return outcome === "written" ? null : CHARACTER_GONE;
		}
		case "sigils": {
			const outcome = await runCharacterUpdate(saves, saveId, characterName, {
				$inc: { "characters.$[char].SilverSigils": reward.amount },
			});
			return outcome === "written" ? null : CHARACTER_GONE;
		}
	}
}

/**
 * Adds `count` to a stacked array entry such as lockboxes/consumables.
 *
 * Incrementing through `$[entry]` requires the entry **and its array** to already exist —
 * MongoDB raises a path error rather than reporting "no match" — so the increment is attempted
 * first and a `$push` (which creates the array itself) is the fallback. The delivery check reads
 * the count back afterwards, so a stack that was not created is reported instead of assumed.
 */
async function bumpStackedEntry(
	saves: Collection<RewardDocument>,
	saveId: RewardDocument["_id"],
	characterName: string,
	field: "lockboxes" | "consumables",
	idField: "lockboxID" | "consumableID",
	entryId: number,
	count: number,
): Promise<string | null> {
	try {
		const outcome = await runCharacterUpdate(
			saves,
			saveId,
			characterName,
			{ $inc: { [`characters.$[char].${field}.$[entry].count`]: count } },
			{ arrayFilters: [{ [`entry.${idField}`]: entryId }] },
		);
		if (outcome === "character-not-found") return CHARACTER_GONE;
	} catch (error) {
		// No such stack on this character yet: the increment cannot traverse it, so create it.
		console.warn(
			`[gameRewards] Could not increment ${field}[${entryId}] on ${characterName}; creating the stack instead.`,
			error instanceof Error ? error.message : String(error),
		);
		const pushed = await runCharacterUpdate(saves, saveId, characterName, {
			$push: { [`characters.$[char].${field}`]: { [idField]: entryId, count } },
		});
		return pushed === "written" ? null : CHARACTER_GONE;
	}
	return null;
}
