import {
	getOAuthTokens,
	MiniDatabase,
} from "@minesa-org/mini-interaction";
import { mini } from "./interactions.js";
import { updateDiscordMetadata } from "../src/utils/database.js";
import { discordOAuthConfig } from "../src/utils/oauthConfig.js";
import {
	accountOAuthStateMatchesUser,
	isAccountOAuthState,
	parseAccountOAuthState,
} from "../src/utils/accountOAuth.js";
import {
	createGameAccountFromDiscord,
	GameAccountConflictError,
} from "../src/utils/gameAccount.js";
import { getVerifiedDiscordOAuthUser } from "../src/utils/discordOAuthUser.js";

const database = MiniDatabase.fromEnv();
const failedPage = mini.failedOAuthPage("pages/failed.html");

// Dungeon Blitz game logins reuse this registered redirect URI. The game
// server signs its own state ("<base64url-json>.<base64url-hmac>") carrying a
// `cb` return origin; when we see that shape, relay the browser to the game
// server's callback instead of running the linked-roles flow. The game server
// verifies the HMAC itself, and the auth code is useless without the client
// secret, so this relay only needs to validate the target origin's shape.
function parseGameCb(state: unknown): string | null {
	const parts = String(state ?? "").split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	try {
		const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
		if (p?.mode !== "login" && p?.mode !== "link") return null;
		const cb = new URL(String(p?.cb ?? ""));
		if (cb.protocol !== "http:" && cb.protocol !== "https:") return null;
		return cb.origin;
	} catch {
		return null;
	}
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function sendAccountPage(
	res: any,
	statusCode: number,
	title: string,
	message: string
) {
	res.statusCode = statusCode;
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.setHeader("x-content-type-options", "nosniff");
	res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { max-width: 34rem; margin: 1.5rem; padding: 2rem; border: 1px solid #374151; border-radius: 1rem; background: #1f2937; }
    h1 { margin-top: 0; color: #a5b4fc; }
    p { line-height: 1.6; margin-bottom: 0; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`);
}

async function handleAccountOAuth(req: any, res: any) {
	const q = req?.query ?? {};
	const state = parseAccountOAuthState(q.state);
	if (!state) {
		sendAccountPage(res, 400, "Invalid link", "The OAuth link has expired or was modified. Run /create-account again in Discord.");
		return;
	}
	if (typeof q.error === "string" && q.error) {
		sendAccountPage(res, 400, "Authorization cancelled", "The Dungeon Blitz account was not created. You can reopen the link from Discord.");
		return;
	}
	if (typeof q.code !== "string" || !q.code) {
		sendAccountPage(res, 400, "Missing code", "The Discord OAuth code was not received. Run /create-account again.");
		return;
	}

	try {
		const tokens = await getOAuthTokens(q.code, discordOAuthConfig);
		const scopes = String(tokens.scope ?? "").split(/\s+/).filter(Boolean);
		if (!scopes.includes("identify") || !scopes.includes("email")) {
			throw new GameAccountConflictError("Discord OAuth requires the identify and email scopes.");
		}
		const user = await getVerifiedDiscordOAuthUser(tokens.access_token);
		if (!accountOAuthStateMatchesUser(state, user.id)) {
			sendAccountPage(res, 403, "Discord account mismatch", "Only the Discord account that ran /create-account can complete this OAuth link.");
			return;
		}

		const result = await createGameAccountFromDiscord({
			id: user.id,
			username: user.username,
			globalName: user.global_name,
			email: user.email,
			emailVerified: user.verified === true,
			avatar: user.avatar,
		});
		const message = result.account.passwordConfigured
			? `Your Discord account is already linked to ${result.account.email}. You can view it with /account view in Discord.`
			: `Your account is ready with ${result.account.email}. Return to Discord and select “Set initial password” in the /create-account message.`;
		sendAccountPage(
			res,
			200,
			result.status === "created" ? "Your Dungeon Blitz account was created" : "Your Dungeon Blitz account is already linked",
			message
		);
	} catch (error) {
		if (error instanceof GameAccountConflictError) {
			sendAccountPage(res, 409, "Account could not be created", error.message);
			return;
		}
		console.error("[account-oauth] Account creation failed:", error);
		sendAccountPage(res, 500, "Account could not be created", "An unexpected error occurred. Please try /create-account again later.");
	}
}

const linkedRolesHandler = mini.discordOAuthCallback({
	oauth: discordOAuthConfig,
	templates: {
		success: mini.connectedOAuthPage("pages/connected.html"),
		missingCode: failedPage,
		oauthError: failedPage,
		invalidState: failedPage,
		serverError: failedPage,
	},
	async onAuthorize({ user, tokens }: { user: any; tokens: any }) {
		const scopes = String(tokens.scope ?? "")
			.split(/\s+/)
			.filter(Boolean);
		const requiredScopes = ["role_connections.write"];
		const missingScopes = requiredScopes.filter(
			(scope) => !scopes.includes(scope)
		);

		if (missingScopes.length > 0) {
			throw new Error(
				`Missing required OAuth scopes: ${missingScopes.join(", ")}`
			);
		}

		if (!scopes.includes("connections")) {
			console.warn(
				"[discord-oauth-callback] connections scope missing; GitHub link may not be available."
			);
		}

		await database.set(user.id, {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: tokens.expires_at,
			scope: tokens.scope,
		});

		try {
			await updateDiscordMetadata(user.id, tokens.access_token);
		} catch (error) {
			console.error(
				"[discord-oauth-callback] OAuth tokens were stored, but linked-role metadata refresh failed:",
				error
			);
		}
	},
});

export default async function handler(req: any, res: any) {
	const q = req?.query ?? {};
	if (isAccountOAuthState(q.state)) {
		return handleAccountOAuth(req, res);
	}
	const origin = parseGameCb(q.state);
	if (origin) {
		const target = new URL("/api/discord-linked-roles/callback", origin);
		for (const key of ["code", "state", "error", "error_description"]) {
			const value = q[key];
			if (typeof value === "string" && value) {
				target.searchParams.set(key, value);
			}
		}
		res.statusCode = 302;
		res.setHeader("Location", target.toString());
		res.end();
		return;
	}

	return linkedRolesHandler(req, res);
}
