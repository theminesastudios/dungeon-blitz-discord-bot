import * as crypto from "node:crypto";
import { MongoClient, type Collection, type Document } from "mongodb";

const PASSWORD_PARAMS = {
	N: 16384,
	r: 8,
	p: 1,
	keylen: 64,
} as const;

/** One Discord connection a player authorized, and the scopes Discord reported for it. */
export type DiscordConnectionGrant = {
	scopes: string[];
	authorizedAt: Date;
};

type AccountDocument = Document & {
	_id: string;
	email: string;
	user_id: number;
	discordId: string;
	passwordKdf?: "scrypt";
	passwordSalt?: string;
	passwordHash?: string;
	passwordParams?: typeof PASSWORD_PARAMS;
	/** Connection ids from `/authorize`, keyed by id. */
	discordConnections?: Record<string, DiscordConnectionGrant>;
	gameStats?: {
		state?: string;
		error?: string | null;
		syncedAt?: Date;
		providerIssuedUserId?: string;
	};
};

type SaveDocument = Document & {
	_id: string;
	user_id: number;
	characters: unknown[];
};

type CounterDocument = Document & {
	_id: string;
	value: number;
};

export type DiscordAccountIdentity = {
	id: string;
	username?: string;
	globalName?: string | null;
	displayName?: string | null;
	email?: string | null;
	emailVerified?: boolean;
	avatar?: string | null;
};

export type PublicGameAccount = {
	email: string;
	userId: number;
	discordId: string;
	passwordConfigured: boolean;
	/** Discord connections this account has authorized, so `/authorize` can show what is done. */
	connections: string[];
	/** Last recorded Game Stats Widget sync state, `null` until one has run. */
	widgetState: string | null;
};

export type CreateGameAccountResult = {
	status: "created" | "existing";
	account: PublicGameAccount;
};

export type UpdateGameAccountPasswordResult =
	| { status: "updated"; account: PublicGameAccount }
	| { status: "not-found" }
	| { status: "already-configured"; account: PublicGameAccount };

export class GameAccountConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GameAccountConflictError";
	}
}

let clientPromise: Promise<MongoClient> | null = null;
let indexesPromise: Promise<void> | null = null;

function normalizeEmail(value: unknown): string {
	return String(value ?? "").trim().toLowerCase();
}

