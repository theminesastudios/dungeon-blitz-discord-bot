import dotenv from "dotenv";
// Locally, the full set (including DISCORD_GUILD_ID) is in .env.production.local
// (`vercel env pull`); the first file that sets a variable wins. On Vercel neither
// file exists and the project's environment is used as-is.
dotenv.config({ path: [".env.production.local", ".env"] });

/**
 * Command registration for a public bot (issue #60):
 *
 * - The player-facing commands are registered **globally**, so every guild the
 *   bot is added to offers them. Global commands take up to an hour to appear.
 *   The Activity's Entry Point command is global by nature and is kept.
 * - The staff commands stay on the one community guild (DISCORD_GUILD_ID):
 *   `default_member_permissions` Administrator would otherwise let an
 *   administrator of *any* guild the bot joins ban players, restart the game
 *   server or edit its `.env`.
 * - Linked role metadata is application-wide and is synced here too.
 */

if (
	process.env.VERCEL_ENV === "preview" &&
	process.env.ALLOW_PREVIEW_COMMAND_REGISTRATION !== "true"
) {
	console.log("Preview deployment detected. Skipping Discord command registration.");
	process.exit(0);
}

const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

for (const [name, value] of [
	["DISCORD_BOT_TOKEN", botToken],
	["DISCORD_APPLICATION_ID", applicationId],
] as const) {
	if (!value) {
		console.log(`⚠️ ${name} not found. Skipping command registration.`);
		process.exit(0);
	}
}
if (!guildId) {
	console.log("⚠️ DISCORD_GUILD_ID not found. Staff commands will not be registered on the community guild.");
}

const { publicCommandData, staffCommandData } = await import("../api/interactions");

const linkedRoleMetadata = [
	{
		key: "is_sponsor",
		name: "Sponsor",
		description: "GitHub sponsor of The Minesa Studios",
		type: 7,
	},
	{
		key: "contributor",
		name: "Contributor",
		description: "Contributor of the Dungeon Blitz repository.",
		type: 7,
	},
];

const applicationUrl = `https://discord.com/api/v10/applications/${applicationId}`;

/** PUT a bulk overwrite and throw with Discord's response if it is refused. */
async function put(path: string, body: unknown, what: string): Promise<void> {
	const response = await fetch(`${applicationUrl}${path}`, {
		method: "PUT",
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(
			`[register] Failed to ${what}: [${response.status}] ${await response.text()}`,
		);
	}
}

/** Application command type of the Activity launcher, which a bulk overwrite cannot remove. */
const PRIMARY_ENTRY_POINT = 4;

type GlobalCommand = {
	id: string;
	type: number;
	name: string;
	description?: string;
	handler?: number;
	integration_types?: number[];
	contexts?: number[] | null;
};

/**
 * The global Entry Point command, if the app has one. Discord refuses a global
 * overwrite that leaves it out, so the public commands are sent alongside it.
 */
async function globalEntryPoints(): Promise<GlobalCommand[]> {
	const response = await fetch(`${applicationUrl}/commands`, {
		headers: { Authorization: `Bot ${botToken}` },
	});
	if (!response.ok) {
		throw new Error(
			`[register] Failed to read global commands: [${response.status}] ${await response.text()}`,
		);
	}
	const commands = (await response.json()) as GlobalCommand[];
	return commands
		.filter((command) => command.type === PRIMARY_ENTRY_POINT)
		.map(({ id, type, name, description, handler, integration_types, contexts }) => ({
			id,
			type,
			name,
			description,
			handler,
			integration_types,
			contexts,
		}));
}

// The staff set goes first: if it is refused, the global commands are left alone.
if (guildId) {
	await put(`/guilds/${guildId}/commands`, staffCommandData, "register staff commands on the community guild");
}
await put(
	"/commands",
	[...(await globalEntryPoints()), ...publicCommandData],
	"register the public commands globally",
);
await put("/role-connections/metadata", linkedRoleMetadata, "sync linked role metadata");

console.log(
	`Registered ${publicCommandData.length} commands globally` +
		(guildId ? ` and ${staffCommandData.length} staff commands on guild ${guildId}` : "") +
		`, synced linked role metadata.`,
);
