import {
	MiniDatabase,
	refreshAccessToken,
	type OAuthTokens,
} from "@minesa-org/mini-interaction";
import {
	getDiscordGithubUsername,
	getSponsorMatch,
	getContributorMatch,
} from "./githubSponsors.js";
import { getDirectSponsorMatch } from "./githubSponsorDirect.js";

/**
 * Shared database instance for the application.
 */
export const db = MiniDatabase.fromEnv();

const MINI_DB_RESERVED_FIELDS = new Set(["createdAt"]);

function asUpdatableRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") return {};

	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record).filter(
			([key]) => !MINI_DB_RESERVED_FIELDS.has(key)
		)
	);
}

/**
 * Gets user data from the database.
 */
export async function getUserData(userId: string) {
	try {
		return await db.get(userId);
	} catch (error) {
		console.error("❌ Error getting user data:", error);
		throw error;
	}
}

/**
 * Sets user's is_miniapp status.
 * Always true. No gating. Everyone connects.
 */
export async function setUserMiniAppStatus(userId: string) {
	try {
		const existing = await db.get(userId).catch(() => null);
		const base = asUpdatableRecord(existing);
		return await db.set(userId, {
			...base,
			userId,
			is_miniapp: true,
			lastUpdated: Date.now(),
		});
	} catch (error) {
		console.error("❌ Error setting user miniapp status:", error);
		throw error;
	}
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** The vanity platform name this application registers with Discord. */
const ROLE_CONNECTION_PLATFORM_NAME = "Dungeon Blitz";

/**
 * Renew a stored access token slightly before Discord would reject it, so a token
 * cannot lapse between the expiry check and the request that uses it.
 */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type RoleConnectionPayload = {
	platform_name: string;
	platform_username?: string;
	metadata: Record<string, string>;
};

/** Badge values are stringified; the registered key shows this on hover. */
function roleConnectionBadge(value: boolean): string {
	return value ? "1" : "0";
}

function asTrimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, entryValue]) => typeof entryValue === "string"
		)
	) as Record<string, string>;
}

function roleConnectionApplicationId(): string {
	return (
		process.env.DISCORD_APPLICATION_ID?.trim() ||
		process.env.DISCORD_CLIENT_ID?.trim() ||
		""
	);
}

/**
 * The linked-role body, built from freshly verified facts. This is the exact shape
 * the verification page has always sent; the staff path reuses it so a badge granted
 * by hand and a badge earned by verifying look the same to Discord.
 */
export function roleConnectionPayload(input: {
	githubUsername?: string | null;
	isSponsor: boolean;
	isContributor: boolean;
}): RoleConnectionPayload {
	return {
		platform_name: ROLE_CONNECTION_PLATFORM_NAME,
		...(input.githubUsername ? { platform_username: input.githubUsername } : {}),
		metadata: {
			is_sponsor: roleConnectionBadge(input.isSponsor),
			contributor: roleConnectionBadge(input.isContributor),
		},
	};
}

/**
 * The same payload, but merged over what Discord already holds.
 *
 * The write replaces the entire connection, so a metadata key this command knows
 * nothing about would be dropped by a naive send. Reading the current connection
 * first and layering only the sponsor key on top keeps every other key intact —
 * including `contributor`, which belongs to the verification flow and must not be
 * reset by a staff role change.
 */
export function mergeRoleConnectionPayload(
	current: Record<string, unknown>,
	input: {
		githubUsername?: string | null;
		isSponsor: boolean;
		/** Left undefined when the stored profile has no opinion, so the current value stands. */
		isContributor?: boolean;
	}
): RoleConnectionPayload {
	const storedMetadata = asStringRecord(current.metadata);
	const base = roleConnectionPayload({
		githubUsername: input.githubUsername || asTrimmedString(current.platform_username),
		isSponsor: input.isSponsor,
		isContributor: input.isContributor ?? storedMetadata.contributor === roleConnectionBadge(true),
	});

	return { ...base, metadata: { ...storedMetadata, ...base.metadata } };
}

/**
 * Writes the linked-role connection.
 *
 * Discord only accepts this from the player's own OAuth token:
 * `PUT /users/@me/applications/{id}/role-connection` requires an access token with
 * the `role_connections.write` scope for that application, and there is no bot-token
 * equivalent. For a *linked* role this write is not just the badge — it **is** how the
 * role is awarded, so there is no role endpoint that could do it instead. Which is
 * also why a staff push has to reuse the token the player granted during verification.
 */
