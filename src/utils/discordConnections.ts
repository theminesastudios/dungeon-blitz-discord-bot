import { discordOAuthConfig } from "./oauthConfig.js";
import {
	createSignedOAuthState,
	isSignedOAuthState,
	parseSignedOAuthState,
	signedOAuthStateMatchesUser,
	type SignedOAuthState,
} from "./oauthState.js";
import {
	APPLICATION_IDENTITIES_WRITE_SCOPE,
	resolveWidgetScopeEnabled,
} from "./gameStatsProfile.js";

/**
 * The connections `/authorize` hands out links for.
 *
 * Discord's game surfaces are authorized per player, and the two families ask for different
 * scopes (see the Social SDK's OAuth2 scopes page):
 *
 * - `application_identities.write` is what lets the bot write the profile record behind a **Game
 *   Stats widget**. Discord approves that scope per application, so it is requested only while
 *   the game server's `WIDGET_SCOPE_ENABLED` switch is on — an unapproved scope is refused with
 *   `invalid_scope` and that refusal fails the *whole* authorization.
 * - `sdk.social_layer_presence` and `sdk.social_layer` are the Social SDK's own scopes: friends,
 *   rich presence, and (with `sdk.social_layer`) lobbies, invites and in-game chat. Discord
 *   documents them as already covering `application_identities.write`, so a player who authorizes
 *   either also gets game-stats access — that is why `grantedConnections` treats them as the
 *   widget too.
 *
 * `openid` is what the Social SDK flows return an id token for; `identify` is how the callback
 * verifies which Discord user actually completed the link.
 */

export const AUTHORIZE_LINK_STATE_PREFIX = "dba2";

export const SOCIAL_LAYER_PRESENCE_SCOPE = "sdk.social_layer_presence";
export const SOCIAL_LAYER_SCOPE = "sdk.social_layer";

/** The connections a player can hold. `everything` is a link, not a connection. */
export type DiscordConnectionId = "widget" | "presence" | "lobbies";
export type DiscordConnectionChoice = DiscordConnectionId | "everything";

export type DiscordConnection = {
	id: DiscordConnectionChoice;
	label: string;
	/** One line for the overview. */
	summary: string;
	/** What authorizing it does, in player terms. */
	detail: string;
	/** Scopes this link asks for, before the widget switch is applied. */
	scopes: readonly string[];
	/** Whether `application_identities.write` is added while the widget switch is on. */
	widgetWrite?: boolean;
};

export const DISCORD_CONNECTIONS: readonly DiscordConnection[] = [
	{
		id: "widget",
		label: "Game Stats widget",
		summary: "Show your featured character on your Discord profile",
		detail:
			"Puts your featured character — name, class, level and wallet — on a widget on your Discord profile, so friends see your progress without opening the game.",
		scopes: ["identify"],
		widgetWrite: true,
	},
	{
		id: "presence",
		label: "Friends & rich presence",
		summary: "Show what you're playing and bring your Discord friends into the game",
		detail:
			"Rich presence on your profile while you play, plus your Discord friends list inside the game so you can party up and get invites without leaving it.",
		scopes: ["identify", "openid", SOCIAL_LAYER_PRESENCE_SCOPE],
	},
	{
		id: "lobbies",
		label: "Lobbies & chat",
		summary: "Run game lobbies, invites and chat through Discord",
		detail:
			"Discord-backed lobbies, one-click game invites and in-game text and voice chat. This covers friends and rich presence too, and Discord counts it as Game Stats access as well.",
		scopes: ["identify", "openid", SOCIAL_LAYER_SCOPE],
	},
	{
		id: "everything",
		label: "Everything",
		summary: "All connections in a single authorization",
		detail:
			"One screen that authorizes the profile widget, friends and rich presence, and lobbies and chat together.",
		// `sdk.social_layer` already implies game-stats access, so the widget scope is not asked
		// for separately: a redundant scope the application has not been approved for would fail
		// the entire authorization.
		scopes: ["identify", "openid", SOCIAL_LAYER_SCOPE],
	},
];

export function findDiscordConnection(id: unknown): DiscordConnection | null {
	const wanted = String(id ?? "").trim();
	return DISCORD_CONNECTIONS.find((connection) => connection.id === wanted) ?? null;
}