export function isValidAccountEmail(value: unknown): boolean {
	const email = normalizeEmail(value);
	return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidGamePassword(value: unknown): value is string {
	return typeof value === "string" && value.length >= 6 && value.length <= 128;
}

function deriveClientPasswordDigest(plainPassword: string): string {
	return crypto
		.createHash("sha256")
		.update(`#bmg#${plainPassword}`, "utf8")
		.digest("hex");
}

export async function createGamePasswordRecord(plainPassword: string) {
	const salt = crypto.randomBytes(16);
	const digest = deriveClientPasswordDigest(plainPassword);
	const hash = await new Promise<Buffer>((resolve, reject) => {
		crypto.scrypt(digest, salt, PASSWORD_PARAMS.keylen, PASSWORD_PARAMS, (error, key) => {
			if (error) reject(error);
			else resolve(key as Buffer);
		});
	});

	return {
		passwordKdf: "scrypt" as const,
		passwordSalt: salt.toString("base64"),
		passwordHash: hash.toString("base64"),
		passwordParams: { ...PASSWORD_PARAMS },
	};
}

function getMongoUri(): string {
	const uri = process.env.GAME_MONGODB_URI?.trim() || process.env.MONGODB_URI?.trim();
	if (!uri) throw new Error("GAME_MONGODB_URI or MONGODB_URI is required");
	return uri;
}

async function getClient(): Promise<MongoClient> {
	if (clientPromise) return clientPromise;
	clientPromise = (async () => {
		const client = new MongoClient(getMongoUri(), { ignoreUndefined: true });
		await client.connect();
		return client;
	})().catch((error) => {
		clientPromise = null;
		throw error;
	});
	return clientPromise;
}

async function getCollections(): Promise<{
	accounts: Collection<AccountDocument>;
	saves: Collection<SaveDocument>;
	counters: Collection<CounterDocument>;
}> {
	const client = await getClient();
	const db = client.db(
		process.env.GAME_MONGODB_DB_NAME?.trim() ||
			process.env.MONGODB_DB_NAME?.trim() ||
			"minidb"
	);
	return {
		accounts: db.collection<AccountDocument>(
			process.env.MONGODB_ACCOUNTS_COLLECTION?.trim() || "accounts"
		),
		saves: db.collection<SaveDocument>(
			process.env.MONGODB_SAVES_COLLECTION?.trim() || "saves"
		),
		counters: db.collection<CounterDocument>(
			process.env.MONGODB_COUNTERS_COLLECTION?.trim() || "counters"
		),
	};
}

async function ensureIndexes(): Promise<void> {
	if (indexesPromise) return indexesPromise;
	indexesPromise = (async () => {
		const { accounts, saves } = await getCollections();
		await Promise.all([
			accounts.createIndex({ email: 1 }, { unique: true, name: "account_email_unique" }),
			accounts.createIndex({ user_id: 1 }, { unique: true, name: "account_user_id_unique" }),
			accounts.createIndex(
				{ discordId: 1 },
				{ unique: true, sparse: true, name: "account_discord_id_unique" }
			),
			saves.createIndex({ user_id: 1 }, { unique: true, name: "save_user_id_unique" }),
			saves.createIndex({ "characters.name": 1 }, { name: "save_character_name" }),
		]);
	})().catch((error) => {
		indexesPromise = null;
		throw error;
	});
	return indexesPromise;
}

async function allocateUserId(
	accounts: Collection<AccountDocument>,
	counters: Collection<CounterDocument>
): Promise<number> {
	const highest = await accounts.find({}, { projection: { user_id: 1 } }).sort({ user_id: -1 }).limit(1).next();
	const floor = Math.max(0, Math.round(Number(highest?.user_id ?? 0)));
	await counters.updateOne(
		{ _id: "game_user_id" },
		{ $max: { value: floor }, $setOnInsert: { createdAt: new Date() } },
		{ upsert: true }
	);
	const counter = await counters.findOneAndUpdate(
		{ _id: "game_user_id" },
		{ $inc: { value: 1 }, $set: { updatedAt: new Date() } },
		{ returnDocument: "after" }
	);
	const userId = Math.round(Number(counter?.value ?? 0));
	if (!Number.isSafeInteger(userId) || userId <= 0) {
		throw new Error("MongoDB did not allocate a valid game user id");
	}
	return userId;
}

function publicAccount(account: AccountDocument): PublicGameAccount {
	return {
		email: account.email,
		userId: account.user_id,
		discordId: account.discordId,
		passwordConfigured: typeof account.passwordHash === "string" && account.passwordHash.length > 0,
		connections: Object.keys(account.discordConnections ?? {}).sort(),
		widgetState: typeof account.gameStats?.state === "string" ? account.gameStats.state : null,
	};
}

async function ensureEmptySaveExists(
	saves: Collection<SaveDocument>,
	userId: number
): Promise<void> {
	const now = new Date();
	await saves.updateOne(
		{ user_id: userId },
		{
			$setOnInsert: {
				_id: String(userId),
				user_id: userId,
				characters: [],
				createdAt: now,
				updatedAt: now,
			},
		},
		{ upsert: true }
	);
}

export async function getGameAccountByDiscordId(
	discordIdInput: string
): Promise<PublicGameAccount | null> {
	const discordId = String(discordIdInput ?? "").trim();
	if (!discordId) return null;
	await ensureIndexes();
	const { accounts } = await getCollections();
	const account = await accounts.findOne({ discordId });
	return account ? publicAccount(account) : null;
}

/**
 * Discord ids of linked accounts, newest first, for the Game Stats Widget batch sync.
 * A limited slice is intentional: the caller loops until it has drained the roster.
 */
export async function listLinkedDiscordIds(limit: number): Promise<string[]> {
	const capped = Math.min(Math.max(Math.round(Number(limit) || 1), 1), 500);
	await ensureIndexes();
	const { accounts } = await getCollections();
	const rows = await accounts
		.find({ discordId: { $type: "string" } }, { projection: { discordId: 1 } })
		.sort({ _id: 1 })
		.limit(capped)
		.toArray();
	return rows.map((account) => String(account.discordId ?? "").trim()).filter(Boolean);
}

/**
 * Records the outcome of a Game Stats Widget sync on the account, so operators can see who is
 * up to date without re-reading Discord. Failures here must never fail the sync itself.
 */
export async function recordGameStatsSyncStatus(
	discordIdInput: string,
	values: {
		state: string;
		providerIssuedUserId?: string;
		error?: string | null;
		syncedAt?: Date;
	}
): Promise<void> {
	const discordId = String(discordIdInput ?? "").trim();
	if (!discordId) return;
	const { accounts } = await getCollections();
	await accounts.updateOne(
		{ discordId },
		{
			$set: {
				"gameStats.state": values.state,
				"gameStats.error": values.error ?? null,
				"gameStats.syncedAt": values.syncedAt ?? new Date(),
				...(values.providerIssuedUserId
					? { "gameStats.providerIssuedUserId": values.providerIssuedUserId }
					: {}),
			},
		}
	);
}

/**
 * Records the Discord connections a player just authorized, so `/authorize` can report what is
 * already connected instead of asking for the same consent again.
 *
 * Returns false when the player has no linked game account: presence and lobby access do not
 * need one, so that is a normal outcome with nowhere to be recorded rather than an error.
 *
 * Connection ids come from this bot's own catalog and are used as MongoDB field paths, so they
 * are validated against a safe shape instead of being trusted.
 */
export async function recordDiscordConnections(
	discordIdInput: string,
	grants: ReadonlyArray<{ connection: string; scopes: readonly string[] }>
): Promise<boolean> {
	const discordId = String(discordIdInput ?? "").trim();
	const valid = grants.filter((grant) => /^[a-z][a-z0-9-]{0,31}$/.test(grant.connection));
	if (!discordId || valid.length === 0) return false;
	await ensureIndexes();
	const { accounts } = await getCollections();
	const now = new Date();
	const set: Document = { updatedAt: now };
	for (const grant of valid) {
		set[`discordConnections.${grant.connection}`] = {
			scopes: [...grant.scopes],
			authorizedAt: now,
		};
	}
	const result = await accounts.updateOne({ discordId }, { $set: set });
	return result.matchedCount > 0;
}

export async function createGameAccountFromDiscord(
	discord: DiscordAccountIdentity
): Promise<CreateGameAccountResult> {
	const email = normalizeEmail(discord.email);
	const discordId = String(discord.id ?? "").trim();
	if (!discordId) throw new Error("Discord user id is required");
	if (discord.emailVerified !== true || !isValidAccountEmail(email)) {
		throw new GameAccountConflictError(
			"A verified email address on your Discord account is required for a Dungeon Blitz account."
		);
	}

	await ensureIndexes();
	const { accounts, saves, counters } = await getCollections();
	const existingDiscord = await accounts.findOne({ discordId });
	if (existingDiscord) {
		await ensureEmptySaveExists(saves, existingDiscord.user_id);
		return { status: "existing", account: publicAccount(existingDiscord) };
	}
	const existingEmail = await accounts.findOne({
		$or: [{ email }, { emailAliases: email }],
	} as Document);
	if (existingEmail) {
		throw new GameAccountConflictError(
			"Your Discord email address is already used by another Dungeon Blitz account."
		);
	}

	const userId = await allocateUserId(accounts, counters);
	const now = new Date();
	const displayName = String(
		discord.displayName || discord.globalName || discord.username || ""
	).trim();
	const account: AccountDocument = {
		_id: `user:${userId}`,
		email,
		user_id: userId,
		discordId,
		discordUsername: String(discord.username ?? "").trim(),
		discordGlobalName: String(discord.globalName ?? "").trim(),
		discordDisplayName: displayName,
		discordEmail: email,
		discordEmailVerified: true,
		discordAvatar: String(discord.avatar ?? "").trim(),
		discordLinkedAt: now.toISOString(),
		discordSyncRequired: true,
		accountSource: "discord_oauth",
		passwordSetupRequired: true,
		sponsorStatus: "unknown",
		sponsorEligible: false,
		createdAt: now,
		updatedAt: now,
	};
	try {
		await accounts.insertOne(account);
		try {
			await ensureEmptySaveExists(saves, userId);
		} catch (error) {
			await accounts.deleteOne({ _id: account._id });
			throw error;
		}
	} catch (error: any) {
		if (Number(error?.code) === 11000) {
			const racedAccount = await accounts.findOne({ discordId });
			if (racedAccount) {
				await ensureEmptySaveExists(saves, racedAccount.user_id);
				return { status: "existing", account: publicAccount(racedAccount) };
			}
			throw new GameAccountConflictError(
				"Your Discord email address is already used by another Dungeon Blitz account."
			);
		}
		throw error;
	}

	return { status: "created", account: publicAccount(account) };
}

export async function updateGameAccountPassword(
	discordIdInput: string,
	plainPassword: string,
	options: { initialOnly?: boolean } = {}
): Promise<UpdateGameAccountPasswordResult> {
	const discordId = String(discordIdInput ?? "").trim();
	if (!discordId) throw new Error("Discord user id is required");
	if (!isValidGamePassword(plainPassword)) {
		throw new GameAccountConflictError("The password must be between 6 and 128 characters.");
	}

	await ensureIndexes();
	const { accounts } = await getCollections();
	const existing = await accounts.findOne({ discordId });
	if (!existing) return { status: "not-found" };
	if (options.initialOnly && existing.passwordHash) {
		return { status: "already-configured", account: publicAccount(existing) };
	}

	const passwordRecord = await createGamePasswordRecord(plainPassword);
	const now = new Date();
	const filter: Document = { _id: existing._id, discordId };
	if (options.initialOnly) filter.passwordHash = { $exists: false };
	const updated = await accounts.findOneAndUpdate(
		filter,
		{
			$set: {
				...passwordRecord,
				passwordSetupRequired: false,
				passwordUpdatedAt: now.toISOString(),
				updatedAt: now,
			},
		},
		{ returnDocument: "after" }
	);
	if (updated) return { status: "updated", account: publicAccount(updated) };

	const racedAccount = await accounts.findOne({ discordId });
	if (!racedAccount) return { status: "not-found" };
	return { status: "already-configured", account: publicAccount(racedAccount) };
}
