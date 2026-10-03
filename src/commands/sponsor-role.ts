import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { isAdministrator } from "../utils/discordInteractions.js";
import {
	db,
	pushSponsorRoleConnection,
	type RoleConnectionPushResult,
} from "../utils/database.js";
import { getGuildMemberRoleIds } from "../utils/discordRoleGrant.js";
import { SPONSOR_ROLE_ID } from "../utils/sponsorPacks.js";
import { getSponsorTargets } from "../utils/githubSponsors.js";
import { discordIdForGithubUser } from "../utils/gameWallet.js";

/**
 * `/admin sponsor-role` — mark a player as a sponsor (or take it back).
 *
 * The Sponsor role is a **linked role**: Discord owns it. The player grants the
 * application access once, the bot writes `is_sponsor` on their role-connection
 * metadata, and Discord grants or removes the role from that metadata on its own
 * — on the next authorize, on a metadata refresh, or when the player claims it
 * themselves from their profile. There is deliberately **no**
 * `PUT /guilds/{g}/members/{u}/roles/{r}` here: that endpoint grants a *plain*
 * role, it is not how a linked role is awarded, and on a linked role it answers
 * `403 Missing Access` (code 50001) because the bot does not hold Manage Roles
 * for it. Attempting it also produced a scary error while the real work — the
 * metadata — never happened.
 *
 * So this command does the two writes that actually decide the outcome:
 *
 *   1. the stored `isSponsor` flag, which is what `/packs` sponsor-only packs and
 *      the profile panel read;
 *   2. the player's role-connection metadata, which is what Discord reads to award
 *      the linked role.
 *
 *   /admin sponsor-role @user            — mark them a sponsor
 *   /admin sponsor-role @user remove     — take it back
 *   /admin sponsor-role github:churrascooo__ — resolve the linked Discord user from GitHub
 */

/**
 * How the badge push ended, in operator terms. Each outcome says plainly whether
 * the player has to do anything for the role to appear.
 */
function describeBadgePush(result: RoleConnectionPushResult): string {
	switch (result.status) {
		case "pushed":
			return `-# Their linked-role metadata now says **is_sponsor = ${result.isSponsor ? 1 : 0}**, so Discord awards the <@&${SPONSOR_ROLE_ID}> role itself.`;
		case "not-linked":
			return `-# Discord holds no linked-role connection for them yet — they have never authorized the application, so there is no token to write their badge with. Their stored sponsor flag is still set, so sponsor packs and credit work; the role itself appears once they authorize once.`;
		case "reauth-required":
			return `-# Their metadata could not be written: ${result.detail}. They need to authorize the application again; until then Discord is still reading their old metadata. Their stored sponsor flag is set, so sponsor packs and credit work.`;
		case "not-configured":
			return `-# Their metadata could not be written: ${result.detail} Their stored sponsor flag is set, so sponsor packs and credit work.`;
		case "failed":
			return `-# Their metadata could not be written: ${result.detail} Their stored sponsor flag is set, so sponsor packs and credit work.`;
	}
}

export async function handleSponsorRole(interaction: CommandInteraction) {
	if (!isAdministrator(interaction)) {
		return interaction.reply({
			content: "Administrator permission is required.",
			flags: 64,
		});
	}

	const target = interaction.options.getUser("user", false);
	const githubUsername =
		interaction.options.getString("github_username", false)?.trim() ?? "";

	let targetId = String(target?.user?.id ?? "").trim();
	let resolvedFromGithub: string | null = null;

	if (!targetId && githubUsername) {
		await interaction.deferReply({ flags: 64 });
		try {
			targetId = (await discordIdForGithubUser(githubUsername)) ?? "";
		} catch (error) {
			console.error("[sponsor-role] GitHub lookup failed:", error);
		}
		if (!targetId) {
			return interaction.editReply({
				content: `No linked Discord account was found for GitHub user **${githubUsername}**. They have to run the verification page (or /account create) once so the link exists, or grant the role with the user option instead.`,
			});
		}
		resolvedFromGithub = githubUsername;
	}

	if (!targetId) {
		return interaction.reply({
			content:
				"Pick a member with the `user` option, or name a linked GitHub account with `github_username`.",
			flags: 64,
		});
	}

	const mode = interaction.options.getString("mode", false) ?? "grant";
	const remove = mode === "remove";

	if (!resolvedFromGithub) {
		await interaction.deferReply({ flags: 64 });
	}
	// The github_username path has already deferred; the user path defers here
	// so every later editReply has an acknowledged interaction behind it.

	const roleId = SPONSOR_ROLE_ID;
	const targets = getSponsorTargets();
	const matchedTarget = targets[0] ?? null;

	// Read-only, and only so the reply can say what the operator can see right now.
	// Reading a member never needs Manage Roles, unlike granting a plain role.
	const memberRoleIds = await getGuildMemberRoleIds(targetId).catch(() => null);
	const alreadyHasRole = memberRoleIds?.includes(roleId) ?? false;

	// The stored flag is what `/packs` sponsor-only packs and the profile panel read.
	let profileWriteFailed = false;
	try {
		const existing = (await db.get(targetId).catch(() => null)) as Record<string, unknown> | null;
		const base = existing ?? {};
		await db.set(targetId, {
			...base,
			userId: targetId,
			isSponsor: !remove,
			sponsorTarget: remove ? null : matchedTarget,
			lastUpdated: Date.now(),
		});
	} catch (error) {
		profileWriteFailed = true;
		console.error("[sponsor-role] Could not update the stored profile:", error);
	}

	// The linked role is awarded from this metadata, written with the player's own
	// token. It reuses the token they granted when they last verified, renewing it
	// when it has expired, so no re-verification is needed.
	const badgePush = await pushSponsorRoleConnection(targetId, !remove).catch(
		(error: unknown) => ({
			status: "failed" as const,
			detail: error instanceof Error ? error.message : String(error),
		})
	);

	const mention = `<@${targetId}>`;
	const lines: string[] = [];
	if (resolvedFromGithub) {
		lines.push(`Resolved GitHub **${resolvedFromGithub}** to ${mention}.`);
	}

	if (profileWriteFailed) {
		lines.push(
			"❌ Their stored profile could not be updated, so sponsor packs and credit are still locked for them."
		);
	} else if (remove) {
		lines.push("ℹ️ Their profile is no longer marked as a sponsor.");
	} else {
		lines.push(
			`Their profile is marked as a sponsor of **${matchedTarget ?? "the studio"}**, so sponsor packs and credit are unlocked.`
		);
	}

	// The Sponsor role is linked, so there is nothing to grant by hand — say what
	// the player still has to do, or that there is nothing to do at all.
	if (remove) {
		lines.push(
			alreadyHasRole
				? `They currently have the <@&${roleId}> role; Discord drops it once it next reads their metadata.`
				: `They do not have the <@&${roleId}> role, so there is nothing for Discord to drop.`
		);
	} else if (alreadyHasRole) {
		lines.push(
			`✅ ${mention} already has the <@&${roleId}> role, so nothing else is needed — Discord keeps it as long as their metadata keeps claiming it.`
		);
	} else {
		lines.push(
			`ℹ️ ${mention} does not have the <@&${roleId}> role yet. It is a **linked role**, so Discord grants it from the metadata below — they get it as soon as they authorize their account, and they can also claim it themselves from their profile.`
		);
	}

	lines.push(describeBadgePush(badgePush));

	return interaction.editReply({ content: lines.join("\n") });
}
