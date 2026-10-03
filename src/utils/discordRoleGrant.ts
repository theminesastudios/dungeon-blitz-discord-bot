/**
 * Reading a guild member's roles.
 *
 * There is deliberately **no role-granting helper in this file any more.** The
 * Sponsor role is a *linked* role, and Discord awards linked roles from the user's
 * role-connection metadata (`PUT /users/@me/applications/{id}/role-connection`) when the
 * player authorizes — never through
 * `PUT /guilds/{guild}/members/{user}/roles/{role}`. That endpoint grants a plain role and
 * answers `403 {"message":"Missing Access","code":50001}` for a linked role, because the
 * bot does not hold Manage Roles for it. Calling it was wrong twice over: it could not
 * work, and it made the command report failure while the metadata write — the thing that
 * actually decides the outcome — never happened.
 *
 * All this module offers now is the read, which needs no elevated permission and exists
 * so a command can report what the member currently has.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

function botToken(): string | null {
	return process.env.DISCORD_BOT_TOKEN?.trim() || null;
}

/** Fetch the member's role ids, or null when they are not in the guild (or unreadable). */
export async function getGuildMemberRoleIds(
	discordUserId: string
): Promise<string[] | null> {
	const token = botToken();
	const guildId = process.env.DISCORD_GUILD_ID?.trim();
	if (!token || !guildId) return null;

	const response = await fetch(
		`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}`,
		{ headers: { Authorization: `Bot ${token}` } }
	);
	if (!response.ok) return null;

	const member = (await response.json()) as { roles?: unknown };
	return Array.isArray(member.roles)
		? member.roles.filter((role): role is string => typeof role === "string")
		: [];
}
