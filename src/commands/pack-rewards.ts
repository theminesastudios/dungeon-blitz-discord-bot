import type {
	AutocompleteContext,
	CommandInteraction,
} from "@minesa-org/mini-interaction";
import {
	getPlayerProfile,
	resetPackLedger,
	searchPlayers,
} from "../utils/gameWallet.js";
import { stripPackRewards } from "../utils/gameRewards.js";
import { isAdministrator } from "../utils/discordInteractions.js";

/**
 * `/admin rewards` — undoes sponsor pack deliveries on a player's save. The shop grants
 * mounts and legendary dyes straight into the save, so testing a pack means removing
 * exactly those entries again; `reset-credit` also releases the pack purchase history so
 * a pack (including a one-time claim) can be bought again. Writes land on the offline save
 * like the shop's own grants do, so run it while the target character is out of game.
 */
export async function handlePackRewards(interaction: CommandInteraction) {
	if (!isAdministrator(interaction)) {
		return interaction.reply({
			content: "Administrator permission is required.",
			flags: 64,
		});
	}

	const selector = interaction.options.getString("player", true)!.trim();
	const character =
		interaction.options.getString("character", false)?.trim() || undefined;
	const resetCredit =
		interaction.options.getString("reset-credit", false) === "yes";

	interaction.deferReply({ flags: 64 });

	try {
		const discordId = selector.startsWith("profile:")
			? selector.slice("profile:".length).trim()
			: ((await getPlayerProfile(selector))?.discordUserId ?? "");
		if (!discordId) {
			return interaction.editReply({
				content:
					"That player has no linked Discord profile, so their game save cannot be resolved.",
			});
		}

		const result = await stripPackRewards(discordId, character);
		if (!result) {
			return interaction.editReply({
				content: "No game account or save was found for that player.",
			});
		}
		if (result.characters.length === 0) {
			return interaction.editReply({
				content: character
					? `No character named **${character}** exists on game user ${result.userId}.`
					: `Game user ${result.userId} has no characters to clean.`,
			});
		}

		const fields = result.characters.map((entry) => ({
			name: entry.name,
			value: [
				`-# 🎨 Dyes removed: ${entry.removedDyes.length > 0 ? entry.removedDyes.join(", ") : "none"}`,
				`-# 🐴 Mounts removed: ${entry.removedMounts.length > 0 ? entry.removedMounts.join(", ") : "none"}`,
			].join("\n"),
		}));

		let creditLine = "";
		if (resetCredit) {
			const reset = await resetPackLedger(discordId);
			creditLine = reset
				? "Pack purchase history cleared — every pack can be bought again."
				: "No linked profile was found, so the pack purchase history was left alone.";
		}

		return interaction.editReply({
			embeds: [
				{
					color: 0xe67e22,
					title: "🧹 Pack rewards removed",
					description: [
						`Game user **${result.userId}**`,
						creditLine,
					]
						.filter(Boolean)
						.join("\n"),
					fields,
					footer: {
						text: "Removed only the ids the pack shop grants; everything else is untouched.",
					},
				},
			],
		});
	} catch (error) {
		console.error("[pack-rewards] Reward strip failed:", error);
		return interaction.editReply({
			content:
				"The pack rewards could not be removed. The game save database may be unreachable right now.",
		});
	}
}

export async function handlePackRewardsAutocomplete(
	autocomplete: AutocompleteContext,
) {
	const focused = autocomplete.getFocusedOption();
	if (!focused || focused.name !== "player") {
		autocomplete.respond([]);
		return;
	}

	try {
		// The save is resolved through the linked profile, so only profile rows
		// (not bare wallets) can be cleaned.
		const players = (await searchPlayers(String(focused.value ?? ""))).filter(
			(player) => player.selector.startsWith("profile:"),
		);
		autocomplete.respond(
			players.map((player) => ({
				name: player.label.slice(0, 100),
				value: player.selector,
			})),
		);
	} catch (error) {
		console.error("[pack-rewards] Autocomplete failed:", error);
		autocomplete.respond([]);
	}
}
