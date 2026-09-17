/**
 * Discord Game Stats Widget integration: the Application Identity Profile API.
 *
 * A player's profile widget is rendered from the record this module writes — Discord never
 * reads the game server. Reads and writes both need a bot token plus a player who authorized
 * the application with `application_identities.write`, so a 403 always means "this player has
 * to re-link with /account create", never "our token or application id is wrong".
 *
 * The guards here mirror the documented limits (10 KB serialized `data`, 30 dynamic fields,
 * 100-character string values) so an oversized payload fails locally instead of half way
 * through a sync run.
 */
const DEFAULT_API_BASE = "https://discord.com/api/v10";
const USERNAME_LIMIT = 1024;

export const APPLICATION_IDENTITIES_WRITE_SCOPE = "application_identities.write";

/** Scopes the /account create link must request so the widget can be written for the player. */
export const ACCOUNT_LINK_SCOPES = [
	"identify",
	"email",
	APPLICATION_IDENTITIES_WRITE_SCOPE,
] as const;

/** Scopes the linked-roles verification link must request, for players who link that way. */
export const ROLE_LINK_SCOPES = [
	"identify",
	"connections",
	"role_connections.write",
	APPLICATION_IDENTITIES_WRITE_SCOPE,
] as const;

export const PROFILE_DATA_LIMIT_BYTES = 10 * 1024;
export const DYNAMIC_FIELD_LIMIT = 30;
export const PROFILE_STRING_LIMIT = 100;

export type GameStatsMedia = { url: string };

export type GameStatsDynamicField =
	| { type: 1; name: string; value: string }
	| { type: 2; name: string; value: number }
	| { type: 3; name: string; value: GameStatsMedia };

/**
 * The pre-configured primary fields. Only the ones the game actually tracks are ever set;
 * see gameStatsSync.ts for why the win/kill/death/playtime fields stay empty.
 */
export type GameStatsPrimaryFields = {
	season?: string;
	rank_name?: string;
	rank_image?: GameStatsMedia;
	highest_rank?: string;
	highest_rank_image?: GameStatsMedia;
	featured_played_character?: string;
	featured_played_character_image?: GameStatsMedia;
	playtime_hours?: number;
	total_wins?: number;
	current_period_wins?: number;
	total_games?: number;
	current_period_games?: number;
	total_kills?: number;
	current_period_kills?: number;
	total_assists?: number;
	current_period_assists?: number;
	total_deaths?: number;
	current_period_deaths?: number;
};

export type GameStatsProfileData = {
	primary?: GameStatsPrimaryFields;
	dynamic?: GameStatsDynamicField[];
};

export type GameStatsProfilePayload = {
	username?: string;
	data?: GameStatsProfileData;
};

export type ApplicationIdentity = {
	user_id: string;
	provider_type: string;
	provider_id?: string;
	provider_issued_user_id: string;
};

export type ApplicationIdentityProfile = {
	username?: string | null;
	metadata?: unknown;
	data?: GameStatsProfileData | null;
};

/** Discord refused the write because the player has not authorized the required scope. */
export class GameStatsAuthorizationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GameStatsAuthorizationError";
	}
}

/** Discord refused the request itself: payload too large, identity conflict, field validation. */
export class GameStatsRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "GameStatsRequestError";
		this.status = status;
	}
}

/** The payload cannot be sent as built. Nothing was requested. */
export class GameStatsValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GameStatsValidationError";
	}
}

/** The deployment is missing the application id or bot token. Nothing was requested. */
export class GameStatsConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GameStatsConfigError";
	}
}

export type GameStatsApiConfig = {
	applicationId: string;
	botToken: string;
	apiBase: string;
};

