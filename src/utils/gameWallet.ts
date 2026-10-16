import { MongoClient, type Collection, type Document, type Filter } from "mongodb";
import { adjustGameMammothIdols } from "./gameMaintenance.js";

/**
 * Only the live game data is read: one `saves` document per game user, owned by an account
 * in `accounts`. The flat `minidb` / `wallets` snapshots and the accounts imported from the
 * old `Accounts.json` test data are gone from every lookup — a character is listed only when
 * it is on a current save AND that save's account is linked to a Discord user, which is what
 * every caller (pickers, profiles, `/player`) actually means by "a player".
 */
type WalletSource = "saves";

type RawSaveCharacter = Document & {
	name?: string;
	class?: string;
	/** `MasterClassID` (1-9); 0 means the character has not chosen a discipline yet. */
	MasterClass?: number;
	level?: number;
	gold?: number;
	mammothIdols?: number;
	DragonKeys?: number;
	DragonOre?: number;
	dragonOre?: number;
	SilverSigils?: number;
	RoyalSigils?: number;
	missions?: Record<string, { state?: number } | null>;
	/** Written by the game on every region change; its timestamp is when the character last played. */
	LastRegionPosition?: { timestamp?: number } | null;
};

type RawSave = Document & {
	_id: string;
	user_id?: number;
	characters?: RawSaveCharacter[];
	updatedAt?: Date;
};

type RawAccount = Document & {
	_id: string;
	user_id?: number;
	discordId?: string;
	discordUsername?: string;
	discordGlobalName?: string;
	discordDisplayName?: string;
};

type RawLinkedProfile = Document & {
	_id: string;
	userId?: string;
	githubUsername?: string | null;
	isSponsor?: boolean;
	sponsorTarget?: string | null;
	isContributor?: boolean;
	packUsedCents?: number;
	packPurchases?: PackPurchase[];
	bonusCreditCents?: number;
	creditGrants?: CreditGrant[];
};

export type PackPurchase = {
	packId: string;
	packName: string;
	priceCents: number;
	purchasedAtMs: number;
};

/** Audit entry for one admin change to bonus credit: positive when added, negative when removed. */
export type CreditGrant = {
	cents: number;
	grantedByDiscordId: string;
	grantedAtMs: number;
	note?: string;
};

/** The Discord user a live save belongs to. */
export type CharacterOwner = {
	discordId: string;
	/** Discord username (`@name`), empty when the account predates the field. */
	discordUsername: string;
};

export type GameWalletSummary = {
	id: string;
	selector: string;
	source: WalletSource;
	gameUserId: number;
	characterName: string;
	/** Display class ("Mage", "Rogue", "Paladin"). */
	characterClass: string;
	/** `MasterClassID` (1-9), 0 when no discipline has been chosen. */
	characterMasterClass: number;
	characterLevel: number;
	gold: number;
	mammothIdols: number;
	dragonKeys: number;
	dragonOre: number;
	silverSigils: number;
	royalSigils: number;
	/** Mission id -> state, as the game stores it; drives the "current quest" line. */
	missions: Record<string, number>;
	updatedAtMs: number;
	/** When this character was last in the world, 0 when the save never recorded it. */
	lastPlayedMs: number;
	/** Set on search results; lookups by an already-known owner leave it null. */
	owner: CharacterOwner | null;
};

export type PlayerSearchResult = {
	selector: string;
	label: string;
};

export type PlayerProfile = {
	discordUserId: string | null;
	githubUsername: string | null;
	isSponsor: boolean | null;
	sponsorTarget: string | null;
	isContributor: boolean | null;
	wallets: GameWalletSummary[];
};

let clientPromise: Promise<MongoClient> | null = null;

/** Kept well inside the interaction function's time budget so a stalled DB surfaces as an error. */
const MONGO_SERVER_SELECTION_TIMEOUT_MS = 5_000;
const MONGO_SOCKET_TIMEOUT_MS = 8_000;

/** Discord caps autocomplete and select menus at 25 entries. */
const PICKER_LIMIT = 25;

