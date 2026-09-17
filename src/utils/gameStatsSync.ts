/**
 * Builds and pushes each linked player's Discord Game Stats Widget profile.
 *
 * Everything Discord renders comes from the player's save through the wallet helpers, which is
 * also where the portrait URL and its cache buster come from. The game does not persist lifetime
 * wins, kills, deaths or playtime — a run's deaths live only inside that run — so the matching
 * primary fields are deliberately left unset instead of being filled with invented numbers, and
 * the stats the game really tracks are sent as dynamic fields.
 */
import {
	getGameAccountByDiscordId,
	listLinkedDiscordIds,
	recordGameStatsSyncStatus,
} from "./gameAccount.js";
import { buildPortraitUrl, listSaveCharacters, type GameWalletSummary } from "./gameWallet.js";
import {
	GameStatsAuthorizationError,
	GameStatsConfigError,
	GameStatsRequestError,
	PROFILE_STRING_LIMIT,
	resolveGameStatsApiConfig,
	updateApplicationIdentityProfile,
	type GameStatsApiConfig,
	type GameStatsDynamicField,
	type GameStatsProfilePayload,
} from "./gameStatsProfile.js";

/**
 * Dynamic field names the widget must reference. Keep this list in step with the portal's
 * User Data field keys — a renamed field here silently stops rendering in Discord.
 */
export const GAME_STATS_DYNAMIC_FIELDS = {
	characterClass: "character_class",
	masterClass: "master_class",
	characterLevel: "character_level",
	highestLevel: "highest_level",
	gold: "gold",
	mammothIdols: "mammoth_idols",
	dragonKeys: "dragon_keys",
	dragonOre: "dragon_ore",
	silverSigils: "silver_sigils",
	characterCount: "character_count",
} as const;

/**
 * Mirrors the game's `MasterClassID` (`src/server/core/Enums.ts`) — the save stores the number,
 * and only the game knows the names. A character that has not chosen a discipline yet carries 0
 * and gets no field at all, so the widget can fall back to its own text instead of rendering a
 * duplicate of the base class.
 */
const MASTER_CLASS_NAMES: Record<number, string> = {
	1: "Executioner",
	2: "Shadowwalker",
	3: "Soulthief",
	4: "Sentinel",
	5: "Justicar",
	6: "Templar",
	7: "Frostwarden",
	8: "Flameseer",
	9: "Necromancer",
};

/** Display name for a `MasterClassID`, or an empty string when it is unset or unknown. */
export function masterClassName(masterClassId: unknown): string {
	const id = Number(masterClassId);
	if (!Number.isFinite(id)) return "";
	return MASTER_CLASS_NAMES[Math.trunc(id)] ?? "";
}

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 200;
const DEFAULT_BATCH_DEADLINE_MS = 8000;

function clampText(value: unknown): string {
	return String(value ?? "")
		.trim()
		.slice(0, PROFILE_STRING_LIMIT);
}

function numberField(name: string, value: unknown): GameStatsDynamicField | null {
	const amount = Number(value);
	return Number.isFinite(amount) ? { type: 2, name, value: amount } : null;
}

function stringField(name: string, value: unknown): GameStatsDynamicField | null {
	const text = clampText(value);
	return text ? { type: 1, name, value: text } : null;
}

function highestLevelWallet(wallets: GameWalletSummary[]): GameWalletSummary {
	return wallets.reduce((best, current) =>
		current.characterLevel > best.characterLevel ? current : best
	);
}

/**
 * The player's strongest character is the featured one — Discord's `featured_played_character`
 * is the only character-shaped slot the widget layouts use.
 */
export function buildGameStatsProfilePayload(input: {
	wallets: GameWalletSummary[];
	season?: string;
}): GameStatsProfilePayload | null {
	const wallets = (input.wallets ?? []).filter(
		(wallet) => String(wallet?.characterName ?? "").trim().length > 0
	);
	if (wallets.length === 0) return null;

	const featured = highestLevelWallet(wallets);
	const featuredName = clampText(featured.characterName);
	const portraitUrl = buildPortraitUrl(featured);
	const level = featured.characterLevel > 0 ? featured.characterLevel : null;
	const highestLevel = wallets.reduce((max, wallet) => Math.max(max, wallet.characterLevel), 0);

	const dynamic = [
		stringField(GAME_STATS_DYNAMIC_FIELDS.characterClass, featured.characterClass),
		stringField(GAME_STATS_DYNAMIC_FIELDS.masterClass, masterClassName(featured.characterMasterClass)),
		level === null ? null : numberField(GAME_STATS_DYNAMIC_FIELDS.characterLevel, level),
		highestLevel > 0 ? numberField(GAME_STATS_DYNAMIC_FIELDS.highestLevel, highestLevel) : null,
		numberField(GAME_STATS_DYNAMIC_FIELDS.gold, featured.gold),
		numberField(GAME_STATS_DYNAMIC_FIELDS.mammothIdols, featured.mammothIdols),
		numberField(GAME_STATS_DYNAMIC_FIELDS.dragonKeys, featured.dragonKeys),
		numberField(GAME_STATS_DYNAMIC_FIELDS.dragonOre, featured.dragonOre),
		numberField(GAME_STATS_DYNAMIC_FIELDS.silverSigils, featured.silverSigils),
		numberField(GAME_STATS_DYNAMIC_FIELDS.characterCount, wallets.length),
	].filter((field): field is GameStatsDynamicField => field !== null);

	return {
		username: featuredName,
		data: {
			primary: {
				featured_played_character: featuredName,
				...(portraitUrl ? { featured_played_character_image: { url: portraitUrl } } : {}),
				...(input.season ? { season: clampText(input.season) } : {}),
			},
			dynamic,
		},
	};
}

