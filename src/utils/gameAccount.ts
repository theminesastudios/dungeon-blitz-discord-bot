import * as crypto from "node:crypto";
import { MongoClient, type Collection, type Document } from "mongodb";

const PASSWORD_PARAMS = {
	N: 16384,
	r: 8,
	p: 1,
	keylen: 64,
} as const;

type AccountDocument = Document & {
	_id: string;
	email: string;
	user_id: number;
	discordId: string;
	passwordKdf?: "scrypt";
	passwordSalt?: string;
	passwordHash?: string;
	passwordParams?: typeof PASSWORD_PARAMS;
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
			process.env.MONGO_DB_NAME?.trim() ||
			"dungeon_blitz_r"
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

export async function createGameAccountFromDiscord(
	discord: DiscordAccountIdentity
): Promise<CreateGameAccountResult> {
	const email = normalizeEmail(discord.email);
	const discordId = String(discord.id ?? "").trim();
	if (!discordId) throw new Error("Discord user id is required");
	if (discord.emailVerified !== true || !isValidAccountEmail(email)) {
		throw new GameAccountConflictError(
			"Dungeon Blitz hesabı için Discord hesabında doğrulanmış bir e-posta adresi gerekli."
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
			"Discord e-posta adresin başka bir Dungeon Blitz hesabı tarafından kullanılıyor."
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
				"Discord e-posta adresin başka bir Dungeon Blitz hesabı tarafından kullanılıyor."
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
		throw new GameAccountConflictError("Parola 6 ile 128 karakter arasında olmalıdır.");
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
