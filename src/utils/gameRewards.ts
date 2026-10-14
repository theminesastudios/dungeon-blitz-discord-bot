import { randomUUID } from "node:crypto";
import { MongoClient, type Collection, type Filter } from "mongodb";
import type { PackReward, PackRewardDeliveryResult } from "./sponsorPacks.js";
import {
	CONSUMABLE_ID_BY_KIND,
	EXCLUSIVE_MOUNT_IDS,
	LEGENDARY_DYE_IDS,
	NON_EXCLUSIVE_MOUNT_IDS,
} from "./sponsorPacks.js";
import { dyeLabel, mountLabel } from "./gameItemNames.js";
import { postGameServerAdmin, type GameServerAdminResponse } from "./gameMaintenance.js";

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
 * Every Mongo read in this module goes through this handle, and so does the one write left
 * (`stripPackRewards`). Matching on `user_id` alone would let a second document that carries
 * the same `user_id` — a legacy or duplicate save — answer instead. Rewards themselves are
 * paid through the game server (`applyPackRewardsToSave`), never written here.
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
 * Removes the mounts and legendary dyes the pack shop can grant from a save
 * (`applyPackRewardsToSave`), so a test purchase can be undone. It removes every id
 * in the pack pools whether the shop wrote it or not: the pools cover every
 * idol-buyable mount and every legendary dye, so a mount the player bought with
 * idols goes too. Only mounts that cannot be bought stay.
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

const CONSUMABLE_NAMES: Record<keyof typeof CONSUMABLE_ID_BY_KIND, string> = {
	exp: "EXP Potion",
	gear: "Gear Potion",
	gold: "Gold Potion",
	material: "Material Potion",
};

/**
 * Formats one reward into a short "what you got" line for the shop confirmation and the
 * operator log. Mounts and dyes are named through the shared registry, so a purchase reads
 * "Skybone Wyrm" rather than "Mount #81" once the game has reported its names.
 */
export function formatRewardLine(reward: PackReward): string {
	switch (reward.kind) {
		case "mount":
			return reward.mountIds && reward.mountIds.length > 1
				? `${reward.mountIds.length} mounts`
				: `${mountLabel(reward.mountId)}${reward.exclusive ? " (exclusive)" : ""}`;
		case "dye":
			return dyeLabel(reward.dyeId);
		case "lockbox":
			return `${reward.count.toLocaleString()}× Trove Chest`;
		case "consumable":
			return `${reward.count.toLocaleString()}× ${CONSUMABLE_NAMES[reward.consumableId]}`;
		case "gold":
			return `${reward.amount.toLocaleString()} gold`;
		case "sigils":
			return `${reward.amount.toLocaleString()} Silver Sigils`;
		case "keys":
			return `${reward.amount.toLocaleString()}× Trove Key`;
	}
}


/* ------------------------------------------------------------------
 * Delivery through the game server
 *
 * Rewards used to be written into the `saves` collection directly. The game server keeps its
 * local JSON save as the live copy and overwrites Mongo's `characters` with it on every backup,
 * so those writes were thrown away: the shop said "delivered" and the player had nothing. Like
 * idol adjustments and character rename/delete, rewards now go through the game server, which
 * changes the live character when the player is online and the stored save when not.
 *
 *   POST /api/admin/rewards { userId, characterName, rewards, requestedBy, requestId, allowLocked? }
 *     200 { ok: true, userId, characterName, online, onlineRecipients, results }
 *
 * Each result is `{ kind, field, operation, status, before, after }`, status `applied`,
 * `unchanged` or `insufficient`. A `gearSet` result also carries `total` (the pieces the class has
 * at that tier), and an `xp` result `levelBefore` / `levelAfter`. A refusal is `{ error, code }`,
 * code `no-save`, `not-found`, `locked`, `held-elsewhere` or `invalid-request`.
 * ------------------------------------------------------------------ */

/** Currency fields a grant can adjust, as they are spelled in the save document. */
export type CurrencyField =
	| "gold"
	| "mammothIdols"
	| "DragonKeys"
	| "DragonOre"
	| "SilverSigils"
	| "RoyalSigils"
	| "xp";

/** Gear tiers staff can grant a whole class set at: 0 Magic, 1 Rare, 2 Legendary. */
export type GearSetTier = 0 | 1 | 2;
/** Material rarities a material set covers; `all` is every material. */
export type MaterialRarity = "M" | "R" | "L" | "all";

export type GameRewardOperation = "add" | "remove";

