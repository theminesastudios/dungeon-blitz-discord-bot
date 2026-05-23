const DEFAULT_REDIRECT_URI =
	"https://discord-github-assistant-bot.vercel.app/api/discord-oauth-callback";

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

function resolveRedirectUri(): string {
	const configuredRedirectUri = cleanEnvValue(process.env.DISCORD_REDIRECT_URI);
	return configuredRedirectUri && !configuredRedirectUri.includes("localhost")
		? configuredRedirectUri
		: DEFAULT_REDIRECT_URI;
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
