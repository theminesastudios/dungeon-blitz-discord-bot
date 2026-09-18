/**
 * Discord Game Stats Widget integration: the Application Identity Profile API.
 *
 * A player's profile widget is rendered from the record this module writes — Discord never
 * reads the game server. Reads and writes both need a bot token plus a player who authorized
 * the application with `application_identities.write`.
 *
 * That scope is requested only while the widget scope switch is on: Discord approves game stats
 * per application, an unapproved application is refused the scope with `invalid_scope`, and the
 * refusal fails the whole authorization — so asking for it unconditionally stopped accounts from
 * being created at all. `resolveWidgetScopeEnabled` reads the one switch that controls it, which
 * the game server owns, so neither Discord flow can drift away from the other.
 *
 * An unapproved application is also not given these routes at all: it answers the generic
 * route-not-found body (`{"message":"404: Not Found","code":0}`) where the documented
 * permissions failure is a 403. `checkGameStatsAccess` tells the two apart, which is what an
 * operator needs, because the OAuth side reports both the same way — as `invalid_scope`.
 *
 * The guards here mirror the documented limits (10 KB serialized `data`, 30 dynamic fields,
 * 100-character string values) so an oversized payload fails locally instead of half way
 * through a sync run.
 */
const DEFAULT_API_BASE = "https://discord.com/api/v10";
const USERNAME_LIMIT = 1024;

export const APPLICATION_IDENTITIES_WRITE_SCOPE = "application_identities.write";

/** Scopes an account link asks for whatever the widget switch says. */
const ACCOUNT_LINK_BASE_SCOPES: readonly string[] = ["identify", "email"];

/** Scopes the linked-roles verification link asks for whatever the widget switch says. */
const ROLE_LINK_BASE_SCOPES: readonly string[] = [
	"identify",
	"connections",
	"role_connections.write",
];

/**
 * The scope list /account create sends to Discord.
 *
 * `application_identities.write` is added only while the widget scope is switched on. Discord
 * approves game stats per application, an unapproved application is refused that scope with
 * `invalid_scope`, and the refusal fails the *entire* authorization — so asking unconditionally
 * stopped accounts from being created at all, with nothing the player could do about it.
 */
export function accountLinkScopes(widgetScopeEnabled = false): readonly string[] {
	return widgetScopeEnabled
		? [...ACCOUNT_LINK_BASE_SCOPES, APPLICATION_IDENTITIES_WRITE_SCOPE]
		: ACCOUNT_LINK_BASE_SCOPES;
}

/** The scope list the linked-roles verification page sends. Same switch, same reasoning. */
export function roleLinkScopes(widgetScopeEnabled = false): readonly string[] {
	return widgetScopeEnabled
		? [...ROLE_LINK_BASE_SCOPES, APPLICATION_IDENTITIES_WRITE_SCOPE]
		: ROLE_LINK_BASE_SCOPES;
}

/** Where the one switch lives: the game server reports it on this endpoint. */
const WIDGET_SCOPE_PATH = "/api/auth/discord/config";
const WIDGET_SCOPE_TTL_MS = 5 * 60 * 1000;
const WIDGET_SCOPE_TIMEOUT_MS = 2500;

const widgetScopeCache = new Map<string, { value: boolean; expiresAt: number }>();

/** Test seam: forget cached switch answers so a stubbed game server gets read again. */
export function resetWidgetScopeCache(): void {
	widgetScopeCache.clear();
}

/**
 * Reads the widget scope switch from the game server, which owns it as `WIDGET_SCOPE_ENABLED`.
 *
 * This is what keeps the bot's `/account create` and the game's own Discord login asking for the
 * same scopes: one setting, no second place to forget, and no way for the two to disagree about
 * a scope Discord approves per application.
 *
 * Fail-closed. An unreachable or unhelpful game server means account scopes only, which can only
 * ever under-ask — never a link Discord refuses because the application was not approved for the
 * scope it requested. The answer is cached for a few minutes, so a link costs at most one fetch.
 */
