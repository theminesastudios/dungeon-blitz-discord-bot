export type DiscordOAuthUser = {
	id: string;
	username: string;
	global_name?: string | null;
	email?: string | null;
	verified?: boolean;
	avatar?: string | null;
};

export async function getVerifiedDiscordOAuthUser(
	accessTokenInput: string
): Promise<DiscordOAuthUser> {
	const accessToken = String(accessTokenInput ?? "").trim();
	if (!accessToken) throw new Error("Discord OAuth access token is required");

	const response = await fetch("https://discord.com/api/v10/users/@me", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		throw new Error(
			`Failed to get Discord OAuth user: [${response.status}] ${response.statusText}`
		);
	}

	const user = (await response.json()) as Partial<DiscordOAuthUser>;
	if (!user.id || !user.username) {
		throw new Error("Discord OAuth user response is missing identity fields");
	}
	return {
		id: user.id,
		username: user.username,
		global_name: user.global_name ?? null,
		email: user.email ?? null,
		verified: user.verified === true,
		avatar: user.avatar ?? null,
	};
}