async function putRoleConnection(
	accessToken: string,
	payload: RoleConnectionPayload
): Promise<Record<string, unknown>> {
	const applicationId = roleConnectionApplicationId();
	if (!applicationId) {
		throw new Error(
			"Failed to update Discord metadata: the deployment has no DISCORD_APPLICATION_ID."
		);
	}

	const response = await fetch(
		`${DISCORD_API_BASE}/users/@me/applications/${applicationId}/role-connection`,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		}
	);

	if (!response.ok) {
		throw new Error(
			`Failed to update Discord metadata: ${await response.text().catch(() => "")}`
		);
	}

	// Discord answers the write with the connection it stored, so the caller can act on
	// what was actually recorded rather than on what was asked for.
	return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** What Discord currently stores for this player's connection. Throws if it cannot be read. */
async function readRoleConnection(accessToken: string): Promise<Record<string, unknown>> {
	const applicationId = roleConnectionApplicationId();
	const response = await fetch(
		`${DISCORD_API_BASE}/users/@me/applications/${applicationId}/role-connection`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);

	if (!response.ok) {
		throw new Error(`Discord answered ${response.status} reading the role connection.`);
	}

	return (await response.json()) as Record<string, unknown>;
}

type TokenRenewal =
	| { status: "renewed"; accessToken: string }
	| { status: "not-configured"; detail: string }
	| { status: "reauth-required"; detail: string };

/**
 * Renews the player's stored verification token through the refresh-token grant.
 *
 * This needs no interaction from the player, which is the point: an access token
 * issued months ago is long expired, and refusing to refresh would put the command
 * right back to "ask them to run the verification page again".
 */
async function renewLinkedRolesToken(
	userId: string,
	record: Record<string, unknown>,
	applicationId: string
): Promise<TokenRenewal> {
	const refreshToken = asTrimmedString(record.refreshToken);
	if (!refreshToken) {
		return {
			status: "reauth-required",
			detail: "their stored verification link has expired and holds no refresh token",
		};
	}

	const appSecret = process.env.DISCORD_CLIENT_SECRET?.trim() ?? "";
	if (!appSecret) {
		return {
			status: "not-configured",
			detail: "the deployment has no DISCORD_CLIENT_SECRET to renew their verification link",
		};
	}

	let tokens: OAuthTokens;
	try {
		tokens = await refreshAccessToken(refreshToken, {
			appId: applicationId,
			appSecret,
			// Never used by the refresh grant, but the config type requires it. Read
			// straight from the environment instead of importing oauthConfig.js, which
			// throws at module load and would take this command's import graph with it.
			redirectUri: process.env.DISCORD_REDIRECT_URI?.trim() ?? "",
		});
	} catch (error) {
		return {
			status: "reauth-required",
			detail: `their stored verification link could not be renewed (${
				error instanceof Error ? error.message : String(error)
			})`,
		};
	}

	// Discord rotates the refresh token on renewal, so the new pair has to be stored
	// or the next push would try a token the app has already retired.
	try {
		await db.set(userId, {
			...record,
			userId,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? refreshToken,
			expiresAt: tokens.expires_at,
			scope: tokens.scope ?? record.scope,
			lastUpdated: Date.now(),
		});
	} catch (error) {
		// The badge still updates with the token in hand; the stored copy merely goes
		// stale again, and the next attempt reports the same renewal problem.
		console.error(
			"[pushSponsorRoleConnection] Could not store the renewed verification token:",
			error
		);
	}

	return { status: "renewed", accessToken: tokens.access_token };
}

export type RoleConnectionPushResult =
	| { status: "pushed"; isSponsor: boolean }
	| { status: "not-configured"; detail: string }
	| { status: "not-linked" }
	| { status: "reauth-required"; detail: string }
	| { status: "failed"; detail: string };