/** One reward as the game server's `/api/admin/rewards` reads it. */
export type GameRewardChange = (
	| { kind: "mount"; mountIds: number[] }
	| { kind: "dye"; dyeId: number }
	| { kind: "lockbox"; lockboxId: number; count: number }
	| { kind: "consumable"; consumableID: number; count: number }
	| { kind: "gold" | "sigils" | "keys" | "ore" | "royalSigils" | "xp"; amount: number }
	/** Every gear piece the character's class has at `tier`; the game resolves the ids. */
	| { kind: "gearSet"; tier: GearSetTier }
	/** `count` of every material of `rarity`; the game resolves the ids. */
	| { kind: "materialSet"; rarity: MaterialRarity; count: number }
) & { operation?: GameRewardOperation };

export type GameRewardResult = {
	kind: string;
	field: string;
	operation: GameRewardOperation;
	status: "applied" | "unchanged" | "insufficient";
	before: number;
	after: number;
	/** gearSet: how many pieces the class has at that tier. */
	total?: number;
	/** xp: the character's level before and after. */
	levelBefore?: number;
	levelAfter?: number;
};

export type GameRewardsRefusal =
	| "no-save"
	| "not-found"
	| "locked"
	| "held-elsewhere"
	| "invalid-request"
	| "unavailable";

export type GameRewardsOutcome =
	| {
			ok: true;
			userId: number;
			characterName: string;
			/** The character was in play (or between levels), so the live copy took the rewards. */
			online: boolean;
			results: GameRewardResult[];
	  }
	| { ok: false; refusal: GameRewardsRefusal; message: string };

const KNOWN_REFUSALS = new Set<GameRewardsRefusal>([
	"no-save",
	"not-found",
	"locked",
	"held-elsewhere",
	"invalid-request",
]);

/** First try, then one retry after a timeout: the retry carries the same requestId, so it pays once. */
const REWARD_TIMEOUTS_MS = [8_000, 6_000];

/** A pack reward in the shape the game server reads. */
export function toGameRewardChange(reward: PackReward): GameRewardChange {
	switch (reward.kind) {
		case "mount":
			return { kind: "mount", mountIds: reward.mountIds ?? [reward.mountId] };
		case "dye":
			return { kind: "dye", dyeId: reward.dyeId };
		case "lockbox":
			return { kind: "lockbox", lockboxId: reward.lockboxId, count: reward.count };
		case "consumable":
			return {
				kind: "consumable",
				consumableID: CONSUMABLE_ID_BY_KIND[reward.consumableId],
				count: reward.count,
			};
		case "gold":
		case "sigils":
		case "keys":
			return { kind: reward.kind, amount: reward.amount };
	}
}

/**
 * Asks the game server to pay `rewards` to one character. Never throws: an unreachable server
 * or a route it does not have yet is the `unavailable` refusal, and nothing was paid then.
 */
export async function requestGameRewards(input: {
	userId: number;
	characterName: string;
	rewards: GameRewardChange[];
	requestedBy: string;
	allowLocked?: boolean;
}): Promise<GameRewardsOutcome> {
	const body = { ...input, requestId: randomUUID() };
	let lastError: unknown = null;
	for (const timeoutMs of REWARD_TIMEOUTS_MS) {
		let response: GameServerAdminResponse;
		try {
			response = await postGameServerAdmin("/api/admin/rewards", body, timeoutMs);
		} catch (error) {
			// A timeout may have paid already; the retry's requestId answers with that payment.
			lastError = error;
			continue;
		}

		const answer = response.payload as Record<string, unknown> | null;
		if (response.status >= 200 && response.status < 300 && answer?.ok === true) {
			return {
				ok: true,
				userId: normalizeAmount(answer.userId) || input.userId,
				characterName: String(answer.characterName ?? input.characterName),
				online: answer.online === true,
				results: Array.isArray(answer.results) ? (answer.results as GameRewardResult[]) : [],
			};
		}
		const code = String(answer?.code ?? "") as GameRewardsRefusal;
		const error = typeof answer?.error === "string" ? answer.error : "";
		if (KNOWN_REFUSALS.has(code)) {
			return { ok: false, refusal: code, message: error || code };
		}
		console.error(`[gameRewards] /api/admin/rewards answered ${response.status}:`, answer ?? response.rawBody.slice(0, 200));
		return {
			ok: false,
			refusal: "unavailable",
			message:
				response.status === 404 && !answer
					? "The game server cannot take reward deliveries yet (it has no /api/admin/rewards route)."
					: `The game server could not deliver the rewards (${response.status}${error ? `: ${error}` : ""}).`,
		};
	}
	console.error("[gameRewards] /api/admin/rewards could not be reached:", lastError);
	return {
		ok: false,
		refusal: "unavailable",
		message: "The game server could not be reached, so nothing was delivered.",
	};
}

