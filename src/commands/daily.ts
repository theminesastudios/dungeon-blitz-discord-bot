import { CommandBuilder } from "@minesa-org/mini-interaction";
import type { AutocompleteContext, CommandInteraction } from "@minesa-org/mini-interaction";
import { interactionDiscordId } from "../utils/discordInteractions.js";
import { getGameAccountByDiscordId } from "../utils/gameAccount.js";
import {
	findDefaultGameSaveCharacter,
	listGameSaveCharacters,
	requestGameRewards,
	type GameRewardsOutcome,
} from "../utils/gameRewards.js";
import {
	currentDailyStreak,
	dailyRewardForStreak,
	getDailyState,
	recordDailyClaim,
	revertDailyClaim,
	utcDay,
	utcDayStartMs,
} from "../utils/dailyReward.js";
import { COLORS, errorNotice, formatNumber, notice, v2 } from "../ui/containers.js";
import { emoji } from "../ui/emojis.js";
import { errorMessage, logError, logInfo, logWarn } from "../utils/logger.js";

/**
 * `/daily [character]` — the daily Royal Sigil reward.
 *
 * Once per UTC day, paid onto one character: 1 Royal Sigil on the first day of a streak,
 * 2 on the second, and one more for every consecutive day after that. Missing a day starts
 * the streak over at 1 (see utils/dailyReward.ts).
 *
 * The sigils are the game's own Royal Sigils — the balance the in-game Royal Sigil store
 * spends. The game keeps that balance in the save's `SilverSigils` field (WorldEnter writes
 * it as the client's `mRoyalSigils`), which is the `sigils` kind of `/api/admin/rewards`; the
 * save's `RoyalSigils` field is never sent to the client, so paying into it would show the
 * player nothing. The game server pays an online character live (packet 0x112, the same
 * counter update a trove's sigils use) and a stored one in its save.
 *
 * Without `character`, the most recently played unlocked character is paid, as the pack
 * shop does.
 */

function nextClaimLine(nowMs: number): string {
	const next = Math.floor(utcDayStartMs(utcDay(nowMs) + 1) / 1000);
	return `Next claim <t:${next}:R> (<t:${next}:t>).`;
}

function streakKeptLine(nowMs: number, streak: number): string {
	const deadline = Math.floor(utcDayStartMs(utcDay(nowMs) + 2) / 1000);
	return `Claim again before <t:${deadline}:f> for **+${formatNumber(dailyRewardForStreak(streak + 1))}**, or the streak starts over.`;
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
				v2(
					notice(
						COLORS.muted,
						"No game account linked",
						"Link your Discord account to a game account with `/account create` first, then claim your daily Royal Sigils.",
					),
				),
			);
		}

		// Pick the character before claiming, so a wrong name never uses up the day.
		let characterName: string;
		if (requested) {
			const characters = await listGameSaveCharacters(discordId);
			const match = characters.find(
				(character) => character.name.toLowerCase() === requested.toLowerCase(),
			);
			if (!match) {
				return interaction.editReply(
					v2(notice(COLORS.muted, "Character not found", `You have no character named **${requested}**.`)),
				);
			}
			if (match.locked) {
				return interaction.editReply(
					v2(
						notice(
							COLORS.muted,
							"Character locked",
							`**${match.name}** is locked in game. Pick another character.`,
						),
					),
				);
			}
			characterName = match.name;
		} else {
			const fallback = await findDefaultGameSaveCharacter(discordId, account.userId);
			if (!fallback) {
				return interaction.editReply(
					v2(
						notice(
							COLORS.muted,
							"No character yet",
							"Create a character in game first; the daily Royal Sigils are paid onto a character.",
						),
					),
				);
			}
			characterName = fallback.characterName;
		}

		const nowMs = Date.now();
		const claim = await recordDailyClaim(discordId, nowMs);
		if (claim.status === "already-claimed") {
			const state = await getDailyState(discordId).catch(() => null);
			const streak = currentDailyStreak(state, utcDay(nowMs));
			return interaction.editReply(
				v2(
					notice(COLORS.muted, "Already claimed today", [
						`You have claimed today's Royal Sigils. Streak: **${streak} day${streak === 1 ? "" : "s"}**.`,
						`${nextClaimLine(nowMs)} It pays **+${formatNumber(dailyRewardForStreak(streak + 1))}** ${emoji("cur_royal_sigil")}.`,
					]),
				),
			);
		}

		const outcome = await requestGameRewards({
			userId: account.userId,
			characterName,
			rewards: [{ kind: "sigils", amount: claim.reward }],
			requestedBy: `discord:${discordId} /daily day ${claim.streak}`,
		});
		const result = outcome.ok ? outcome.results.find((entry) => entry.kind === "sigils") : undefined;

		if (!outcome.ok || result?.status !== "applied") {
			const reverted = await revertDailyClaim(discordId, claim).catch((error) => {
				logError("daily", "revert_failed", { user: discordId, error: errorMessage(error) });
				return false;
			});
			logWarn("daily", "payment_failed", {
				user: discordId,
				character: characterName,
				reward: claim.reward,
				refusal: outcome.ok ? result?.status ?? "no-result" : outcome.refusal,
				reverted,
			});
			const reason = outcome.ok
				? "The game server did not confirm the payment."
				: refusalText(outcome, characterName);
			return interaction.editReply(
				v2(
					notice(COLORS.danger, "Daily reward not paid", [
						reason,
						reverted
							? "Today's claim was not used up — try again."
							: "Today's claim could not be released; ask staff to check it.",
					]),
				),
			);
		}

		logInfo("daily", "claimed", {
			user: discordId,
			character: outcome.characterName,
			streak: claim.streak,
			reward: claim.reward,
			online: outcome.online,
		});
		const sigil = emoji("cur_royal_sigil");
		return interaction.editReply(
			v2(
				notice(COLORS.success, "Daily reward claimed", [
					`**+${formatNumber(claim.reward)}** ${sigil} Royal Sigils on **${outcome.characterName}** — now **${formatNumber(result.after)}**.`,
					`Streak: **${claim.streak} day${claim.streak === 1 ? "" : "s"}**.`,
					`${nextClaimLine(nowMs)} ${streakKeptLine(nowMs, claim.streak)}`,
					...(outcome.online ? [] : ["-# The character is offline; the sigils are on its save for the next login."]),
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
				.setDescription("Character to pay (default: your most recently played one)")
				.setAutocomplete(true)
				.setMaxLength(32)
				.setRequired(false),
		),
	handler: handleDaily,
};
