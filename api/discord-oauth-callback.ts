import { MiniDatabase } from "@minesa-org/mini-interaction";
import { mini } from "./interactions.js";
import { updateDiscordMetadata } from "../src/utils/database.js";
import { discordOAuthConfig } from "../src/utils/oauthConfig.js";

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

		await updateDiscordMetadata(user.id, tokens.access_token);
	},
});

export default async function handler(req: any, res: any) {
	const q = req?.query ?? {};
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
