import dotenv from "dotenv";
// Locally, the full set (including DISCORD_GUILD_ID) is in .env.production.local
// (`vercel env pull`); the first file that sets a variable wins. On Vercel neither
// file exists and the project's environment is used as-is.
dotenv.config({ path: [".env.production.local", ".env"] });

/**
 * Registers every slash command on the one community guild (DISCORD_GUILD_ID) and
 * clears the application's global commands, so each command shows up once, only in
 * that server, and updates instantly instead of waiting on Discord's global cache.
 * The Activity's Entry Point command is global by nature and is kept.
 * Linked role metadata is application-wide and is synced here too.
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

// Bail out before touching anything: clearing the global commands without a guild to
// register on would leave the server with no commands at all.
for (const [name, value] of [
	["DISCORD_BOT_TOKEN", botToken],
	["DISCORD_APPLICATION_ID", applicationId],
	["DISCORD_GUILD_ID", guildId],
] as const) {
	if (!value) {
		console.log(`⚠️ ${name} not found. Skipping command registration.`);
		process.exit(0);
	}
}

const { commandData } = await import("../api/interactions");

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
 * overwrite that leaves it out, so clearing the global commands has to carry it.
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

// Guild first: if it is refused, the global commands are left in place.
await put(`/guilds/${guildId}/commands`, commandData, "register guild commands");
await put("/commands", await globalEntryPoints(), "clear global commands");
await put("/role-connections/metadata", linkedRoleMetadata, "sync linked role metadata");

console.log(
	`Registered ${commandData.length} commands on guild ${guildId}, cleared global commands, synced linked role metadata.`,
);