export type GameStatsSyncOutcome =
	| "created"
	| "updated"
	| "dry-run"
	| "no-linked-account"
	| "no-characters"
	| "needs-authorization"
	| "error";

export type GameStatsSyncResult = {
	discordId: string;
	providerIssuedUserId?: string;
	outcome: GameStatsSyncOutcome;
	httpStatus?: number;
	error?: string;
	payload?: GameStatsProfilePayload;
};

export type SyncGameStatsOptions = {
	config?: GameStatsApiConfig;
	dryRun?: boolean;
	season?: string;
};

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Pushes one linked player's profile. Never throws for expected conditions: the outcome is
 * reported instead, so a batch can keep going and the caller can hand it back to an operator.
 */
export async function syncGameStatsForDiscordId(
	discordIdInput: string,
	options: SyncGameStatsOptions = {}
): Promise<GameStatsSyncResult> {
	const discordId = String(discordIdInput ?? "").trim();
	if (!discordId) {
		return { discordId, outcome: "error", error: "A Discord user id is required." };
	}

	try {
		const account = await getGameAccountByDiscordId(discordId);
		if (!account) {
			return {
				discordId,
				outcome: "no-linked-account",
				error: "No Dungeon Blitz account is linked to this Discord user.",
			};
		}

		const providerIssuedUserId = String(account.userId);
		const wallets = await listSaveCharacters(account.userId);
		const payload = buildGameStatsProfilePayload({ wallets, season: options.season });
		if (!payload) {
			await recordGameStatsSyncStatus(discordId, {
				state: "no-characters",
				providerIssuedUserId,
				error: "The linked save has no named characters yet.",
			});
			return {
				discordId,
				providerIssuedUserId,
				outcome: "no-characters",
				error: "The linked save has no named characters yet.",
			};
		}

		if (options.dryRun) {
			return { discordId, providerIssuedUserId, outcome: "dry-run", payload };
		}

		const config = options.config ?? resolveGameStatsApiConfig();
		const { outcome, status } = await updateApplicationIdentityProfile(
			{
				discordUserId: discordId,
				providerIssuedUserId,
				username: payload.username,
				data: payload.data,
			},
			config
		);
		await recordGameStatsSyncStatus(discordId, {
			state: outcome,
			providerIssuedUserId,
			error: null,
			syncedAt: new Date(),
		});
		return { discordId, providerIssuedUserId, outcome, httpStatus: status };
	} catch (error) {
		const outcome: GameStatsSyncOutcome =
			error instanceof GameStatsAuthorizationError ? "needs-authorization" : "error";
		const message = describeError(error);
		if (!(error instanceof GameStatsConfigError)) {
			try {
				await recordGameStatsSyncStatus(discordId, { state: outcome, error: message });
			} catch (statusError) {
				console.error("[game-stats] Could not record the failed sync:", statusError);
			}
		}
		const status = error instanceof GameStatsRequestError ? error.status : undefined;
		return {
			discordId,
			outcome,
			...(status === undefined ? {} : { httpStatus: status }),
			error: message,
		};
	}
}

export type SyncGameStatsBatchOptions = SyncGameStatsOptions & {
	/** Explicit Discord ids to sync. Defaults to a roster read. */
	discordIds?: string[];
	limit?: number;
	/** Wall-clock budget; the loop stops between players so a serverless timeout is not hit. */
	deadlineMs?: number;
};

export type SyncGameStatsBatchResult = {
	attempted: number;
	results: GameStatsSyncResult[];
	stopReason: "complete" | "limit" | "deadline";
};

function resolveBatchLimit(limit: unknown): number {
	const value = Math.round(Number(limit ?? DEFAULT_BATCH_LIMIT));
	if (!Number.isFinite(value)) return DEFAULT_BATCH_LIMIT;
	return Math.min(Math.max(value, 1), MAX_BATCH_LIMIT);
}

/**
 * Syncs a bounded slice of linked players. Bounded on purpose: the endpoint runs on Vercel's
 * 10-second limit, so a full roster is drained by calling this repeatedly.
 */
export async function syncGameStatsBatch(
	options: SyncGameStatsBatchOptions = {}
): Promise<SyncGameStatsBatchResult> {
	const limit = resolveBatchLimit(options.limit);
	const deadlineMs = Math.max(0, Number(options.deadlineMs ?? DEFAULT_BATCH_DEADLINE_MS));
	const startedAt = Date.now();
	const explicit = (options.discordIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
	const discordIds = explicit.length > 0 ? explicit.slice(0, limit) : await listLinkedDiscordIds(limit);

	const results: GameStatsSyncResult[] = [];
	let stopReason: SyncGameStatsBatchResult["stopReason"] =
		explicit.length === 0 && discordIds.length >= limit ? "limit" : "complete";

	for (const discordId of discordIds) {
		if (Date.now() - startedAt > deadlineMs) {
			stopReason = "deadline";
			break;
		}
		results.push(await syncGameStatsForDiscordId(discordId, options));
	}

	return { attempted: results.length, results, stopReason };
}

export function summarizeGameStatsBatch(result: SyncGameStatsBatchResult): string {
	const counts = new Map<GameStatsSyncOutcome, number>();
	for (const entry of result.results) {
		counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
	}
	const parts = [...counts.entries()].map(([outcome, count]) => `${outcome}=${count}`);
	return `Profiles ${result.attempted} (${result.stopReason}): ${parts.join(", ") || "nothing to sync"}`;
}