function cleanEnvValue(value: string | undefined): string {
	const trimmed = value?.trim() ?? "";
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

export function resolveGameStatsApiConfig(
	env: NodeJS.ProcessEnv = process.env
): GameStatsApiConfig {
	const applicationId =
		cleanEnvValue(env.DISCORD_APPLICATION_ID) || cleanEnvValue(env.DISCORD_CLIENT_ID);
	const botToken = cleanEnvValue(env.DISCORD_BOT_TOKEN);
	const missing: string[] = [];
	if (!applicationId) missing.push("DISCORD_APPLICATION_ID or DISCORD_CLIENT_ID");
	if (!botToken) missing.push("DISCORD_BOT_TOKEN");
	if (missing.length > 0) {
		throw new GameStatsConfigError(
			`[game-stats] Missing required configuration: ${missing.join(", ")}.`
		);
	}

	return {
		applicationId,
		botToken,
		apiBase: cleanEnvValue(env.DISCORD_API_BASE) || DEFAULT_API_BASE,
	};
}

function requireDiscordUserId(value: unknown): string {
	const discordUserId = String(value ?? "").trim();
	if (!/^\d{5,32}$/.test(discordUserId)) {
		throw new GameStatsValidationError(
			`[game-stats] "${discordUserId}" is not a Discord user id (snowflake).`
		);
	}
	return discordUserId;
}

function requireProviderIssuedUserId(value: unknown): string {
	const providerIssuedUserId = String(value ?? "").trim();
	if (!providerIssuedUserId) {
		throw new GameStatsValidationError("[game-stats] provider_issued_user_id is required.");
	}
	return providerIssuedUserId;
}

function applicationUrl(config: GameStatsApiConfig, suffix: string): string {
	return `${config.apiBase}/applications/${encodeURIComponent(config.applicationId)}${suffix}`;
}

function identityProfileUrl(
	config: GameStatsApiConfig,
	discordUserId: string,
	providerIssuedUserId: string
): string {
	return applicationUrl(
		config,
		`/users/${discordUserId}/identities/${encodeURIComponent(providerIssuedUserId)}/profile`
	);
}

export function measureProfileDataBytes(data: unknown): number {
	return Buffer.byteLength(JSON.stringify(data ?? {}), "utf8");
}

export function assertProfileDataWithinLimits(data: GameStatsProfileData): void {
	const bytes = measureProfileDataBytes(data);
	if (bytes > PROFILE_DATA_LIMIT_BYTES) {
		throw new GameStatsValidationError(
			`[game-stats] Profile data is ${bytes} bytes; Discord rejects anything above ${PROFILE_DATA_LIMIT_BYTES}.`
		);
	}

	const dynamic = data.dynamic ?? [];
	if (dynamic.length > DYNAMIC_FIELD_LIMIT) {
		throw new GameStatsValidationError(
			`[game-stats] ${dynamic.length} dynamic fields exceed Discord's limit of ${DYNAMIC_FIELD_LIMIT}.`
		);
	}
	for (const field of dynamic) {
		if (field.name.length > PROFILE_STRING_LIMIT) {
			throw new GameStatsValidationError(
				`[game-stats] Dynamic field name "${field.name}" is longer than ${PROFILE_STRING_LIMIT} characters.`
			);
		}
		if (field.type === 1 && field.value.length > PROFILE_STRING_LIMIT) {
			throw new GameStatsValidationError(
				`[game-stats] Dynamic string field "${field.name}" is longer than ${PROFILE_STRING_LIMIT} characters.`
			);
		}
	}
	for (const [key, value] of Object.entries(data.primary ?? {})) {
		if (typeof value === "string" && value.length > PROFILE_STRING_LIMIT) {
			throw new GameStatsValidationError(
				`[game-stats] primary.${key} is longer than ${PROFILE_STRING_LIMIT} characters.`
			);
		}
	}
}

/** Discord answers errors with `{"message": "..."}`; proxy HTML and empty bodies fall through. */
function discordErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
		if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
		if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
	} catch {
		// Not JSON: use the raw body below.
	}
	return body.trim();
}

