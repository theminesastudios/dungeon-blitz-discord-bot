import { MongoClient, type Collection, type Document, type Filter } from "mongodb";

type WalletSource = "minidb" | "wallets";

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
	dragonOre?: number;
	SilverSigils?: number;
	RoyalSigils?: number;
	updatedAt?: Date;
};

type RawLinkedProfile = Document & {
	_id: string;
	userId?: string;
	githubUsername?: string | null;
	isSponsor?: boolean;
	sponsorTarget?: string | null;
	isContributor?: boolean;
};

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

function encodeSelector(source: WalletSource, id: string): string {
	return `${source}:${id}`;
}

function parseSelector(selector: string): { source: WalletSource; id: string } | null {
	const match = selector.match(/^(minidb|wallets):(.+)$/);
	return match ? { source: match[1] as WalletSource, id: match[2] } : null;
}

function toSummary(wallet: RawWallet, source: WalletSource): GameWalletSummary {
	return {
		id: String(wallet._id),
		selector: encodeSelector(source, String(wallet._id)),
		source,
		gameUserId: normalizeBalance(wallet.uid ?? wallet.gameUserId),
		characterName: String(
			wallet.cn ?? wallet.characterName ?? wallet.ck ?? wallet.characterNameKey ?? wallet._id
		).trim(),
		gold: normalizeBalance(wallet.g ?? wallet.gold),
		mammothIdols: normalizeBalance(wallet.mi ?? wallet.mammothIdols),
		dragonKeys: normalizeBalance(wallet.dk ?? wallet.DragonKeys),
		dragonOre: normalizeBalance(wallet.do ?? wallet.dragonOre),
		silverSigils: normalizeBalance(wallet.ss ?? wallet.SilverSigils),
		royalSigils: normalizeBalance(wallet.rs ?? wallet.RoyalSigils),
	};
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

async function getLinkedProfileCollection(): Promise<Collection<RawLinkedProfile>> {
	const client = await getClient();
	return client
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<RawLinkedProfile>(process.env.PROFILE_MONGODB_COLLECTION?.trim() || "data");
}

async function getWalletCollections(): Promise<Array<{ source: WalletSource; collection: Collection<RawWallet> }>> {
	const client = await getClient();
	return [
		{
			source: "minidb",
			collection: client
				.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
				.collection<RawWallet>(process.env.PROFILE_MONGODB_COLLECTION?.trim() || "data"),
		},
		{
			source: "wallets",
			collection: client
				.db(
					process.env.GAME_MONGODB_DB_NAME?.trim() ||
						process.env.MONGODB_DB_NAME?.trim() ||
						"minidb"
				)
				.collection<RawWallet>(
					process.env.GAME_WALLET_COLLECTION?.trim() ||
						process.env.MONGODB_WALLET_COLLECTION?.trim() ||
						process.env.MONGO_COLLECTION_NAME?.trim() ||
						"wallets"
				),
		},
	];
}

function walletDocumentFilter(source: WalletSource): Filter<RawWallet> {
	return source === "minidb"
		? { uid: { $exists: true }, ck: { $exists: true } }
		: { gameUserId: { $exists: true }, characterNameKey: { $exists: true } };
}

function walletSearchFilter(source: WalletSource, term: string): Filter<RawWallet> {
	const base = walletDocumentFilter(source);
	if (!term) return base;
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const numericId = /^\d+$/.test(term) ? Number(term) : null;
	const nameFields = source === "minidb"
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

export async function searchGameWallets(query: string): Promise<GameWalletSummary[]> {
	const term = query.trim();
	const sources = await getWalletCollections();
	const results = await Promise.all(
		sources.map(async ({ source, collection }) => {
			const sortField = source === "minidb" ? "u" : "updatedAt";
			const wallets = await collection
				.find(walletSearchFilter(source, term))
				.sort({ [sortField]: -1 })
				.limit(25)
				.toArray();
			return wallets.map((wallet) => toSummary(wallet, source));
		})
	);

	const unique = new Map<string, GameWalletSummary>();
	for (const wallet of results.flat()) {
		const key = `${wallet.gameUserId}:${wallet.characterName.toLowerCase()}`;
		const existing = unique.get(key);
		if (!existing || wallet.source === "minidb") unique.set(key, wallet);
	}
	return Array.from(unique.values()).slice(0, 25);
}

export async function findGameWallet(selector: string): Promise<GameWalletSummary | null> {
	const normalized = selector.trim();
	if (!normalized) return null;
	const parsed = parseSelector(normalized);
	const sources = await getWalletCollections();

	for (const { source, collection } of sources) {
		if (parsed && parsed.source !== source) continue;
		const id = parsed?.id ?? normalized;
		const byId = await collection.findOne({ _id: id } as Filter<RawWallet>);
		if (byId && Object.keys(walletDocumentFilter(source)).every((key) => key in byId)) {
			return toSummary(byId, source);
		}
	}

	const matches = await searchGameWallets(normalized);
	return matches.find((wallet) => wallet.characterName.toLowerCase() === normalized.toLowerCase()) ?? null;
}

export async function searchPlayers(query: string): Promise<PlayerSearchResult[]> {
	const term = query.trim();
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
			{ projection: { _id: 1, userId: 1, githubUsername: 1 } }
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
			linkedProfile = await profiles.findOne({ githubUsername: new RegExp(`^${wallet.characterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
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

export async function adjustMammothIdols(
	walletSelector: string,
	operation: "add" | "sub",
	amount: number
): Promise<{ before: GameWalletSummary; after: GameWalletSummary } | null> {
	if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Amount must be a positive whole number");
	const wallet = await findGameWallet(walletSelector);
	if (!wallet) return null;
	const sources = await getWalletCollections();
	const target = sources.find(({ source }) => source === wallet.source);
	if (!target) return null;

	const amountField = wallet.source === "minidb" ? "mi" : "mammothIdols";
	const updatedAtField = wallet.source === "minidb" ? "u" : "updatedAt";
	const delta = operation === "add" ? amount : -amount;
	const filter: Filter<RawWallet> = { _id: wallet.id } as Filter<RawWallet>;
	if (operation === "sub") (filter as Record<string, unknown>)[amountField] = { $gte: amount };

	const before = await target.collection.findOneAndUpdate(
		filter,
		{ $inc: { [amountField]: delta }, $set: { [updatedAtField]: new Date() } },
		{ returnDocument: "before" }
	);
	if (!before) return null;
	return {
		before: toSummary(before, wallet.source),
		after: toSummary({ ...before, [amountField]: wallet.mammothIdols + delta }, wallet.source),
	};
}
