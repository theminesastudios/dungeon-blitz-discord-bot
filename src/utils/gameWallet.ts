import { MongoClient, type Collection, type Document, type Filter } from "mongodb";
import { adjustGameMammothIdols } from "./gameMaintenance.js";

type WalletSource = "saves" | "minidb" | "wallets";
type FlatWalletSource = Exclude<WalletSource, "saves">;

type RawWallet = Document & {
	_id: string;
	uid?: number;
	cn?: string;
	ck?: string;
	g?: number;
	mi?: number;
	dk?: number;
	do?: number;
	ss?: number;
	rs?: number;
	u?: Date;
	gameUserId?: number;
	characterName?: string;
	characterNameKey?: string;
	gold?: number;
	mammothIdols?: number;
	DragonKeys?: number;
	DragonOre?: number;
	dragonOre?: number;
	SilverSigils?: number;
	RoyalSigils?: number;
	updatedAt?: Date;
};

type RawSaveCharacter = Document & {
	name?: string;
	gold?: number;
	mammothIdols?: number;
	DragonKeys?: number;
	DragonOre?: number;
	dragonOre?: number;
	SilverSigils?: number;
	RoyalSigils?: number;
};

type RawSave = Document & {
	_id: string;
	user_id?: number;
	characters?: RawSaveCharacter[];
	updatedAt?: Date;
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
};

export type PackPurchase = {
	packId: string;
	packName: string;
	priceCents: number;
	purchasedAtMs: number;
};

type ParsedSelector = {
	source: WalletSource;
	id: string;
	characterName?: string;
};

type WalletCollection =
	| { source: "saves"; collection: Collection<RawSave> }
	| { source: FlatWalletSource; collection: Collection<RawWallet> };

