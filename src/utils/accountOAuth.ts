import * as crypto from "node:crypto";
import { discordOAuthConfig } from "./oauthConfig.js";
import { accountLinkScopes, resolveWidgetScopeEnabled } from "./gameStatsProfile.js";

const ACCOUNT_OAUTH_STATE_PREFIX = "dba1";
const ACCOUNT_OAUTH_TTL_MS = 10 * 60 * 1000;

type AccountOAuthState = {
	mode: "account-create";
	discordId: string;
	expiresAt: number;
	nonce: string;
};

function stateSecret(): string {
	return process.env.ACCOUNT_OAUTH_STATE_SECRET?.trim() || discordOAuthConfig.appSecret;
}

function signPayload(payload: string): string {
	return crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

export function createAccountOAuthState(discordIdInput: string, now = Date.now()): string {
	const discordId = String(discordIdInput ?? "").trim();
	if (!discordId) throw new Error("Discord user id is required");
	const payload = Buffer.from(JSON.stringify({
		mode: "account-create",
		discordId,
		expiresAt: now + ACCOUNT_OAUTH_TTL_MS,
		nonce: crypto.randomBytes(12).toString("base64url"),
	} satisfies AccountOAuthState)).toString("base64url");
	return `${ACCOUNT_OAUTH_STATE_PREFIX}.${payload}.${signPayload(payload)}`;
}

export function parseAccountOAuthState(
	stateInput: unknown,
	now = Date.now()
): AccountOAuthState | null {
	const [prefix, payload, signature, ...rest] = String(stateInput ?? "").split(".");
	if (prefix !== ACCOUNT_OAUTH_STATE_PREFIX || !payload || !signature || rest.length > 0) {
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
			parsed?.mode !== "account-create" ||
			typeof parsed.discordId !== "string" ||
			!parsed.discordId ||
			!Number.isSafeInteger(parsed.expiresAt) ||
			parsed.expiresAt < now ||
			typeof parsed.nonce !== "string" ||
			!parsed.nonce
		) {
			return null;
		}
		return parsed as AccountOAuthState;
	} catch {
		return null;
	}
}

export function isAccountOAuthState(state: unknown): boolean {
	return String(state ?? "").startsWith(`${ACCOUNT_OAUTH_STATE_PREFIX}.`);
}

export function accountOAuthStateMatchesUser(
	state: AccountOAuthState,
	discordIdInput: unknown
): boolean {
	return state.discordId === String(discordIdInput ?? "").trim();
}

/**
 * The link asks for `application_identities.write` only while the game server's
 * WIDGET_SCOPE_ENABLED switch is on: Discord refuses an unapproved scope with `invalid_scope`,
 * and that refusal fails the whole authorization, so asking unconditionally stopped accounts
 * from being created. Reading the switch from the game server keeps this link and the in-game
 * Discord login asking for exactly the same scopes.
 */
export async function createAccountOAuthUrl(discordId: string): Promise<string> {
	const url = new URL("https://discord.com/api/oauth2/authorize");
	url.searchParams.set("client_id", discordOAuthConfig.appId);
	url.searchParams.set("redirect_uri", discordOAuthConfig.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", createAccountOAuthState(discordId));
	url.searchParams.set("scope", accountLinkScopes(await resolveWidgetScopeEnabled()).join(" "));
	url.searchParams.set("prompt", "consent");
	return url.toString();
}