async function sendIdentityRequest(
	url: string,
	config: GameStatsApiConfig,
	init: { method: string; body?: string }
): Promise<{ status: number; text: string }> {
	const response = await fetch(url, {
		method: init.method,
		headers: {
			Authorization: `Bot ${config.botToken}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(init.body === undefined ? {} : { body: init.body }),
	});
	const text = await response.text();

	if (response.status === 403) {
		throw new GameStatsAuthorizationError(
			`[game-stats] Discord refused this profile write (403): the player must authorize the application with the "${APPLICATION_IDENTITIES_WRITE_SCOPE}" scope. Ask them to re-link their Discord account with /account create in Discord.` +
				(discordErrorMessage(text) ? ` Discord said: ${discordErrorMessage(text)}` : "")
		);
	}
	if (response.status >= 400) {
		throw new GameStatsRequestError(
			response.status,
			`[game-stats] ${init.method} failed with ${response.status}: ${discordErrorMessage(text) || "no response body"}`
		);
	}

	return { status: response.status, text };
}

/**
 * PATCHes a player's profile. Discord creates the profile-only Application Identity on the
 * first successful write (201) and answers 204 for later updates.
 *
 * `providerIssuedUserId` is the game's own player id, not a Discord id.
 */
export async function updateApplicationIdentityProfile(
	params: {
		discordUserId: string;
		providerIssuedUserId: string | number;
		username?: string;
		data?: GameStatsProfileData;
	},
	config: GameStatsApiConfig = resolveGameStatsApiConfig()
): Promise<{ outcome: "created" | "updated"; status: number }> {
	const discordUserId = requireDiscordUserId(params.discordUserId);
	const providerIssuedUserId = requireProviderIssuedUserId(params.providerIssuedUserId);
	if (params.data !== undefined) {
		assertProfileDataWithinLimits(params.data);
	}

	const username = params.username?.slice(0, USERNAME_LIMIT);
	const body: GameStatsProfilePayload = {
		...(username ? { username } : {}),
		...(params.data === undefined ? {} : { data: params.data }),
	};
	const { status } = await sendIdentityRequest(
		identityProfileUrl(config, discordUserId, providerIssuedUserId),
		config,
		{ method: "PATCH", body: JSON.stringify(body) }
	);

	return { outcome: status === 201 ? "created" : "updated", status };
}

/** Reads a player's stored profile back, for verification and debugging. */
export async function getApplicationIdentityProfile(
	params: { discordUserId: string; providerIssuedUserId: string | number },
	config: GameStatsApiConfig = resolveGameStatsApiConfig()
): Promise<ApplicationIdentityProfile> {
	const discordUserId = requireDiscordUserId(params.discordUserId);
	const providerIssuedUserId = requireProviderIssuedUserId(params.providerIssuedUserId);
	const { text } = await sendIdentityRequest(
		identityProfileUrl(config, discordUserId, providerIssuedUserId),
		config,
		{ method: "GET" }
	);
	if (!text.trim()) return {};
	try {
		return JSON.parse(text) as ApplicationIdentityProfile;
	} catch {
		throw new GameStatsRequestError(
			200,
			"[game-stats] Discord returned a profile body that is not JSON."
		);
	}
}

/** Lists a player's application identities, which is how identity conflicts get diagnosed. */
export async function listApplicationIdentities(
	params: { discordUserId: string },
	config: GameStatsApiConfig = resolveGameStatsApiConfig()
): Promise<ApplicationIdentity[]> {
	const discordUserId = requireDiscordUserId(params.discordUserId);
	const { text } = await sendIdentityRequest(
		applicationUrl(config, `/users/${discordUserId}/identities`),
		config,
		{ method: "GET" }
	);
	try {
		const parsed = JSON.parse(text || "{}") as { identities?: ApplicationIdentity[] };
		return Array.isArray(parsed.identities) ? parsed.identities : [];
	} catch {
		throw new GameStatsRequestError(
			200,
			"[game-stats] Discord returned an identity list that is not JSON."
		);
	}
}

/**
 * Deletes one application identity, which is the documented recovery path when a stale
 * provider_issued_user_id blocks writes ("Provider user ID ... does not match existing
 * identity record"). Deletion is refused for a player's last linking identity.
 */
export async function deleteApplicationIdentity(
	params: {
		discordUserId: string;
		providerType: string;
		providerIssuedUserId: string | number;
		providerId?: string;
	},
	config: GameStatsApiConfig = resolveGameStatsApiConfig()
): Promise<void> {
	const discordUserId = requireDiscordUserId(params.discordUserId);
	const providerIssuedUserId = requireProviderIssuedUserId(params.providerIssuedUserId);
	const providerType = String(params.providerType ?? "").trim();
	if (!providerType) {
		throw new GameStatsValidationError("[game-stats] provider_type is required.");
	}

	await sendIdentityRequest(
		applicationUrl(
			config,
			`/users/${discordUserId}/identities/${encodeURIComponent(providerType)}/${encodeURIComponent(providerIssuedUserId)}`
		),
		config,
		{
			method: "DELETE",
			...(params.providerId ? { body: JSON.stringify({ provider_id: params.providerId }) } : {}),
		}
	);
}
