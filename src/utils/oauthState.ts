import * as crypto from "node:crypto";
import { discordOAuthConfig } from "./oauthConfig.js";

/**
 * The signed `state` parameter every Discord authorization link this bot hands out uses.
 *
 * Discord requires one registered redirect URI per application, so every flow shares
 * `/api/discord-oauth-callback`. There is no server-side session to bind a link to: the payload
 * carries the Discord user the link belongs to, the HMAC over it means a player cannot retarget
 * someone else's link at themselves, and the `prefix` tells the flows apart on that shared route.
 *
 * A link is only ever valid for the user who invoked the command, for a few minutes, and exactly
 * once it comes back. Account creation (`/account create`) and connections (`/authorize`) are the
 * two flows that use this; keep their prefixes distinct.
 *
 * The key is resolved here and never travels as an argument. That is not just tidier: the value
 * is an HMAC key signing this bot's own state payload, and handing it around as an option is what
 * makes a reader — or a security scan — mistake the signature for a password hash.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type SignedOAuthState = {
	mode: string;
	discordId: string;
	expiresAt: number;
	nonce: string;
};

export type OAuthStateOptions = {
	/** Namespaces the state so one callback route can serve several flows. */
	prefix: string;
};

/**
 * The one key-resolution chain, shared by every link: a dedicated state key, then the account
 * link's older variable, then the OAuth client secret — the value every deployment already has,
 * so a missing dedicated key is never a lockout. Both flows sign with the same value, which is
 * what lets one callback route serve them while their prefixes keep them apart.
 */
function oauthStateSigningKey(): string {
	return (
		process.env.OAUTH_STATE_SECRET?.trim() ||
		process.env.ACCOUNT_OAUTH_STATE_SECRET?.trim() ||
		discordOAuthConfig.appSecret
	);
}

function signPayload(payload: string): string {
	return crypto
		.createHmac("sha256", oauthStateSigningKey())
		.update(payload)
		.digest("base64url");
}

export function createSignedOAuthState(
	mode: string,
	discordIdInput: string,
	options: OAuthStateOptions & {
		now?: number;
		ttlMs?: number;
		/** Extra fields a flow needs back after the round trip (a connection id, say). */
		extra?: Record<string, unknown>;
	}
): string {
	const discordId = String(discordIdInput ?? "").trim();
	if (!discordId) throw new Error("Discord user id is required");
	const payload = Buffer.from(
		JSON.stringify({
			mode,
			discordId,
			expiresAt: (options.now ?? Date.now()) + (options.ttlMs ?? OAUTH_STATE_TTL_MS),
			nonce: crypto.randomBytes(12).toString("base64url"),
			...(options.extra ?? {}),
		})
	).toString("base64url");
	return `${options.prefix}.${payload}.${signPayload(payload)}`;
}

/** Cheap check for a raw `state` value, before spending an HMAC on it. */
export function isSignedOAuthState(stateInput: unknown, prefix: string): boolean {
	return String(stateInput ?? "").startsWith(`${prefix}.`);
}

/**
 * Verifies and decodes a returned `state`. Any tampering, any other flow's state, and any expired
 * link answers `null`, so a caller can treat a non-null result as an authenticated payload.
 */
export function parseSignedOAuthState(
	stateInput: unknown,
	options: OAuthStateOptions & { mode?: string; now?: number }
): (SignedOAuthState & Record<string, unknown>) | null {
	const [prefix, payload, signature, ...rest] = String(stateInput ?? "").split(".");
	if (prefix !== options.prefix || !payload || !signature || rest.length > 0) {
		return null;
	}
	const expected = Buffer.from(signPayload(payload), "utf8");
	const actual = Buffer.from(signature, "utf8");
	if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
		return null;
	}
	try {
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (
			typeof parsed?.mode !== "string" ||
			(options.mode !== undefined && parsed.mode !== options.mode) ||
			typeof parsed.discordId !== "string" ||
			!parsed.discordId ||
			!Number.isSafeInteger(parsed.expiresAt) ||
			parsed.expiresAt < (options.now ?? Date.now()) ||
			typeof parsed.nonce !== "string" ||
			!parsed.nonce
		) {
			return null;
		}
		return parsed as SignedOAuthState & Record<string, unknown>;
	} catch {
		return null;
	}
}

/** A link is owner-bound: only the Discord user who invoked the command can complete it. */
export function signedOAuthStateMatchesUser(
	state: SignedOAuthState,
	discordIdInput: unknown
): boolean {
	return state.discordId === String(discordIdInput ?? "").trim();
}
