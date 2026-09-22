import { discordOAuthConfig } from "./oauthConfig.js";
import {
	createSignedOAuthState,
	isSignedOAuthState,
	parseSignedOAuthState,
	signedOAuthStateMatchesUser,
	type SignedOAuthState,
} from "./oauthState.js";
import {
	accountLinkScopes,
	resolveWidgetScopeEnabled,
} from "./gameStatsProfile.js";

const ACCOUNT_OAUTH_STATE_PREFIX = "dba1";

type AccountOAuthState = SignedOAuthState & { mode: "account-create" };

/**
 * The account link predates `OAUTH_STATE_SECRET`, so it keeps its own variable first and falls
 * back to the OAuth client secret — the one value every deployment already has, which is what
 * keeps a missing dedicated secret from locking players out of creating an account.
 */
function accountOAuthStateOptions() {
	return {
		prefix: ACCOUNT_OAUTH_STATE_PREFIX,
		secret: process.env.ACCOUNT_OAUTH_STATE_SECRET?.trim() || discordOAuthConfig.appSecret,
	};
}

export function createAccountOAuthState(discordIdInput: string, now = Date.now()): string {
	return createSignedOAuthState("account-create", discordIdInput, {
		...accountOAuthStateOptions(),
		now,
	});
}

export function parseAccountOAuthState(
	stateInput: unknown,
	now = Date.now()
): AccountOAuthState | null {
	return parseSignedOAuthState(stateInput, {
		...accountOAuthStateOptions(),
		mode: "account-create",
		now,
	}) as AccountOAuthState | null;
}

export function isAccountOAuthState(state: unknown): boolean {
	return isSignedOAuthState(state, ACCOUNT_OAUTH_STATE_PREFIX);
}

export function accountOAuthStateMatchesUser(
	state: AccountOAuthState,
	discordIdInput: unknown
): boolean {
	return signedOAuthStateMatchesUser(state, discordIdInput);
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
