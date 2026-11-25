import { CommandBuilder } from "@minesa-org/mini-interaction";
import type { AutocompleteContext, CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionDiscordId } from "../utils/discordInteractions.js";
import { getGameAccountByDiscordId } from "../utils/gameAccount.js";
import {
	listGameSaveCharacters,
	requestGameRewards,
	type GameCharacterOption,
	type GameRewardsOutcome,
} from "../utils/gameRewards.js";
import { listSaveCharacters } from "../utils/gameWallet.js";
import { dailyRewardForStreak, recordDailyClaim, undoDailyClaim } from "../utils/dailyReward.js";
import { COLORS, errorNotice, formatNumber, notice, v2 } from "../ui/containers.js";
import { emoji } from "../ui/emojis.js";
import { errorMessage, logError, logInfo, logWarn } from "../utils/logger.js";

/**
 * `/daily [character]` — the daily Royal Sigil reward.
 *
 * Claimable once every 24 hours: 1 Royal Sigil on the first day of a streak, 2 on the
 * second, one more for each day after that. A claim more than 48 hours after the last one
 * starts the streak over at 1 (utils/dailyReward.ts).
 *
 * The sigils are the game's own Royal Sigils — the balance the in-game Royal Sigil store
 * spends. The game keeps it in the save's `SilverSigils` field (WorldEnter sends it as the
 * client's `mRoyalSigils`), which is the `sigils` kind of `/api/admin/rewards`; the save's
 * `RoyalSigils` field never reaches the client. An online character's counter updates at
 * once (packet 0x112).
 *
 * Without `character`, the unlocked character played most recently is paid.
 */

/**
 * The unlocked character played most recently (`LastRegionPosition.timestamp`), then the
 * highest level — the order `/account view` uses for the current character.
 */
export function pickDailyCharacter(
	options: GameCharacterOption[],
	lastPlayedMs: Map<string, number>,
): GameCharacterOption | null {
	let pick: GameCharacterOption | null = null;
	for (const option of options) {
		if (option.locked) continue;
		const played = lastPlayedMs.get(option.name.toLowerCase()) ?? 0;
		const best = pick ? lastPlayedMs.get(pick.name.toLowerCase()) ?? 0 : -1;
		if (!pick || played > best || (played === best && option.level > pick.level)) pick = option;
	}
	return pick;
}

function refusalText(outcome: Extract<GameRewardsOutcome, { ok: false }>, characterName: string): string {
	switch (outcome.refusal) {
		case "locked":
			return `**${characterName}** is locked in game. Pick another character with the \`character\` option.`;
		case "not-found":
			return `**${characterName}** was not found on your save.`;
		case "no-save":
			return "Your game account has no save yet. Log in to the game once, then claim.";
		case "held-elsewhere":
			return "Your character is busy on another game server right now. Try again in a minute.";
		default:
			return outcome.message;
	}
}

const days = (count: number) => `**${count} day${count === 1 ? "" : "s"}**`;
const when = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

