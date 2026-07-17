import { MiniDatabase } from "@minesa-org/mini-interaction";
import {
	getDiscordGithubUsername,
	getSponsorMatch,
	getContributorMatch,
} from "./githubSponsors.js";
import { getDirectSponsorMatch } from "./githubSponsorDirect.js";

/**
 * Shared database instance for the application.
 */
export const db = MiniDatabase.fromEnv();

const MINI_DB_RESERVED_FIELDS = new Set(["createdAt"]);

function asUpdatableRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") return {};

	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record).filter(
			([key]) => !MINI_DB_RESERVED_FIELDS.has(key)
		)
	);
}

/**
 * Gets user data from the database.
 */
export async function getUserData(userId: string) {
	try {
		return await db.get(userId);
	} catch (error) {
		console.error("❌ Error getting user data:", error);
		throw error;
	}
}

/**
 * Sets user's is_miniapp status.
 * Always true. No gating. Everyone connects.
 */
export async function setUserMiniAppStatus(userId: string) {
	try {
		const existing = await db.get(userId).catch(() => null);
		const base = asUpdatableRecord(existing);
		return await db.set(userId, {
			...base,
			userId,
			is_miniapp: true,
			lastUpdated: Date.now(),
		});
	} catch (error) {
		console.error("❌ Error setting user miniapp status:", error);
		throw error;
	}
}

/**
 * Updates user metadata for Discord linked roles.
 * is_miniapp is always true.
 */
export async function updateDiscordMetadata(
	userId: string,
	accessToken: string
) {
	await setUserMiniAppStatus(userId);

	const githubUsername = await getDiscordGithubUsername(accessToken);
	console.info(
		`[updateDiscordMetadata] Linked roles refresh for Discord user "${userId}" resolved GitHub username: ${githubUsername ?? "(none)"}`
	);

	let sponsorMatch = {
		isSponsor: false,
		matchedTarget: null as string | null,
	};

	let contributorMatch = {
		isContributor: false,
	};

	if (githubUsername) {
		try {
			sponsorMatch = await getSponsorMatch(githubUsername);
			if (!sponsorMatch.isSponsor) {
				sponsorMatch = await getDirectSponsorMatch(githubUsername);
			}
		} catch (error) {
			console.error("[updateDiscordMetadata] Sponsor check failed:", error);
		}

		try {
			contributorMatch = await getContributorMatch(githubUsername);
		} catch (error) {
			console.error(
				"[updateDiscordMetadata] Contributor check failed:",
				error
			);
		}
	}

	const existing = await db.get(userId).catch(() => null);
	const base = asUpdatableRecord(existing);

	await db.set(userId, {
		...base,
		githubUsername: githubUsername ?? null,
		isSponsor: sponsorMatch.isSponsor,
		sponsorTarget: sponsorMatch.matchedTarget,
		isContributor: contributorMatch.isContributor,
		lastUpdated: Date.now(),
	});
	console.info(
		`[updateDiscordMetadata] Result for Discord user "${userId}": github="${githubUsername ?? "(none)"}", sponsor=${sponsorMatch.isSponsor}, sponsorTarget=${sponsorMatch.matchedTarget ?? "(none)"}, contributor=${contributorMatch.isContributor}`
	);

	const metadata = {
		platform_name: "Dungeon Blitz",
		...(githubUsername ? { platform_username: githubUsername } : {}),
		metadata: {
			is_sponsor: sponsorMatch.isSponsor ? "1" : "0",
			contributor: contributorMatch.isContributor ? "1" : "0",
		},
	};

	const response = await fetch(
		`https://discord.com/api/v10/users/@me/applications/${process.env.DISCORD_APPLICATION_ID}/role-connection`,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(metadata),
		}
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to update Discord metadata: ${error}`);
	}

	return await response.json();
}
