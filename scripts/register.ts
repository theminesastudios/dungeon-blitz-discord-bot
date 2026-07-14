import dotenv from "dotenv";
dotenv.config();

if (
	process.env.VERCEL_ENV === "preview" &&
	process.env.ALLOW_PREVIEW_COMMAND_REGISTRATION !== "true"
) {
	console.log("Preview deployment detected. Skipping global Discord command registration.");
	process.exit(0);
}

if (!process.env.DISCORD_BOT_TOKEN) {
	console.log("⚠️ DISCORD_BOT_TOKEN not found. Skipping command registration.");
	process.exit(0);
}

const { mini } = await import("../api/interactions");
const applicationId = process.env.DISCORD_APPLICATION_ID ?? mini.applicationId;

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

const response = await fetch(
	`https://discord.com/api/v10/applications/${applicationId}/commands`,
	{
		method: "PUT",
		headers: {
			Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(mini.listCommandData()),
	},
);

if (!response.ok) {
	throw new Error(
		`[register] Failed to clear application commands: [${response.status}] ${await response.text()}`,
	);
}

const metadataResponse = await fetch(
	`https://discord.com/api/v10/applications/${applicationId}/role-connections/metadata`,
	{
		method: "PUT",
		headers: {
			Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(linkedRoleMetadata),
	},
);

if (!metadataResponse.ok) {
	throw new Error(
		`[register] Failed to sync linked role metadata: [${metadataResponse.status}] ${await metadataResponse.text()}`,
	);
}

console.log("Slash command and linked role metadata sync complete!");
