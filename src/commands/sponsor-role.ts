import type { CommandInteraction } from "@minesa-org/mini-interaction";
import { isAdministrator } from "../utils/discordInteractions.js";
import { db } from "../utils/database.js";
import {
	getGuildMemberRoleIds,
	setGuildMemberRole,
} from "../utils/discordRoleGrant.js";
import { SPONSOR_ROLE_ID } from "../utils/sponsorPacks.js";
import { getSponsorTargets } from "../utils/githubSponsors.js";
import { discordIdForGithubUser } from "../utils/gameWallet.js";

/**
 * `/admin sponsor-role` — grant (or remove) the Discord sponsor role by hand.
 *
 * The linked-roles flow only refreshes when a player re-runs the verification
 * page, so a sponsor added to the manual lists stays roleless until they do.
 * This command closes that gap: it marks the player's stored profile as a
 * sponsor (`isSponsor` is what `/packs` and the profile read) and grants the
 * role directly through the bot REST API, so the sponsor is done in one step.
 *
 *   /admin sponsor-role @user            — grant the sponsor role
 *   /admin sponsor-role @user remove     — take it back
 *   /admin sponsor-role github:churrascooo__ — resolve the linked Discord user from GitHub
 */

type RoleGrantResult =
	| { status: "granted" | "removed" | "already-had" | "did-not-have" }
	| { status: "not-in-guild" }
	| { status: "failed"; detail: string };

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

	// The role itself comes first: if Discord refuses it, the stored flag should
	// not claim a sponsor status the member does not visibly have.
	const memberRoleIds = await getGuildMemberRoleIds(targetId).catch(() => null);
	const alreadyHas = memberRoleIds?.includes(roleId) ?? false;

	let roleResult: RoleGrantResult;
	if (remove) {
		roleResult = alreadyHas
			? await setGuildMemberRole(targetId, roleId, "remove")
			: { status: "did-not-have" as const };
	} else {
		roleResult = alreadyHas
			? ({ status: "already-had" } as RoleGrantResult)
			: await setGuildMemberRole(targetId, roleId, "add");
	}

	// Keep the stored profile in step so `/packs` sponsor-only packs and the
	// profile panel agree with the role. The role grant is the source of truth;
	// a failed grant leaves the flag untouched.
	if (roleResult.status === "granted" || roleResult.status === "removed") {
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
			console.error("[sponsor-role] Could not update the stored profile:", error);
		}
	}

	const mention = `<@${targetId}>`;
	const lines: string[] = [];
	if (resolvedFromGithub) {
		lines.push(`Resolved GitHub **${resolvedFromGithub}** to ${mention}.`);
	}
	switch (roleResult.status) {
		case "granted":
			lines.push(`✅ Granted the <@&${roleId}> role to ${mention}.`);
			break;
		case "already-had":
			lines.push(`ℹ️ ${mention} already has the <@&${roleId}> role.`);
			break;
		case "removed":
			lines.push(`✅ Removed the <@&${roleId}> role from ${mention}.`);
			break;
		case "did-not-have":
			lines.push(`ℹ️ ${mention} did not have the <@&${roleId}> role.`);
			break;
		case "not-in-guild":
			lines.push(
				`❌ ${mention} is not in this server (or the bot cannot see them), so the role could not be changed.`
			);
			break;
		case "failed":
			lines.push(`❌ Role change failed: ${roleResult.detail}`);
			break;
	}

	if (roleResult.status === "granted") {
		lines.push(
			`Their profile is marked as a sponsor of **${matchedTarget ?? "the studio"}**, so sponsor packs and credit are unlocked.`
		);
	}
	if (roleResult.status === "granted" || roleResult.status === "removed") {
		lines.push(
			"-# The role-connection badge on their Discord profile updates the next time they run the verification page; the role itself is already correct."
		);
	}

	return interaction.editReply({ content: lines.join("\n") });
}
