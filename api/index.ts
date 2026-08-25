import { mini } from "./interactions.js";
import { discordOAuthConfig } from "../src/utils/oauthConfig.js";

// mini-interaction 0.9.0 resolves OAuth settings from process.env; importing the
// config syncs the normalized client id/secret/redirect URI (including the
// Vercel-host fallback) before the verification page is built.
void discordOAuthConfig;

export default mini.discordOAuthVerificationPage({
	htmlFile: "pages/verify.html",
	scopes: ["identify", "connections", "role_connections.write"],
});