export function isDiscordConnectionChoice(id: unknown): id is DiscordConnectionChoice {
	return findDiscordConnection(id) !== null;
}

/**
 * The scopes one link asks for. Only the widget's own link adds `application_identities.write`,
 * and only while the game server reports the switch on — the same fail-closed read `/account
 * create` uses, so a link can only ever under-ask, never request a scope Discord refuses.
 */
export function connectionScopes(
	connection: DiscordConnection,
	widgetScopeEnabled: boolean
): string[] {
	return [
		...connection.scopes,
		...(connection.widgetWrite && widgetScopeEnabled
			? [APPLICATION_IDENTITIES_WRITE_SCOPE]
			: []),
	];
}

/**
 * The connections a returned scope list actually covers. Discord reports granted scopes, not
 * requested ones, so this is the only honest answer to "what did the player just connect?".
 */
export function grantedConnections(scopes: readonly unknown[]): DiscordConnectionId[] {
	const granted = new Set(
		(scopes ?? []).map((scope) => String(scope ?? "").trim()).filter(Boolean)
	);
	const socialLayer = granted.has(SOCIAL_LAYER_SCOPE);
	const presence = socialLayer || granted.has(SOCIAL_LAYER_PRESENCE_SCOPE);
	// The Social SDK scopes include game-stats access, so either one covers the widget.
	const widget = presence || granted.has(APPLICATION_IDENTITIES_WRITE_SCOPE);

	return [
		...(widget ? (["widget"] as const) : []),
		...(presence ? (["presence"] as const) : []),
		...(socialLayer ? (["lobbies"] as const) : []),
	];
}

/** A player-facing report of a granted scope list, for the OAuth result page. */
export function describeGrantedConnections(scopes: readonly unknown[]): string[] {
	return grantedConnections(scopes).map((id) => findDiscordConnection(id)?.label ?? id);
}

export function createAuthorizeOAuthState(
	discordId: string,
	connection: DiscordConnectionChoice,
	now = Date.now()
): string {
	return createSignedOAuthState("authorize", discordId, {
		prefix: AUTHORIZE_LINK_STATE_PREFIX,
		now,
		extra: { connection },
	});
}

export type AuthorizeOAuthState = SignedOAuthState & {
	mode: "authorize";
	connection: DiscordConnectionChoice;
};

export function isAuthorizeOAuthState(state: unknown): boolean {
	return isSignedOAuthState(state, AUTHORIZE_LINK_STATE_PREFIX);
}

/** Verifies a returned `state` and rejects one naming a connection this bot does not have. */
export function parseAuthorizeOAuthState(
	stateInput: unknown,
	now = Date.now()
): AuthorizeOAuthState | null {
	const state = parseSignedOAuthState(stateInput, {
		prefix: AUTHORIZE_LINK_STATE_PREFIX,
		mode: "authorize",
		now,
	});
	if (!state || !isDiscordConnectionChoice(state.connection)) return null;
	return state as AuthorizeOAuthState;
}

export function authorizeOAuthStateMatchesUser(
	state: AuthorizeOAuthState,
	discordIdInput: unknown
): boolean {
	return signedOAuthStateMatchesUser(state, discordIdInput);
}

/**
 * The authorization link for one player and one connection. `prompt=consent` is deliberate:
 * without it Discord skips its screen for an already-authorized app, and a player who linked
 * before the widget existed would never be shown the new connections to approve.
 */
export async function createAuthorizeOAuthUrl(
	discordId: string,
	connection: DiscordConnectionChoice
): Promise<{ url: string; widgetScopeEnabled: boolean }> {
	const target = findDiscordConnection(connection);
	if (!target) throw new Error(`Unknown Discord connection: ${connection}`);
	const widgetScopeEnabled = await resolveWidgetScopeEnabled();

	const url = new URL("https://discord.com/api/oauth2/authorize");
	url.searchParams.set("client_id", discordOAuthConfig.appId);
	url.searchParams.set("redirect_uri", discordOAuthConfig.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", createAuthorizeOAuthState(discordId, connection));
	url.searchParams.set("scope", connectionScopes(target, widgetScopeEnabled).join(" "));
	url.searchParams.set("prompt", "consent");
	return { url: url.toString(), widgetScopeEnabled };
}