function fail(reward: PackReward, characterName: string, error: string, verified?: string): PackRewardDeliveryResult {
	return {
		status: "failed",
		delivery: { reward, characterName },
		error,
		...(verified ? { verified } : {}),
	};
}

function listIds(reward: PackReward): number[] | null {
	if (reward.kind === "mount") return reward.mountIds ?? [reward.mountId];
	if (reward.kind === "dye") return [reward.dyeId];
	return null;
}

function rewardAmount(reward: PackReward): number {
	if (reward.kind === "lockbox" || reward.kind === "consumable") return reward.count;
	if (reward.kind === "gold" || reward.kind === "sigils" || reward.kind === "keys") return reward.amount;
	return 0;
}

/**
 * Turns the game server's per-reward answer into the shop's delivery results.
 *
 * A reward is delivered only when the value it promised is there afterwards: every mount or dye
 * owned, or the count up by at least the amount. That is what turns "credit gone, nothing
 * delivered" into a reported failure (and, when nothing landed, an automatic refund).
 */
export function deliveryResultsFromGame(
	rewards: PackReward[],
	characterName: string,
	results: GameRewardResult[],
	online = false,
): PackRewardDeliveryResult[] {
	const where = online ? " (live)" : "";
	return rewards.map((reward, index) => {
		const result = results[index];
		if (!result) {
			return fail(reward, characterName, "The game server did not answer for this reward.");
		}
		const before = normalizeAmount(result.before);
		const after = normalizeAmount(result.after);
		if (result.status === "insufficient") {
			return fail(reward, characterName, `The game server refused "${result.field}".`, `${result.field}: ${after.toLocaleString()}`);
		}

		const ids = listIds(reward);
		if (ids) {
			if (after < ids.length) {
				return fail(
					reward,
					characterName,
					`"${result.field}" holds ${after} of ${ids.length} after the delivery — the reward did not land.`,
					`${result.field}: ${after}/${ids.length}`,
				);
			}
			return {
				status: "delivered",
				delivery: { reward, characterName },
				verified:
					before >= ids.length
						? `${result.field} already owned (${ids.join(", ")})${where}`
						: `${result.field} +${ids.join(", ")}${where}`,
			};
		}

		const amount = rewardAmount(reward);
		if (after < before + amount) {
			return fail(
				reward,
				characterName,
				`"${result.field}" reads ${after.toLocaleString()} after adding ${amount.toLocaleString()} to ${before.toLocaleString()} — the reward did not land.`,
				`${result.field}: ${after.toLocaleString()}`,
			);
		}
		return {
			status: "delivered",
			delivery: { reward, characterName },
			verified: `${result.field} ${before.toLocaleString()} → ${after.toLocaleString()}${where}`,
		};
	});
}

const REFUSAL_REASONS: Record<Exclude<GameRewardsRefusal, "locked">, (characterName: string) => string> = {
	"no-save": () => "No game save exists for this player yet — play once in-game, then claim the pack again.",
	"not-found": (characterName) => `Character "${characterName}" is not on your game save.`,
	"held-elsewhere": () =>
		"You are signed in on another game server right now. Log out completely, then claim the pack again.",
	"invalid-request": () => "The game server did not accept this pack's rewards.",
	unavailable: () => "The game server could not be reached, so nothing was delivered.",
};

/**
 * Delivers every reward to the target character through the game server, and reports each one
 * as delivered only if the server shows its value afterwards.
 *
 * Every reward is paid in one request, so an online player gets the whole pack at once. A refusal
 * fails every reward — for the shop that means an automatic refund instead of a charge for
 * rewards nobody can find. A locked character throws `LockedCharacterError`, as the shop's own
 * check does.
 */
export async function applyPackRewardsToSave(
	userId: number,
	characterName: string,
	rewards: PackReward[],
	requestedBy = "pack-shop",
): Promise<PackRewardDeliveryResult[]> {
	const outcome = await requestGameRewards({
		userId,
		characterName,
		rewards: rewards.map(toGameRewardChange),
		requestedBy,
	});
	if (!outcome.ok) {
		if (outcome.refusal === "locked") throw new LockedCharacterError(characterName);
		const reason = REFUSAL_REASONS[outcome.refusal](characterName);
		const detail = outcome.refusal === "unavailable" ? outcome.message : reason;
		return rewards.map((reward) => fail(reward, characterName, detail));
	}
	return deliveryResultsFromGame(rewards, outcome.characterName, outcome.results, outcome.online);
}