export type GameWalletSummary = {
	id: string;
	selector: string;
	source: WalletSource;
	gameUserId: number;
	characterName: string;
	gold: number;
	mammothIdols: number;
	dragonKeys: number;
	dragonOre: number;
	silverSigils: number;
	royalSigils: number;
	updatedAtMs: number;
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

function normalizeBalance(value: unknown): number {
	const amount = Number(value ?? 0);
	return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
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

function encodeSelector(source: WalletSource, id: string, characterName?: string): string {
	if (source === "saves") {
		return `saves:${encodeURIComponent(id)}:${encodeURIComponent(characterName ?? "")}`;
	}
	return `${source}:${id}`;
}

function parseSelector(selector: string): ParsedSelector | null {
	const saveMatch = selector.match(/^saves:([^:]+):(.+)$/);
	if (saveMatch) {
		return {
			source: "saves",
			id: safeDecode(saveMatch[1]),
			characterName: safeDecode(saveMatch[2]),
		};
	}
	const flatMatch = selector.match(/^(minidb|wallets):(.+)$/);
	return flatMatch
		? { source: flatMatch[1] as FlatWalletSource, id: flatMatch[2] }
		: null;
}

function toFlatSummary(wallet: RawWallet, source: FlatWalletSource): GameWalletSummary {
	return {
		id: String(wallet._id),
		selector: encodeSelector(source, String(wallet._id)),
		source,
		gameUserId: normalizeBalance(wallet.uid ?? wallet.gameUserId),
		characterName: String(
			wallet.cn ?? wallet.characterName ?? wallet.ck ?? wallet.characterNameKey ?? wallet._id,
		).trim(),
		gold: normalizeBalance(wallet.g ?? wallet.gold),
		mammothIdols: normalizeBalance(wallet.mi ?? wallet.mammothIdols),
		dragonKeys: normalizeBalance(wallet.dk ?? wallet.DragonKeys),
		dragonOre: normalizeBalance(wallet.do ?? wallet.DragonOre ?? wallet.dragonOre),
		silverSigils: normalizeBalance(wallet.ss ?? wallet.SilverSigils),
		royalSigils: normalizeBalance(wallet.rs ?? wallet.RoyalSigils),
		updatedAtMs: toTimestampMs(wallet.u ?? wallet.updatedAt),
	};
}

function toSaveSummary(save: RawSave, character: RawSaveCharacter): GameWalletSummary {
	const characterName = String(character.name ?? "").trim();
	return {
		id: String(save._id),
		selector: encodeSelector("saves", String(save._id), characterName),
		source: "saves",
		gameUserId: normalizeBalance(save.user_id),
		characterName,
		gold: normalizeBalance(character.gold),
		mammothIdols: normalizeBalance(character.mammothIdols),
		dragonKeys: normalizeBalance(character.DragonKeys),
		dragonOre: normalizeBalance(character.DragonOre ?? character.dragonOre),
		silverSigils: normalizeBalance(character.SilverSigils),
		royalSigils: normalizeBalance(character.RoyalSigils),
		// A save document timestamps the account, not the individual character, so every
		// character on one save sorts together. Good enough to pick the active account.
		updatedAtMs: toTimestampMs(save.updatedAt),
	};
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

// "Latest character" needs a real ordering, and the wallet shapes spell the field differently.
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
		const client = new MongoClient(uri, { ignoreUndefined: true });
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

async function getLinkedProfileCollection(): Promise<Collection<RawLinkedProfile>> {
	const client = await getClient();
	return client
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<RawLinkedProfile>(process.env.PROFILE_MONGODB_COLLECTION?.trim() || "data");
}

async function getWalletCollections(): Promise<WalletCollection[]> {
	const client = await getClient();
	const gameDatabase = client.db(getGameDatabaseName());
	return [
		{
			source: "saves",
			collection: gameDatabase.collection<RawSave>(
				process.env.MONGODB_SAVES_COLLECTION?.trim() || "saves",
			),
		},
		{
			source: "minidb",
			collection: client
				.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
				.collection<RawWallet>(process.env.PROFILE_MONGODB_COLLECTION?.trim() || "data"),
		},
		{
			source: "wallets",
			collection: gameDatabase.collection<RawWallet>(
				process.env.GAME_WALLET_COLLECTION?.trim() ||
					process.env.MONGODB_WALLET_COLLECTION?.trim() ||
					process.env.MONGO_COLLECTION_NAME?.trim() ||
					"wallets",
			),
		},
	];
}

function walletDocumentFilter(source: FlatWalletSource): Filter<RawWallet> {
	return source === "minidb"
		? { uid: { $exists: true }, ck: { $exists: true } }
		: { gameUserId: { $exists: true }, characterNameKey: { $exists: true } };
}

function walletSearchFilter(source: FlatWalletSource, term: string): Filter<RawWallet> {
	const base = walletDocumentFilter(source);
	if (!term) return base;
	const escaped = escapeRegex(term);
	const numericId = /^\d+$/.test(term) ? Number(term) : null;
	const nameFields =
		source === "minidb"
			? [{ cn: { $regex: escaped, $options: "i" } }, { ck: { $regex: escaped, $options: "i" } }]
			: [
					{ characterName: { $regex: escaped, $options: "i" } },
					{ characterNameKey: { $regex: escaped, $options: "i" } },
			  ];
	return {
		...base,
		$or: [
			...nameFields,
			...(numericId === null
				? []
				: [source === "minidb" ? { uid: numericId } : { gameUserId: numericId }]),
		],
	} as Filter<RawWallet>;
}

async function searchSaveWallets(
	collection: Collection<RawSave>,
	term: string,
): Promise<GameWalletSummary[]> {
	const escaped = escapeRegex(term);
	const numericId = /^\d+$/.test(term) ? Number(term) : null;
	const filter: Filter<RawSave> = term
		? ({
				$or: [
					{ "characters.name": { $regex: escaped, $options: "i" } },
					...(numericId === null ? [] : [{ user_id: numericId }]),
				],
		  } as Filter<RawSave>)
		: ({ "characters.0": { $exists: true } } as Filter<RawSave>);
	const saves = await collection.find(filter).sort({ updatedAt: -1 }).limit(25).toArray();
	const results: GameWalletSummary[] = [];

	for (const save of saves) {
		const characters = Array.isArray(save.characters) ? save.characters : [];
		const matchedCharacters = characters.filter((character) => {
			const name = String(character?.name ?? "").trim();
			if (!name) return false;
			if (!term || (numericId !== null && normalizeBalance(save.user_id) === numericId)) {
				return true;
			}
			return name.toLowerCase().includes(term.toLowerCase());
		});
		for (const character of matchedCharacters) results.push(toSaveSummary(save, character));
	}
	return results;
}

async function searchFlatWallets(
	source: FlatWalletSource,
	collection: Collection<RawWallet>,
	term: string,
): Promise<GameWalletSummary[]> {
	const sortField = source === "minidb" ? "u" : "updatedAt";
	const wallets = await collection
		.find(walletSearchFilter(source, term))
		.sort({ [sortField]: -1 })
		.limit(25)
		.toArray();
	return wallets.map((wallet) => toFlatSummary(wallet, source));
}

export async function searchGameWallets(query: string): Promise<GameWalletSummary[]> {
	const term = query.trim();
	const sources = await getWalletCollections();
	const results = await Promise.all(
		sources.map(({ source, collection }) =>
			source === "saves"
				? searchSaveWallets(collection, term)
				: searchFlatWallets(source, collection, term),
		),
	);

	const priority: Record<WalletSource, number> = { saves: 3, minidb: 2, wallets: 1 };
	const unique = new Map<string, GameWalletSummary>();
	for (const wallet of results.flat()) {
		const key = `${wallet.gameUserId}:${wallet.characterName.toLowerCase()}`;
		const existing = unique.get(key);
		if (!existing || priority[wallet.source] > priority[existing.source]) unique.set(key, wallet);
	}
	return Array.from(unique.values()).slice(0, 25);
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

export async function findGameWallet(selector: string): Promise<GameWalletSummary | null> {
	const normalized = selector.trim();
	if (!normalized) return null;
	const parsed = parseSelector(normalized);
	const sources = await getWalletCollections();

	if (parsed?.source === "saves" && parsed.characterName) {
		const target = sources.find((source) => source.source === "saves");
		if (target?.source === "saves") {
			const save = await target.collection.findOne({ _id: parsed.id } as Filter<RawSave>);
			const character = save ? findSaveCharacter(save, parsed.characterName) : null;
			if (save && character) return toSaveSummary(save, character);
		}
	}

	for (const target of sources) {
		if (target.source === "saves") continue;
		if (parsed && parsed.source !== target.source) continue;
		const id = parsed?.id ?? normalized;
		const byId = await target.collection.findOne({ _id: id } as Filter<RawWallet>);
		if (byId && Object.keys(walletDocumentFilter(target.source)).every((key) => key in byId)) {
			return toFlatSummary(byId, target.source);
		}
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

export async function searchPlayers(query: string): Promise<PlayerSearchResult[]> {
	const term = query.trim();
	const escaped = escapeRegex(term);
	const profiles = await getLinkedProfileCollection();
	const profileRows = await profiles
		.find(
			term
				? {
						$or: [
							{ githubUsername: { $regex: escaped, $options: "i" } },
							{ userId: { $regex: escaped, $options: "i" } },
						],
				  }
				: { githubUsername: { $type: "string" } },
			{ projection: { _id: 1, userId: 1, githubUsername: 1 } },
		)
		.limit(25)
		.toArray();
	const wallets = await searchGameWallets(term);
	const results = new Map<string, PlayerSearchResult>();

	for (const profile of profileRows) {
		const discordId = String(profile.userId ?? profile._id);
		const github = String(profile.githubUsername ?? "Unknown GitHub");
		results.set(`profile:${discordId}`, {
			selector: `profile:${discordId}`,
			label: `${github} • Discord ${discordId}`,
		});
	}
	for (const wallet of wallets) {
		results.set(`wallet:${wallet.selector}`, {
			selector: `wallet:${wallet.selector}`,
			label: `${wallet.characterName} [${wallet.gameUserId}] • Idols ${wallet.mammothIdols} • Gold ${wallet.gold}`,
		});
	}
	return Array.from(results.values()).slice(0, 25);
}

export async function getPlayerProfile(selector: string): Promise<PlayerProfile | null> {
	const profiles = await getLinkedProfileCollection();
	let linkedProfile: RawLinkedProfile | null = null;
	let wallets: GameWalletSummary[] = [];

	if (selector.startsWith("profile:")) {
		const discordId = selector.slice("profile:".length);
		linkedProfile = await profiles.findOne({
			$or: [{ _id: discordId }, { userId: discordId }],
		} as Filter<RawLinkedProfile>);
		const githubUsername = String(linkedProfile?.githubUsername ?? "").trim();
		if (githubUsername) wallets = await searchGameWallets(githubUsername);
	} else {
		const walletSelector = selector.startsWith("wallet:") ? selector.slice("wallet:".length) : selector;
		const wallet = await findGameWallet(walletSelector);
		if (wallet) {
			wallets = [wallet];
			linkedProfile = await profiles.findOne({
				githubUsername: new RegExp(`^${escapeRegex(wallet.characterName)}$`, "i"),
			});
		}
	}

	if (!linkedProfile && wallets.length === 0) return null;
	return {
		discordUserId: linkedProfile ? String(linkedProfile.userId ?? linkedProfile._id) : null,
		githubUsername: linkedProfile?.githubUsername ? String(linkedProfile.githubUsername) : null,
		isSponsor: typeof linkedProfile?.isSponsor === "boolean" ? linkedProfile.isSponsor : null,
		sponsorTarget: linkedProfile?.sponsorTarget ? String(linkedProfile.sponsorTarget) : null,
		isContributor: typeof linkedProfile?.isContributor === "boolean" ? linkedProfile.isContributor : null,
		wallets,
	};
}

export type PackLedger = {
	usedCents: number;
	purchases: PackPurchase[];
};

function toPackPurchase(value: unknown): PackPurchase | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.packId !== "string" || typeof record.packName !== "string") return null;
	const priceCents = Number(record.priceCents);
	const purchasedAtMs = Number(record.purchasedAtMs);
	if (!Number.isFinite(priceCents) || priceCents <= 0) return null;
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
	if (!normalized) return { usedCents: 0, purchases: [] };
	const profiles = await getLinkedProfileCollection();
	const profile = await profiles.findOne(
		{ $or: [{ _id: normalized }, { userId: normalized }] } as Filter<RawLinkedProfile>,
		{ projection: { packUsedCents: 1, packPurchases: 1 } },
	);
	if (!profile) return { usedCents: 0, purchases: [] };
	const usedCents = normalizeBalance(profile.packUsedCents);
	const purchases = (Array.isArray(profile.packPurchases) ? profile.packPurchases : [])
		.map(toPackPurchase)
		.filter((purchase): purchase is PackPurchase => purchase !== null);
	return { usedCents, purchases };
}

/**
 * Atomically records a pack purchase. The caller passes the highest used-cents value that is
 * still affordable (balance - price); if another purchase raced ahead, the filter no longer
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
	const delta = operation === "add" ? amount : -amount;

	if (wallet.source === "saves") {
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

	const sources = await getWalletCollections();
	const target = sources.find(({ source }) => source === wallet.source);
	if (!target || target.source === "saves") return null;
	const amountField = target.source === "minidb" ? "mi" : "mammothIdols";
	const updatedAtField = target.source === "minidb" ? "u" : "updatedAt";
	const filter: Filter<RawWallet> = { _id: wallet.id } as Filter<RawWallet>;
	if (operation === "sub") (filter as Record<string, unknown>)[amountField] = { $gte: amount };

	const before = await target.collection.findOneAndUpdate(
		filter,
		{ $inc: { [amountField]: delta }, $set: { [updatedAtField]: new Date() } },
		{ returnDocument: "before" },
	);
	if (!before) return null;
	return {
		before: toFlatSummary(before, target.source),
		after: toFlatSummary({ ...before, [amountField]: wallet.mammothIdols + delta }, target.source),
	};
}