export async function resolveWidgetScopeEnabled(
	options: { baseUrl?: string; timeoutMs?: number } = {}
): Promise<boolean> {
	const baseUrl = (options.baseUrl ?? cleanEnvValue(process.env.GAME_SERVER_BASE_URL)).replace(
		/\/+$/,
		""
	);
	if (!baseUrl) return false;

	const cached = widgetScopeCache.get(baseUrl);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WIDGET_SCOPE_TIMEOUT_MS);
	let enabled = false;
	try {
		const response = await fetch(`${baseUrl}${WIDGET_SCOPE_PATH}`, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		// Status, not `response.ok`: a failed read has to look the same however the response object
		// is shaped, and every other request in this module keys off the status too.
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`the game server answered ${response.status}`);
		}
		// text() then parse, like every other request in this module: one response shape to read, and
		// a non-JSON answer fails into the catch instead of throwing out of json().
		const body = JSON.parse(await response.text()) as { widgetScope?: unknown };
		enabled = body.widgetScope === true;
	} catch (error) {
		console.warn(
			`[game-stats] Could not read WIDGET_SCOPE_ENABLED from ${baseUrl}; requesting account scopes only. ${error instanceof Error ? error.message : String(error)}`
		);
	} finally {
		clearTimeout(timer);
	}

	widgetScopeCache.set(baseUrl, { value: enabled, expiresAt: Date.now() + WIDGET_SCOPE_TTL_MS });
	return enabled;
}

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

/** Discord refused the write: game stats are not authorized for this application. */
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
			`[game-stats] Discord refused this profile write (403): game stats are not authorized for this application. Discord approves that per application (enable the Social SDK and claim the game in the Developer Portal); checkGameStatsAccess() reports where it stands.` +
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

/**
 * How far this application's access to the Game Stats Widget API goes.
 *
 * `not-enabled` and `not-authorized` both stop every widget write, but they need different
 * fixes: the first is the application not being approved for game stats at all, the second is
 * the documented 403 for an application that is enabled but not authorized here.
 */
export type GameStatsAccessState =
	| "authorized"
	| "not-authorized"
	| "not-enabled"
	| "bad-credentials"
	| "unknown";

export type GameStatsAccessReport = {
	state: GameStatsAccessState;
	status: number | null;
	detail: string;
	/** One operator-facing sentence: what was found and what to do about it. */
	summary: string;
};

/** A probe on the OAuth failure page is worth a couple of seconds, but not an open-ended wait. */
const ACCESS_PROBE_TIMEOUT_MS = 5000;

function accessSummary(
	state: GameStatsAccessState,
	applicationId: string,
	detail: string
): string {
	switch (state) {
		case "authorized":
			return `[game-stats] Application ${applicationId} is authorized for game stats.`;
		case "not-authorized":
			return `[game-stats] Application ${applicationId} is not authorized for game stats (403): game stats must be enabled for the application in the Discord Developer Portal. ${detail}`;
		case "not-enabled":
			return (
				`[game-stats] Application ${applicationId} has no access to the Game Stats Widget API — Discord does not expose the Application Identity routes for it, and refuses the "${APPLICATION_IDENTITIES_WRITE_SCOPE}" scope with invalid_scope. ` +
				"Game stats are approved per application: enable the Social SDK and claim the game in the Discord Developer Portal, then re-check. " +
				detail
			);
		case "bad-credentials":
			return `[game-stats] Discord rejected the application credentials (401); check DISCORD_BOT_TOKEN for application ${applicationId}. ${detail}`;
		default:
			return `[game-stats] Could not determine Game Stats access for application ${applicationId}. ${detail}`;
	}
}

function describeAccessStatus(
	status: number,
	body: string,
	applicationId: string
): GameStatsAccessReport {
	const said = discordErrorMessage(body);
	const detail = said ? `Discord said: ${said}` : "Discord sent no response body.";
	// 404 is the telling one: the documented permission error on these routes is a 403, so the
	// generic route-not-found body means the routes were never published for this application.
	const state: GameStatsAccessState =
		status === 200
			? "authorized"
			: status === 401
				? "bad-credentials"
				: status === 403
					? "not-authorized"
					: status === 404
						? "not-enabled"
						: "unknown";

	return { state, status, detail, summary: accessSummary(state, applicationId, detail) };
}

/**
 * Probes the application's own access to the Game Stats Widget API by reading one player's
 * identity list, which is the cheapest documented route. `discordUserId` only has to be a
 * well-formed snowflake: the routes are published per application, not per user.
 *
 * Never throws — an unreachable Discord is reported as `unknown` so a caller can keep going.
 */
export async function checkGameStatsAccess(
	params: { discordUserId: string; timeoutMs?: number },
	config: GameStatsApiConfig = resolveGameStatsApiConfig()
): Promise<GameStatsAccessReport> {
	const discordUserId = requireDiscordUserId(params.discordUserId);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? ACCESS_PROBE_TIMEOUT_MS);

	try {
		const response = await fetch(applicationUrl(config, `/users/${discordUserId}/identities`), {
			method: "GET",
			headers: { Authorization: `Bot ${config.botToken}` },
			signal: controller.signal,
		});
		const text = await response.text();
		return describeAccessStatus(response.status, text, config.applicationId);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			state: "unknown",
			status: null,
			detail,
			summary: accessSummary("unknown", config.applicationId, detail),
		};
	} finally {
		clearTimeout(timer);
	}
}
