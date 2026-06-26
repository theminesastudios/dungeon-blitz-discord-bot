const FALLBACK_REDIRECT_HOST = "discord-github-assistant-bot.vercel.app";
const CALLBACK_PATH = "/api/discord-oauth-callback";

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

function ensureHttpsUrl(value: string): string {
	const trimmed = value.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}

	return `https://${trimmed}`;
}

function normalizeVercelHost(value: string): string {
	return value
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/$/, "");
}

function normalizeConfiguredRedirectUri(value: string): string {
	const withProtocol = ensureHttpsUrl(value);
	try {
		const parsed = new URL(withProtocol);
		if (parsed.pathname === "/" || parsed.pathname === "") {
			parsed.pathname = CALLBACK_PATH;
		}
		return parsed.toString();
	} catch {
		return withProtocol;
	}
}

function buildRedirectUriFromHost(host: string): string {
	return `https://${normalizeVercelHost(host)}${CALLBACK_PATH}`;
}

function getDefaultRedirectUri(): string {
	const productionHost = cleanEnvValue(process.env.VERCEL_PROJECT_PRODUCTION_URL);
	if (productionHost) {
		return buildRedirectUriFromHost(productionHost);
	}

	const deploymentHost = cleanEnvValue(process.env.VERCEL_URL);
	if (deploymentHost) {
		return buildRedirectUriFromHost(deploymentHost);
	}

	return buildRedirectUriFromHost(FALLBACK_REDIRECT_HOST);
}

function warnIfRedirectUriLooksWrong(redirectUri: string, source: string) {
	if (!redirectUri.startsWith("https://")) {
		console.warn(
			`[discord-oauth] ${source} redirect URI is not HTTPS: ${redirectUri}`
		);
	}

	if (!redirectUri.endsWith(CALLBACK_PATH)) {
		console.warn(
			`[discord-oauth] ${source} redirect URI does not end with "${CALLBACK_PATH}": ${redirectUri}`
		);
	}

	if (redirectUri.includes("minesa-org")) {
		console.warn(
			`[discord-oauth] ${source} redirect URI still references the old organization name: ${redirectUri}`
		);
	}
}

function logResolvedRedirectUri(redirectUri: string, source: string) {
	try {
		const parsed = new URL(redirectUri);
		console.info(
			`[discord-oauth] Using ${source} redirect URI: ${parsed.protocol}//${parsed.host}${parsed.pathname}`
		);
	} catch {
		console.warn(`[discord-oauth] Using ${source} redirect URI: ${redirectUri}`);
	}
}

function resolveRedirectUri(): string {
	const configuredRedirectUri = cleanEnvValue(process.env.DISCORD_REDIRECT_URI);
	const source =
		configuredRedirectUri && !configuredRedirectUri.includes("localhost")
			? "configured"
			: "Vercel-derived fallback";
	const redirectUri =
		source === "configured"
			? normalizeConfiguredRedirectUri(configuredRedirectUri)
			: getDefaultRedirectUri();

	warnIfRedirectUriLooksWrong(redirectUri, source);
	logResolvedRedirectUri(redirectUri, source);

	return redirectUri;
}

function resolveAppId(): string {
	const applicationId = cleanEnvValue(process.env.DISCORD_APPLICATION_ID);
	const clientId = cleanEnvValue(process.env.DISCORD_CLIENT_ID);

	if (applicationId && clientId && applicationId !== clientId) {
		throw new Error(
			"[discord-oauth] DISCORD_APPLICATION_ID and DISCORD_CLIENT_ID are both set but do not match."
		);
	}

	return applicationId || clientId;
}

function createDiscordOAuthConfig() {
	const appId = resolveAppId();
	const appSecret = cleanEnvValue(process.env.DISCORD_CLIENT_SECRET);
	const redirectUri = resolveRedirectUri();

	const missing = [];
	if (!appId) missing.push("DISCORD_APPLICATION_ID or DISCORD_CLIENT_ID");
	if (!appSecret) missing.push("DISCORD_CLIENT_SECRET");

	if (missing.length > 0) {
		throw new Error(
			`[discord-oauth] Missing required OAuth configuration: ${missing.join(
				", "
			)}.`
		);
	}

	return {
		appId,
		appSecret,
		redirectUri,
	};
}

export const discordOAuthConfig = createDiscordOAuthConfig();