function normalizeBalance(value: unknown): number {
	const amount = Number(value ?? 0);
	return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function normalizeLevel(value: unknown): number {
	const level = Number(value ?? 0);
	return Number.isFinite(level) ? Math.max(0, Math.round(level)) : 0;
}

/**
 * The save stores the discipline as the game's numeric `MasterClassID`; 0 is "none chosen".
 * Values outside the known range are kept as-is so an added discipline is never silently
 * reported as unset — the display layer is what decides whether it has a name for the id.
 */
function normalizeMasterClass(value: unknown): number {
	const masterClass = Number(value ?? 0);
	return Number.isFinite(masterClass) ? Math.max(0, Math.round(masterClass)) : 0;
}

function normalizeMissions(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object") return {};
	const missions: Record<string, number> = {};
	for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
		const state = Number((entry as { state?: unknown } | null)?.state);
		if (/^\d+$/.test(id) && Number.isFinite(state)) missions[id] = Math.round(state);
	}
	return missions;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function encodeSelector(id: string, characterName: string): string {
	return `saves:${encodeURIComponent(id)}:${encodeURIComponent(characterName)}`;
}

function parseSelector(selector: string): { id: string; characterName: string } | null {
	const match = selector.match(/^saves:([^:]+):(.+)$/);
	return match ? { id: safeDecode(match[1]), characterName: safeDecode(match[2]) } : null;
}

function toSaveSummary(
	save: RawSave,
	character: RawSaveCharacter,
	owner: CharacterOwner | null = null,
): GameWalletSummary {
	const characterName = String(character.name ?? "").trim();
	return {
		id: String(save._id),
		selector: encodeSelector(String(save._id), characterName),
		source: "saves",
		gameUserId: normalizeBalance(save.user_id),
		characterName,
		characterClass: String(character.class ?? "").trim(),
		characterMasterClass: normalizeMasterClass(character.MasterClass),
		characterLevel: normalizeLevel(character.level),
		gold: normalizeBalance(character.gold),
		mammothIdols: normalizeBalance(character.mammothIdols),
		dragonKeys: normalizeBalance(character.DragonKeys),
		dragonOre: normalizeBalance(character.DragonOre ?? character.dragonOre),
		silverSigils: normalizeBalance(character.SilverSigils),
		royalSigils: normalizeBalance(character.RoyalSigils),
		missions: normalizeMissions(character.missions),
		// A save document timestamps the account, not the individual character, so every
		// character on one save sorts together. Good enough to pick the active account.
		updatedAtMs: toTimestampMs(save.updatedAt),
		lastPlayedMs: toTimestampMs(character.LastRegionPosition?.timestamp),
		owner,
	};
}

function toOwner(account: RawAccount): CharacterOwner | null {
	const discordId = String(account.discordId ?? "").trim();
	if (!discordId) return null;
	return { discordId, discordUsername: String(account.discordUsername ?? "").trim() };
}

/** `@name` for display; the raw id when the account never recorded a username. */
export function formatOwner(owner: CharacterOwner | null): string {
	if (!owner) return "unlinked";
	return owner.discordUsername ? `@${owner.discordUsername}` : `Discord ${owner.discordId}`;
}

/** One picker row: `MaxMage · Lv 50 Mage — @neo`. */
export function formatCharacterLabel(wallet: GameWalletSummary): string {
	const klass = wallet.characterClass ? ` ${wallet.characterClass}` : "";
	return `${wallet.characterName} · Lv ${wallet.characterLevel}${klass} — ${formatOwner(wallet.owner)}`.slice(0, 100);
}

/**
 * Portraits are published by the game server at /portraits/<character>.png once the player has
 * been in-game with a patched client. Discord's image proxy caches by URL, so the wallet's
 * updatedAt doubles as a cache buster.
 */
export function buildPortraitUrl(
	wallet: Pick<GameWalletSummary, "characterName" | "updatedAtMs"> | null
): string | null {
	const base = String(process.env.GAME_SERVER_BASE_URL ?? "")
		.trim()
		.replace(/\/+$/, "");
	const key = String(wallet?.characterName ?? "")
		.trim()
		.toLowerCase();
	if (!base || !/^https?:\/\//i.test(base) || !/^[a-z0-9_-]+$/.test(key)) return null;
	return `${base}/portraits/${key}.png?v=${Math.floor((wallet?.updatedAtMs ?? 0) / 1000)}`;
}

// "Latest character" needs a real ordering.
function toTimestampMs(value: unknown): number {
	if (value instanceof Date) {
		const ms = value.getTime();
		return Number.isFinite(ms) ? ms : 0;
	}
	const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
	return Number.isFinite(ms) ? ms : 0;
}

async function getClient(): Promise<MongoClient> {
	if (clientPromise) return clientPromise;
	const uri = process.env.GAME_MONGODB_URI?.trim() || process.env.MONGODB_URI?.trim();
	if (!uri) throw new Error("GAME_MONGODB_URI or MONGODB_URI is required");

	clientPromise = (async () => {
		const client = new MongoClient(uri, {
			ignoreUndefined: true,
			// A dead or unreachable database must fail fast. Without a bounded
			// server selection the driver stalls for its 30s default, which is
			// longer than a Discord interaction lives, so the player would be left
			// on an endless "thinking…" state instead of a readable error.
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

function getGameDatabaseName(): string {
	return (
		process.env.GAME_MONGODB_DB_NAME?.trim() ||
		process.env.MONGODB_DB_NAME?.trim() ||
		"minidb"
	);
}

type WalletCollections = {
	saves: Collection<RawSave>;
	accounts: Collection<RawAccount>;
	profiles: Collection<RawLinkedProfile>;
	packClaims?: Collection<PackClaimDocument>;
};

let collectionsOverride: WalletCollections | null = null;

/** Tests swap the database for in-memory collections; `null` restores MongoDB. */
export function setWalletCollectionsForTests(collections: unknown): void {
	collectionsOverride = collections as WalletCollections | null;
}

async function getLinkedProfileCollection(): Promise<Collection<RawLinkedProfile>> {
	if (collectionsOverride) return collectionsOverride.profiles;
	const client = await getClient();
	return client
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<RawLinkedProfile>(process.env.PROFILE_MONGODB_COLLECTION?.trim() || "data");
}

async function getGameCollections(): Promise<{
	saves: Collection<RawSave>;
	accounts: Collection<RawAccount>;
}> {
	if (collectionsOverride) return collectionsOverride;
	const db = (await getClient()).db(getGameDatabaseName());
	return {
		saves: db.collection<RawSave>(process.env.MONGODB_SAVES_COLLECTION?.trim() || "saves"),
		accounts: db.collection<RawAccount>(
			process.env.MONGODB_ACCOUNTS_COLLECTION?.trim() || "accounts",
		),
	};
}

/** An account counts as a player only once a Discord user is linked to it. */
const LINKED_ACCOUNT = { discordId: { $type: "string", $ne: "" } };
const OWNER_PROJECTION = { projection: { user_id: 1, discordId: 1, discordUsername: 1 } };

/** Owners of the given game users, keyed by user id; unlinked accounts are left out. */
async function loadOwners(userIds: number[]): Promise<Map<number, CharacterOwner>> {
	const ids = [...new Set(userIds.filter((id) => id > 0))];
	const owners = new Map<number, CharacterOwner>();
	if (ids.length === 0) return owners;
	const { accounts } = await getGameCollections();
	const rows = await accounts
		.find({ user_id: { $in: ids }, ...LINKED_ACCOUNT } as Filter<RawAccount>, OWNER_PROJECTION)
		.toArray();
	for (const row of rows) {
		const owner = toOwner(row);
		if (owner) owners.set(normalizeBalance(row.user_id), owner);
	}
	return owners;
}

/** Every named character on the given saves whose account is linked, newest save first. */
async function charactersOf(
	saves: RawSave[],
	keep: (character: RawSaveCharacter, save: RawSave) => boolean = () => true,
): Promise<GameWalletSummary[]> {
	const owners = await loadOwners(saves.map((save) => normalizeBalance(save.user_id)));
	const results: GameWalletSummary[] = [];
	for (const save of saves) {
		const owner = owners.get(normalizeBalance(save.user_id));
		if (!owner) continue;
		for (const character of Array.isArray(save.characters) ? save.characters : []) {
			if (!String(character?.name ?? "").trim() || !keep(character, save)) continue;
			results.push(toSaveSummary(save, character, owner));
		}
	}
	return results;
}

/**
 * Live characters matching a picker query: character name, Discord username, Discord id or
 * game user id. Every result carries its owner so the picker can say whose character it is.
 */
export async function searchGameWallets(query: string): Promise<GameWalletSummary[]> {
	const term = query.trim();
	const { saves, accounts } = await getGameCollections();
	const escaped = escapeRegex(term);
	const numericId = /^\d+$/.test(term) ? Number(term) : null;

	if (!term) {
		const recent = await saves
			.find({ "characters.0": { $exists: true } } as Filter<RawSave>)
			.sort({ updatedAt: -1 })
			.limit(PICKER_LIMIT * 2)
			.toArray();
		return (await charactersOf(recent)).slice(0, PICKER_LIMIT);
	}

	// Owners matched by their Discord side contribute their whole roster.
	const ownerRows = await accounts
		.find(
			{
				...LINKED_ACCOUNT,
				$or: [
					{ discordUsername: { $regex: escaped, $options: "i" } },
					{ discordGlobalName: { $regex: escaped, $options: "i" } },
					...(numericId === null ? [] : [{ user_id: numericId }, { discordId: term }]),
				],
			} as Filter<RawAccount>,
			OWNER_PROJECTION,
		)
		.limit(PICKER_LIMIT)
		.toArray();
	const ownerUserIds = new Set(ownerRows.map((row) => normalizeBalance(row.user_id)));

	const matched = await saves
		.find({
			$or: [
				{ "characters.name": { $regex: escaped, $options: "i" } },
				...(ownerUserIds.size > 0 ? [{ user_id: { $in: [...ownerUserIds] } }] : []),
			],
		} as Filter<RawSave>)
		.sort({ updatedAt: -1 })
		.limit(PICKER_LIMIT * 2)
		.toArray();

	const lowered = term.toLowerCase();
	const results = await charactersOf(
		matched,
		(character, save) =>
			ownerUserIds.has(normalizeBalance(save.user_id)) ||
			String(character.name ?? "").toLowerCase().includes(lowered),
	);
	// Exact name first, then prefix matches, then the rest in save order.
	const rank = (wallet: GameWalletSummary) => {
		const name = wallet.characterName.toLowerCase();
		return name === lowered ? 0 : name.startsWith(lowered) ? 1 : 2;
	};
	return results.sort((a, b) => rank(a) - rank(b)).slice(0, PICKER_LIMIT);
}

function findSaveCharacter(save: RawSave, characterName: string): RawSaveCharacter | null {
	const normalized = characterName.trim().toLowerCase();
	if (!normalized || !Array.isArray(save.characters)) return null;
	return (
		save.characters.find(
			(character) => String(character?.name ?? "").trim().toLowerCase() === normalized,
		) ?? null
	);
}

/**
 * Every named character on one player's save, ordered by level. Used by the Discord Game Stats
 * Widget sync and `/account view`, which need the whole roster rather than a single wallet.
 */
export async function listSaveCharacters(gameUserId: number): Promise<GameWalletSummary[]> {
	const userId = normalizeBalance(gameUserId);
	if (userId <= 0) return [];
	const { saves } = await getGameCollections();
	const save = await saves.findOne({ user_id: userId } as Filter<RawSave>);
	if (!save || !Array.isArray(save.characters)) return [];
	return save.characters
		.filter((character) => String(character?.name ?? "").trim().length > 0)
		.map((character) => toSaveSummary(save, character))
		.sort((a, b) => b.characterLevel - a.characterLevel);
}

/**
 * One live character by its exact name (case-insensitive), with its owner. Character names
 * are unique across the game, so this is the public `/player` lookup. Characters on saves
 * that no Discord user owns — the old test accounts — are not players and are not found.
 */
export async function findLiveCharacter(name: string): Promise<GameWalletSummary | null> {
	const clean = name.trim();
	if (!clean) return null;
	const { saves } = await getGameCollections();
	const save = await saves.findOne({
		"characters.name": { $regex: `^${escapeRegex(clean)}$`, $options: "i" },
	} as Filter<RawSave>);
	const character = save ? findSaveCharacter(save, clean) : null;
	if (!save || !character) return null;
	const owner = (await loadOwners([normalizeBalance(save.user_id)])).get(
		normalizeBalance(save.user_id),
	);
	return owner ? toSaveSummary(save, character, owner) : null;
}

export async function findGameWallet(selector: string): Promise<GameWalletSummary | null> {
	const normalized = selector.trim();
	if (!normalized) return null;
	const parsed = parseSelector(normalized);
	if (parsed) {
		const { saves } = await getGameCollections();
		const save = await saves.findOne({ _id: parsed.id } as Filter<RawSave>);
		const character = save ? findSaveCharacter(save, parsed.characterName) : null;
		return save && character ? toSaveSummary(save, character) : null;
	}

	const matches = await searchGameWallets(normalized);
	const exactName = matches.find(
		(wallet) => wallet.characterName.toLowerCase() === normalized.toLowerCase(),
	);
	if (exactName) return exactName;
	if (/^\d+$/.test(normalized)) {
		const userId = Number(normalized);
		return matches.find((wallet) => wallet.gameUserId === userId) ?? null;
	}
	return null;
}

/**
 * Player pickers for staff tools. One row per linked Discord user, labelled with their live
 * characters — `@neo · MaxMage Lv 50, NewMage Lv 1` — and selecting `profile:<discordId>`.
 * GitHub usernames still match, but only for users who also have a live game account.
 */
export async function searchPlayers(query: string): Promise<PlayerSearchResult[]> {
	const term = query.trim();
	const escaped = escapeRegex(term);
	const profiles = await getLinkedProfileCollection();
	const [wallets, githubRows] = await Promise.all([
		searchGameWallets(term),
		term
			? profiles
					.find(
						{ githubUsername: { $regex: escaped, $options: "i" } } as Filter<RawLinkedProfile>,
						{ projection: { _id: 1, userId: 1 } },
					)
					.limit(PICKER_LIMIT)
					.toArray()
			: Promise.resolve([] as RawLinkedProfile[]),
	]);

	const byOwner = new Map<string, { owner: CharacterOwner; wallets: GameWalletSummary[] }>();
	const add = (owner: CharacterOwner, wallet: GameWalletSummary | null) => {
		const entry = byOwner.get(owner.discordId) ?? { owner, wallets: [] };
		if (wallet) entry.wallets.push(wallet);
		byOwner.set(owner.discordId, entry);
	};
	for (const wallet of wallets) if (wallet.owner) add(wallet.owner, wallet);

	const githubDiscordIds = githubRows
		.map((row) => String(row.userId ?? row._id).trim())
		.filter((id) => id && !byOwner.has(id));
	if (githubDiscordIds.length > 0) {
		const { accounts } = await getGameCollections();
		const linked = await accounts
			.find({ discordId: { $in: githubDiscordIds } } as Filter<RawAccount>, OWNER_PROJECTION)
			.toArray();
		const rosters = await Promise.all(
			linked.map((account) => listSaveCharacters(normalizeBalance(account.user_id))),
		);
		linked.forEach((account, index) => {
			const owner = toOwner(account);
			if (!owner) return;
			add(owner, null);
			for (const wallet of rosters[index]) add(owner, wallet);
		});
	}

	return Array.from(byOwner.values())
		.slice(0, PICKER_LIMIT)
		.map(({ owner, wallets: owned }) => {
			const roster = owned.length > 0
				? owned.map((wallet) => `${wallet.characterName} Lv ${wallet.characterLevel}`).join(", ")
				: "no characters yet";
			return {
				selector: `profile:${owner.discordId}`,
				label: `${formatOwner(owner)} · ${roster}`.slice(0, 100),
			};
		});
}

/**
 * Resolves the Discord user linked to a GitHub username, for admin tools that
 * act on a sponsor from their GitHub side (e.g. granting the sponsor role).
 * The match is exact-but-case-insensitive, like the sponsor lists themselves.
 * Returns null when no linked profile carries that GitHub username.
 */
export async function discordIdForGithubUser(
	githubUsername: string
): Promise<string | null> {
	const login = githubUsername.trim();
	if (!login) return null;
	const profiles = await getLinkedProfileCollection();
	const profile = await profiles.findOne(
		{ githubUsername: new RegExp(`^${escapeRegex(login)}$`, "i") } as Filter<RawLinkedProfile>,
		{ projection: { _id: 1, userId: 1 } },
	);
	if (!profile) return null;
	const discordId = String(profile.userId ?? profile._id).trim();
	return discordId || null;
}

/** The live roster of the game account linked to a Discord user. */
async function walletsForDiscordUser(discordId: string): Promise<GameWalletSummary[]> {
	const { accounts } = await getGameCollections();
	const account = await accounts.findOne({ discordId } as Filter<RawAccount>, OWNER_PROJECTION);
	const owner = account ? toOwner(account) : null;
	if (!account || !owner) return [];
	const roster = await listSaveCharacters(normalizeBalance(account.user_id));
	return roster.map((wallet) => ({ ...wallet, owner }));
}

export async function getPlayerProfile(selector: string): Promise<PlayerProfile | null> {
	const profiles = await getLinkedProfileCollection();
	let linkedProfile: RawLinkedProfile | null = null;
	let wallets: GameWalletSummary[] = [];
	let discordUserId: string | null = null;

	if (selector.startsWith("profile:")) {
		const discordId = selector.slice("profile:".length).trim();
		[linkedProfile, wallets] = await Promise.all([
			profiles.findOne({
				$or: [{ _id: discordId }, { userId: discordId }],
			} as Filter<RawLinkedProfile>),
			walletsForDiscordUser(discordId),
		]);
		if (linkedProfile || wallets.length > 0) discordUserId = discordId;
	} else {
		const walletSelector = selector.startsWith("wallet:") ? selector.slice("wallet:".length) : selector;
		const wallet = await findGameWallet(walletSelector);
		if (wallet) {
			const owner =
				wallet.owner ??
				(await loadOwners([wallet.gameUserId])).get(wallet.gameUserId) ??
				null;
			wallets = [{ ...wallet, owner }];
			discordUserId = owner?.discordId ?? null;
			if (owner) {
				linkedProfile = await profiles.findOne({
					$or: [{ _id: owner.discordId }, { userId: owner.discordId }],
				} as Filter<RawLinkedProfile>);
			}
		}
	}

	if (!linkedProfile && wallets.length === 0) return null;
	return {
		discordUserId,
		githubUsername: linkedProfile?.githubUsername ? String(linkedProfile.githubUsername) : null,
		isSponsor: typeof linkedProfile?.isSponsor === "boolean" ? linkedProfile.isSponsor : null,
		sponsorTarget: linkedProfile?.sponsorTarget ? String(linkedProfile.sponsorTarget) : null,
		isContributor: typeof linkedProfile?.isContributor === "boolean" ? linkedProfile.isContributor : null,
		wallets,
	};
}

export type PackLedger = {
	usedCents: number;
	bonusCents: number;
	purchases: PackPurchase[];
};

function toPackPurchase(value: unknown): PackPurchase | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.packId !== "string" || typeof record.packName !== "string") return null;
	const priceCents = Number(record.priceCents);
	const purchasedAtMs = Number(record.purchasedAtMs);
	// priceCents === 0 is valid: the Sponsor Pack is a free claim that still
	// occupies the ledger so it cannot be claimed twice.
	if (!Number.isFinite(priceCents) || priceCents < 0) return null;
	return {
		packId: record.packId,
		packName: record.packName,
		priceCents: Math.round(priceCents),
		purchasedAtMs: Number.isFinite(purchasedAtMs) ? purchasedAtMs : 0,
	};
}

/**
 * Reads how much donation credit a player has already spent on packs.
 * The ledger lives on the linked profile document so it is keyed by Discord ID.
 */
export async function getPackLedger(discordId: string): Promise<PackLedger> {
	const normalized = discordId.trim();
	if (!normalized) return { usedCents: 0, bonusCents: 0, purchases: [] };
	const profiles = await getLinkedProfileCollection();
	const profile = await profiles.findOne(
		{ $or: [{ _id: normalized }, { userId: normalized }] } as Filter<RawLinkedProfile>,
		{ projection: { packUsedCents: 1, packPurchases: 1, bonusCreditCents: 1 } },
	);
	if (!profile) return { usedCents: 0, bonusCents: 0, purchases: [] };
	const usedCents = normalizeBalance(profile.packUsedCents);
	const bonusCents = normalizeBalance(profile.bonusCreditCents);
	const purchases = (Array.isArray(profile.packPurchases) ? profile.packPurchases : [])
		.map(toPackPurchase)
		.filter((purchase): purchase is PackPurchase => purchase !== null);
	return { usedCents, bonusCents, purchases };
}

/**
 * Atomically adds admin-granted bonus credit to a linked player's profile.
 * The grant is also appended to `creditGrants` for auditing. Returns false when
 * no linked profile exists for the Discord ID.
 */
export async function grantBonusCredit(
	discordId: string,
	cents: number,
	grantedByDiscordId: string,
	note?: string,
): Promise<boolean> {
	if (!Number.isSafeInteger(cents) || cents <= 0) {
		throw new Error("Bonus credit must be a positive whole number of cents");
	}
	const normalized = discordId.trim();
	if (!normalized) return false;
	const profiles = await getLinkedProfileCollection();
	const grant: CreditGrant = {
		cents,
		grantedByDiscordId: grantedByDiscordId.trim(),
		grantedAtMs: Date.now(),
		...(note ? { note } : {}),
	};
	const updated = await profiles.findOneAndUpdate(
		{ $or: [{ _id: normalized }, { userId: normalized }] } as Filter<RawLinkedProfile>,
		{
			$inc: { bonusCreditCents: cents },
			// MongoDB's $push typing is overly strict on Document intersections.
			$push: { creditGrants: grant },
		} as never,
	);
	return updated !== null;
}

/**
 * Atomically takes admin-granted bonus credit back from a linked player's profile. The
 * filter only matches while the profile holds at least `cents` of bonus, so two removals
 * racing each other can never push it below zero. The removal is appended to
 * `creditGrants` as a negative entry, next to the grants it undoes.
 */
export async function removeBonusCredit(
	discordId: string,
	cents: number,
	removedByDiscordId: string,
	note?: string,
): Promise<
	| { status: "ok"; bonusCents: number }
	| { status: "insufficient"; bonusCents: number }
	| { status: "no-profile" }
> {
	if (!Number.isSafeInteger(cents) || cents <= 0) {
		throw new Error("Bonus credit to remove must be a positive whole number of cents");
	}
	const normalized = discordId.trim();
	if (!normalized) return { status: "no-profile" };
	const profiles = await getLinkedProfileCollection();
	const owner = { $or: [{ _id: normalized }, { userId: normalized }] };
	const entry: CreditGrant = {
		cents: -cents,
		grantedByDiscordId: removedByDiscordId.trim(),
		grantedAtMs: Date.now(),
		...(note ? { note } : {}),
	};
	const updated = await profiles.findOneAndUpdate(
		{ $and: [owner, { bonusCreditCents: { $gte: cents } }] } as Filter<RawLinkedProfile>,
		{
			$inc: { bonusCreditCents: -cents },
			// MongoDB's $push typing is overly strict on Document intersections.
			$push: { creditGrants: entry },
		} as never,
		{ returnDocument: "after", projection: { bonusCreditCents: 1 } },
	);
	if (updated) return { status: "ok", bonusCents: normalizeBalance(updated.bonusCreditCents) };

	const current = await profiles.findOne(owner as Filter<RawLinkedProfile>, {
		projection: { bonusCreditCents: 1 },
	});
	if (!current) return { status: "no-profile" };
	return { status: "insufficient", bonusCents: normalizeBalance(current.bonusCreditCents) };
}

/**
 * Atomically records a pack purchase. The caller passes the highest used-cents value that is
 * still affordable before this charge (used + balance - price, `maxUsedCentsBeforeCharge`);
 * if another purchase raced ahead, the filter no longer
 * matches and nothing is written, so credit can never go negative.
 */
export async function recordPackPurchase(
	discordId: string,
	purchase: PackPurchase,
	maxUsedCents: number,
): Promise<boolean> {
	if (!Number.isSafeInteger(purchase.priceCents) || purchase.priceCents < 0) {
		throw new Error("Pack price must be a non-negative whole number of cents");
	}
	if (!Number.isSafeInteger(maxUsedCents) || maxUsedCents < 0) {
		return false;
	}
	const normalized = discordId.trim();
	if (!normalized) return false;
	const profiles = await getLinkedProfileCollection();
	const updated = await profiles.findOneAndUpdate(
		{
			$and: [
				{ $or: [{ _id: normalized }, { userId: normalized }] },
				// A profile without a ledger has spent nothing, which is always affordable here.
				{ $or: [
					{ packUsedCents: { $lte: maxUsedCents } },
					{ packUsedCents: { $exists: false } },
				] },
			],
		} as Filter<RawLinkedProfile>,
		{
			$inc: { packUsedCents: purchase.priceCents },
			// MongoDB's $push typing is overly strict on Document intersections.
			$push: { packPurchases: purchase },
		} as never,
	);
	return updated !== null;
}

/**
 * Clears a player's pack ledger — the spent-cents total and the purchase list.
 * Paired with `stripPackRewards` it fully undoes a purchase: the credit becomes
 * spendable again and a one-time Sponsor Pack claim can be made again. Returns
 * false when no linked profile exists for the Discord ID.
 */
export async function resetPackLedger(discordId: string): Promise<boolean> {
	const normalized = discordId.trim();
	if (!normalized) return false;
	const profiles = await getLinkedProfileCollection();
	const updated = await profiles.findOneAndUpdate(
		{ $or: [{ _id: normalized }, { userId: normalized }] } as Filter<RawLinkedProfile>,
		{ $set: { packUsedCents: 0, packPurchases: [] } },
	);
	return updated !== null;
}

/**
 * Atomically reverts a failed purchase: subtracts the price from `packUsedCents`
 * and removes the purchase from the ledger. For a free claim (priceCents 0) it
 * only removes the ledger entry, which releases the claim so it can be tried
 * again. Returns false when the exact purchase is no longer on the ledger (e.g.
 * a refund already ran), so a double refund can never corrupt the balance.
 */
export async function refundPackPurchase(
	discordId: string,
	purchase: PackPurchase,
): Promise<boolean> {
	if (!Number.isSafeInteger(purchase.priceCents) || purchase.priceCents < 0) {
		throw new Error("Pack price must be a non-negative whole number of cents");
	}
	const normalized = discordId.trim();
	if (!normalized) return false;
	const profiles = await getLinkedProfileCollection();
	const updated = await profiles.findOneAndUpdate(
		{
			$and: [
				{ $or: [{ _id: normalized }, { userId: normalized }] },
				// The exact purchase entry must still be on the ledger, and the used
				// total must still cover its price, for the revert to be safe.
				{ packUsedCents: { $gte: purchase.priceCents } },
				{ packPurchases: purchase },
			],
		} as Filter<RawLinkedProfile>,
		{
			$inc: { packUsedCents: -purchase.priceCents },
			// MongoDB's $pull typing is overly strict on Document intersections.
			$pull: { packPurchases: purchase },
		} as never,
	);
	return updated !== null;
}

export async function adjustMammothIdols(
	walletSelector: string,
	operation: "add" | "sub",
	amount: number,
): Promise<{ before: GameWalletSummary; after: GameWalletSummary } | null> {
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		throw new Error("Amount must be a positive whole number");
	}
	const wallet = await findGameWallet(walletSelector);
	if (!wallet) return null;

	try {
		const result = await adjustGameMammothIdols(
			wallet.gameUserId,
			wallet.characterName,
			operation,
			amount,
		);
		const before = { ...wallet, mammothIdols: result.before };
		return {
			before,
			after: { ...before, mammothIdols: result.after },
		};
	} catch (error) {
		if (
			operation === "sub" &&
			error instanceof Error &&
			error.message.includes("does not have enough Mammoth Idols")
		) {
			return null;
		}
		throw error;
	}
}

/**
 * One-time claims of packs that need no linked profile (the Booster Pack). A server
 * booster may have no GitHub link, so the claim cannot live on the profile ledger;
 * it gets its own document keyed `<packId>:<discordId>`, and the unique `_id` is
 * what stops a second claim — two racing clicks cannot both insert it.
 */
type PackClaimDocument = {
	_id: string;
	packId: string;
	discordId: string;
	claimedAtMs: number;
};

async function getPackClaimCollection(): Promise<Collection<PackClaimDocument>> {
	if (collectionsOverride?.packClaims) return collectionsOverride.packClaims;
	const client = await getClient();
	return client
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<PackClaimDocument>("packClaims");
}

function packClaimId(packId: string, discordId: string): string {
	return `${packId}:${discordId.trim()}`;
}

/**
 * Records a one-time claim. Returns the claim time, or null when this player has
 * already claimed the pack.
 */
export async function recordPackClaim(
	discordId: string,
	packId: string,
): Promise<number | null> {
	const normalized = discordId.trim();
	if (!normalized) return null;
	const claimedAtMs = Date.now();
	try {
		const claims = await getPackClaimCollection();
		await claims.insertOne({
			_id: packClaimId(packId, normalized),
			packId,
			discordId: normalized,
			claimedAtMs,
		});
		return claimedAtMs;
	} catch (error) {
		if ((error as { code?: number }).code === 11000) return null;
		throw error;
	}
}

/**
 * Releases a claim whose rewards never landed, so the player can try again.
 * Matching on the claim time means a stale release cannot drop a newer claim.
 */
export async function releasePackClaim(
	discordId: string,
	packId: string,
	claimedAtMs: number,
): Promise<boolean> {
	const claims = await getPackClaimCollection();
	const result = await claims.deleteOne({ _id: packClaimId(packId, discordId), claimedAtMs });
	return result.deletedCount === 1;
}

/** Whether this player has already claimed a pack recorded in `packClaims`. */
export async function hasPackClaim(discordId: string, packId: string): Promise<boolean> {
	const normalized = discordId.trim();
	if (!normalized) return false;
	const claims = await getPackClaimCollection();
	return (await claims.countDocuments({ _id: packClaimId(packId, normalized) }, { limit: 1 })) > 0;
}