export async function handleDaily(interaction: CommandInteraction) {
	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return interaction.reply(errorNotice("Your Discord account could not be read from this interaction."));
	}
	const requested = String(interaction.options.getString("character", false) ?? "").trim();
	interaction.deferReply({ flags: 64 });

	try {
		const account = await getGameAccountByDiscordId(discordId).catch(() => null);
		if (!account) {
			return interaction.editReply(
				v2(notice(COLORS.muted, "No game account linked", "Link your Discord account with `/account create` first.")),
			);
		}

		// Pick the character before claiming, so a wrong name never uses up the day.
		const options = await listGameSaveCharacters(discordId);
		let target: GameCharacterOption | null;
		if (requested) {
			target = options.find((character) => character.name.toLowerCase() === requested.toLowerCase()) ?? null;
			if (!target || target.locked) {
				return interaction.editReply(
					v2(
						notice(
							COLORS.muted,
							target ? "Character locked" : "Character not found",
							target ? `**${target.name}** is locked in game.` : `You have no character named **${requested}**.`,
						),
					),
				);
			}
		} else {
			const played = await listSaveCharacters(account.userId).catch(() => []);
			target = pickDailyCharacter(
				options,
				new Map(played.map((character) => [character.characterName.toLowerCase(), character.lastPlayedMs])),
			);
			if (!target) {
				return interaction.editReply(
					v2(notice(COLORS.muted, "No character yet", "Create a character in game first.")),
				);
			}
		}

		const claim = await recordDailyClaim(discordId);
		if (claim.status === "cooldown") {
			return interaction.editReply(
				v2(
					notice(COLORS.muted, "Already claimed", [
						`Streak: ${days(claim.streak)}. Your next daily opens ${when(claim.nextClaimAtMs)} for **+${formatNumber(dailyRewardForStreak(claim.streak + 1))}** ${emoji("cur_royal_sigil")}.`,
					]),
				),
			);
		}

		const outcome = await requestGameRewards({
			userId: account.userId,
			characterName: target.name,
			rewards: [{ kind: "sigils", amount: claim.reward }],
			requestedBy: `discord:${discordId} /daily day ${claim.streak}`,
		});
		const result = outcome.ok ? outcome.results.find((entry) => entry.kind === "sigils") : undefined;

		if (!outcome.ok || result?.status !== "applied") {
			const undone = await undoDailyClaim(discordId, claim).catch(() => false);
			logWarn("daily", "payment_failed", {
				user: discordId,
				character: target.name,
				refusal: outcome.ok ? result?.status ?? "no-result" : outcome.refusal,
				undone,
			});
			return interaction.editReply(
				v2(
					notice(COLORS.danger, "Daily reward not paid", [
						outcome.ok ? "The game server did not confirm the payment." : refusalText(outcome, target.name),
						undone ? "Your daily was not used up — try again." : "Ask staff to check your daily.",
					]),
				),
			);
		}

		logInfo("daily", "claimed", { user: discordId, character: outcome.characterName, streak: claim.streak, reward: claim.reward });
		return interaction.editReply(
			v2(
				notice(COLORS.success, "Daily reward claimed", [
					`**+${formatNumber(claim.reward)}** ${emoji("cur_royal_sigil")} Royal Sigils on **${outcome.characterName}** — now **${formatNumber(result.after)}**.`,
					`Streak: ${days(claim.streak)}. Next daily ${when(claim.claimedAtMs + 24 * 3_600_000)} for **+${formatNumber(dailyRewardForStreak(claim.streak + 1))}**; miss it by a day and the streak starts over.`,
				]),
			),
		);
	} catch (error) {
		logError("daily", "failed", { user: discordId, error: errorMessage(error) });
		return interaction.editReply(errorNotice("The daily reward could not be claimed right now. Try again later."));
	}
}

/** Lists the caller's own unlocked characters; `interaction` is the raw autocomplete payload. */
export async function handleDailyAutocomplete(
	autocomplete: AutocompleteContext,
	interaction: Parameters<typeof interactionDiscordId>[0],
) {
	const focused = autocomplete.getFocusedOption();
	const discordId = interactionDiscordId(interaction);
	if (!focused || focused.name !== "character" || !discordId) {
		autocomplete.respond([]);
		return;
	}
	try {
		const query = String(focused.value ?? "").trim().toLowerCase();
		const characters = await listGameSaveCharacters(discordId);
		autocomplete.respond(
			characters
				.filter((character) => !character.locked && character.name.toLowerCase().includes(query))
				.slice(0, 25)
				.map((character) => ({
					name: `${character.name} · Lv ${character.level}${character.class ? ` ${character.class}` : ""}`,
					value: character.name,
				})),
		);
	} catch (error) {
		logError("daily", "autocomplete_failed", { user: discordId, error: errorMessage(error) });
		autocomplete.respond([]);
	}
}

export const dailyCommand = {
	data: new CommandBuilder()
		.setName("daily")
		.setDescription("Claim your daily Royal Sigils — one more for every day in a row")
		.addStringOption((option) =>
			option
				.setName("character")
				.setDescription("Character to pay (default: the one you played last)")
				.setAutocomplete(true)
				.setMaxLength(32)
				.setRequired(false),
		),
	handler: handleDaily,
};