/**
 * Pushes the player's linked-role metadata with `isSponsor` set. **This is what awards the
 * sponsor role**: Discord grants a linked role from the metadata, so writing `is_sponsor`
 * to 1 is the whole grant — there is no role endpoint to call.
 *
 * Only the role-connection payload is touched. The sponsor flag on the stored profile
 * is deliberately left alone: it was just set by the caller from the operator's
 * decision, and re-deriving it from GitHub here would immediately undo a manual grant
 * for someone who sponsors nothing on GitHub.
 *
 * Never throws. A failure is reported as a status, because the stored sponsor flag has
 * already been written and must not be reported as undone by a badge that would not move.
 */
export async function pushSponsorRoleConnection(
	userId: string,
	isSponsor: boolean
): Promise<RoleConnectionPushResult> {
	const applicationId = roleConnectionApplicationId();
	if (!applicationId) {
		return {
			status: "not-configured",
			detail: "the deployment has no DISCORD_APPLICATION_ID",
		};
	}

	const record = asUpdatableRecord(await db.get(userId).catch(() => null));
	const storedAccessToken = asTrimmedString(record.accessToken);
	if (!storedAccessToken) {
		return { status: "not-linked" };
	}

	let accessToken = storedAccessToken;

	const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : 0;
	if (!expiresAt || Date.now() + TOKEN_REFRESH_SKEW_MS >= expiresAt) {
		const renewal = await renewLinkedRolesToken(userId, record, applicationId);
		if (renewal.status !== "renewed") return renewal;
		accessToken = renewal.accessToken;
	}

	let current: Record<string, unknown> = {};
	try {
		current = await readRoleConnection(accessToken);
	} catch (error) {
		// A connection that cannot be read is pushed over blind, which still fixes the
		// sponsor key. Only keys this command knows about are at risk, and the caller
		// is told the read failed via the console line rather than a silent overwrite.
		console.warn(
			`[pushSponsorRoleConnection] Could not read the current role connection for "${userId}"; pushing the known keys only:`,
			error
		);
	}

	const payload = mergeRoleConnectionPayload(current, {
		githubUsername: asTrimmedString(record.githubUsername),
		isSponsor,
		isContributor: record.isContributor === true ? true : undefined,
	});

	try {
		await putRoleConnection(accessToken, payload);
		return { status: "pushed", isSponsor };
	} catch (error) {
		return {
			status: "failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Updates user metadata for Discord linked roles.
 * is_miniapp is always true.
 */
export async function updateDiscordMetadata(
	userId: string,
	accessToken: string
) {
	await setUserMiniAppStatus(userId);

	const githubUsername = await getDiscordGithubUsername(accessToken);
	console.info(
		`[updateDiscordMetadata] Linked roles refresh for Discord user "${userId}" resolved GitHub username: ${githubUsername ?? "(none)"}`
	);

	let sponsorMatch = {
		isSponsor: false,
		matchedTarget: null as string | null,
	};

	let contributorMatch = {
		isContributor: false,
	};

	if (githubUsername) {
		try {
			sponsorMatch = await getSponsorMatch(githubUsername);
			if (!sponsorMatch.isSponsor) {
				sponsorMatch = await getDirectSponsorMatch(githubUsername);
			}
		} catch (error) {
			console.error("[updateDiscordMetadata] Sponsor check failed:", error);
		}

		try {
			contributorMatch = await getContributorMatch(githubUsername);
		} catch (error) {
			console.error(
				"[updateDiscordMetadata] Contributor check failed:",
				error
			);
		}
	}

	const existing = await db.get(userId).catch(() => null);
	const base = asUpdatableRecord(existing);

	await db.set(userId, {
		...base,
		githubUsername: githubUsername ?? null,
		isSponsor: sponsorMatch.isSponsor,
		sponsorTarget: sponsorMatch.matchedTarget,
		isContributor: contributorMatch.isContributor,
		lastUpdated: Date.now(),
	});
	console.info(
		`[updateDiscordMetadata] Result for Discord user "${userId}": github="${githubUsername ?? "(none)"}", sponsor=${sponsorMatch.isSponsor}, sponsorTarget=${sponsorMatch.matchedTarget ?? "(none)"}, contributor=${contributorMatch.isContributor}`
	);

	const metadata = roleConnectionPayload({
		githubUsername,
		isSponsor: sponsorMatch.isSponsor,
		isContributor: contributorMatch.isContributor,
	});

	return await putRoleConnection(accessToken, metadata);
}
