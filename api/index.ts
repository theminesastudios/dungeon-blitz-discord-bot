import { mini } from "./interactions.js";
import { discordOAuthConfig } from "../src/utils/oauthConfig.js";
import {
	roleLinkScopes,
	resolveWidgetScopeEnabled,
} from "../src/utils/gameStatsProfile.js";

// mini-interaction 0.9.0 resolves OAuth settings from process.env; importing the
// config syncs the normalized client id/secret/redirect URI (including the
// Vercel-host fallback) before the verification page is built.
void discordOAuthConfig;

// The scopes are resolved on the first request rather than at import time, because whether the
// Game Stats Widget scope may be requested depends on a switch the game server owns and needs a
// fetch to read. Building the page once and reusing it keeps every later request free of that
// cost, and keeps this page asking for the same scopes as /account create.
let verificationPage: any = null;

async function handler(req: any, res: any) {
	if (!verificationPage) {
		verificationPage = mini.discordOAuthVerificationPage({
			htmlFile: "pages/verify.html",
			scopes: [...roleLinkScopes(await resolveWidgetScopeEnabled())],
		});
	}
	return verificationPage(req, res);
}

export default handler;
