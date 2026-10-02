/**
 * Granting a Discord role needs the bot REST API; the interaction payload the
 * commands see is read-only. Two endpoints are involved:
 *
 *   PUT /guilds/{guild}/members/{user}/roles/{role}   — add
 *   DELETE /guilds/{guild}/members/{user}/roles/{role} — remove
 *
 * A missing member (404) means the user is not in the guild, which the caller
 * reports as its own outcome rather than a generic failure.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type RoleGrantResult =
	| { status: "granted" | "removed" }
	| { status: "not-in-guild" }
	| { status: "failed"; detail: string };

function botToken(): string | null {
	return process.env.DISCORD_BOT_TOKEN?.trim() || null;
}

export function discordRoleGrantConfigured(): boolean {
	return Boolean(botToken() && process.env.DISCORD_GUILD_ID?.trim());
}

export async function setGuildMemberRole(
	discordUserId: string,
	roleId: string,
	mode: "add" | "remove"
): Promise<RoleGrantResult> {
	const token = botToken();
	const guildId = process.env.DISCORD_GUILD_ID?.trim();
	if (!token || !guildId) {
		return {
			status: "failed",
			detail:
				"The deployment is missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID, so roles cannot be changed from here.",
		};
	}

	const response = await fetch(
		`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,
		{
			method: mode === "add" ? "PUT" : "DELETE",
			headers: { Authorization: `Bot ${token}` },
		}
	);

	if (response.status === 204) {
		return { status: mode === "add" ? "granted" : "removed" };
	}
	if (response.status === 404) {
		return { status: "not-in-guild" };
	}
	const detail = await response.text().catch(() => "");
	return {
		status: "failed",
		detail: `Discord answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
	};
}

/** Fetch the member's role ids, or null when they are not in the guild. */
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
