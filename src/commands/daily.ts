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
import {
	confirmDailyClaim,
	currentDailyStreak,
	dailyRewardForStreak,
	getDailyState,
	pendingAction,
	releaseDailyClaim,
	reserveDailyClaim,
	utcDay,
	utcDayStartMs,
	type DailyPendingPayment,
} from "../utils/dailyReward.js";
import { COLORS, errorNotice, formatNumber, notice, v2 } from "../ui/containers.js";
import { emoji } from "../ui/emojis.js";
import { errorMessage, logError, logInfo, logWarn } from "../utils/logger.js";

/**
 * `/daily [character]` — the daily Royal Sigil reward.
 *
 * Once per UTC day, paid onto one character: 1 Royal Sigil on the first day of a streak,
 * 2 on the second, and one more for every consecutive day after that. Missing a day starts
 * the streak over at 1 (see utils/dailyReward.ts, which also explains how a payment is
 * reserved, paid, then confirmed or released, so it is never paid twice).
 *
 * The sigils are the game's own Royal Sigils — the balance the in-game Royal Sigil store
 * spends. The game keeps that balance in the save's `SilverSigils` field (WorldEnter writes
 * it as the client's `mRoyalSigils`), which is the `sigils` kind of `/api/admin/rewards`; the
 * save's `RoyalSigils` field is never sent to the client, so paying into it would show the
 * player nothing. The game server pays an online character live (packet 0x112, the same
 * counter update a trove's sigils use) and a stored one in its save.
 *
 * Without `character`, the unlocked character played most recently is paid.
 */

const SIGIL = () => emoji("cur_royal_sigil");

/** Codes after which the game server has certainly paid nothing. */
const NOTHING_PAID = new Set(["locked", "not-found", "no-save", "held-elsewhere", "invalid-request"]);

/**
 * The unlocked character played most recently (`LastRegionPosition.timestamp`), then the
 * highest level — the same order `/account view` uses for the current character. Save order
 * says nothing about which character the player is on.
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

function nextClaimLine(nowMs: number): string {
	const next = Math.floor(utcDayStartMs(utcDay(nowMs) + 1) / 1000);
	return `Next claim <t:${next}:R> (<t:${next}:t>).`;
}

function streakKeptLine(nowMs: number, streak: number): string {
	const deadline = Math.floor(utcDayStartMs(utcDay(nowMs) + 2) / 1000);
	return `Claim again before <t:${deadline}:f> for **+${formatNumber(dailyRewardForStreak(streak + 1))}**, or the streak starts over.`;
}

function days(count: number): string {
	return `**${count} day${count === 1 ? "" : "s"}**`;
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

type PaymentResult =
	| { kind: "paid"; balance: number; online: boolean; characterName: string }
	| { kind: "refused"; reason: string }
	| { kind: "unknown"; reason: string };

/** Asks the game server to pay a pending payment, with its own request id. */
async function pay(discordId: string, pending: DailyPendingPayment): Promise<PaymentResult> {
	const outcome = await requestGameRewards({
		userId: pending.userId,
		characterName: pending.characterName,
		rewards: [{ kind: "sigils", amount: pending.amount }],
		requestedBy: `discord:${discordId} /daily day ${pending.streak}`,
		requestId: pending.requestId,
	});
	if (outcome.ok) {
		const result = outcome.results.find((entry) => entry.kind === "sigils");
		if (result?.status === "applied") {
			return { kind: "paid", balance: result.after, online: outcome.online, characterName: outcome.characterName };
		}
		return { kind: "refused", reason: "The game server did not apply the payment." };
	}
	if (NOTHING_PAID.has(outcome.refusal)) {
		return { kind: "refused", reason: refusalText(outcome, pending.characterName) };
	}
	return { kind: "unknown", reason: outcome.message };
}

const UNKNOWN_FOOTER =
	"Run `/daily` again in a few minutes to finish this claim — it is paid at most once.";

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

		// A payment left pending by an earlier /daily is settled before anything else, so its
		// day is counted (or freed) before today's streak is worked out.
		const nowMs = Date.now();
		const state = await getDailyState(discordId);
		if (state?.pending) {
			const claim = { claimId: state.claimId, pending: state.pending };
			const action = pendingAction(state.pending, nowMs);
			if (action === "in-flight") {
				return interaction.editReply(
					v2(notice(COLORS.muted, "Claim in progress", "Your daily claim is still being paid. Try again in a moment.")),
				);
			}
			if (action === "assume-paid") {
				// Too old to ask again without risking a second payment.
				await confirmDailyClaim(discordId, claim, nowMs);
				logWarn("daily", "pending_assumed_paid", { user: discordId, requestId: state.pending.requestId });
			} else {
				const settled = await pay(discordId, state.pending);
				if (settled.kind === "unknown") {
					return interaction.editReply(
						v2(notice(COLORS.warning, "Earlier claim still unconfirmed", [settled.reason, UNKNOWN_FOOTER])),
					);
				}
				if (settled.kind === "paid") await confirmDailyClaim(discordId, claim, nowMs);
				else await releaseDailyClaim(discordId, claim);
				logInfo("daily", "pending_settled", { user: discordId, result: settled.kind, requestId: state.pending.requestId });
				if (settled.kind === "paid" && state.pending.day === utcDay(nowMs)) {
					return interaction.editReply(
						v2(
							notice(COLORS.success, "Daily reward claimed", [
								`**+${formatNumber(state.pending.amount)}** ${SIGIL()} Royal Sigils on **${settled.characterName}** — now **${formatNumber(settled.balance)}**.`,
								`Streak: ${days(state.pending.streak)}.`,
								`${nextClaimLine(nowMs)} ${streakKeptLine(nowMs, state.pending.streak)}`,
							]),
						),
					);
				}
			}
		}

		// Pick the character before reserving, so a wrong name never uses up the day.
		const options = await listGameSaveCharacters(discordId);
		let target: GameCharacterOption | null;
		if (requested) {
			target = options.find((character) => character.name.toLowerCase() === requested.toLowerCase()) ?? null;
			if (!target) {
				return interaction.editReply(
					v2(notice(COLORS.muted, "Character not found", `You have no character named **${requested}**.`)),
				);
			}
			if (target.locked) {
				return interaction.editReply(
					v2(notice(COLORS.muted, "Character locked", `**${target.name}** is locked in game. Pick another character.`)),
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
					v2(
						notice(
							COLORS.muted,
							"No character yet",
							"Create a character in game first; the daily Royal Sigils are paid onto an unlocked character.",
						),
					),
				);
			}
		}

		const reservation = await reserveDailyClaim(
			discordId,
			{ userId: account.userId, characterName: target.name },
			nowMs,
		);
		if (reservation.status === "pending" || reservation.status === "conflict") {
			return interaction.editReply(
				v2(notice(COLORS.muted, "Claim in progress", "Another daily claim is being paid right now. Try again in a moment.")),
			);
		}
		if (reservation.status === "already-claimed") {
			const streak = currentDailyStreak(await getDailyState(discordId).catch(() => null), utcDay(nowMs));
			return interaction.editReply(
				v2(
					notice(COLORS.muted, "Already claimed today", [
						`You have claimed today's Royal Sigils. Streak: ${days(streak)}.`,
						`${nextClaimLine(nowMs)} It pays **+${formatNumber(dailyRewardForStreak(streak + 1))}** ${SIGIL()}.`,
					]),
				),
			);
		}

		const { pending } = reservation;
		const paid = await pay(discordId, pending);
		if (paid.kind === "unknown") {
			// Kept pending with its request id: the next /daily asks again and is paid once.
			logWarn("daily", "payment_unknown", { user: discordId, requestId: pending.requestId, reason: paid.reason });
			return interaction.editReply(
				v2(notice(COLORS.warning, "Daily reward not confirmed yet", [paid.reason, UNKNOWN_FOOTER])),
			);
		}
		if (paid.kind === "refused") {
			const released = await releaseDailyClaim(discordId, reservation).catch((error) => {
				logError("daily", "release_failed", { user: discordId, error: errorMessage(error) });
				return false;
			});
			logWarn("daily", "payment_refused", { user: discordId, character: target.name, released });
			return interaction.editReply(
				v2(
					notice(COLORS.danger, "Daily reward not paid", [
						paid.reason,
						released
							? "Today's claim was not used up — try again."
							: "Today's claim could not be released; ask staff to check it.",
					]),
				),
			);
		}

		await confirmDailyClaim(discordId, reservation, nowMs);
		logInfo("daily", "claimed", {
			user: discordId,
			character: paid.characterName,
			streak: pending.streak,
			reward: pending.amount,
			online: paid.online,
		});
		return interaction.editReply(
			v2(
				notice(COLORS.success, "Daily reward claimed", [
					`**+${formatNumber(pending.amount)}** ${SIGIL()} Royal Sigils on **${paid.characterName}** — now **${formatNumber(paid.balance)}**.`,
					`Streak: ${days(pending.streak)}.`,
					`${nextClaimLine(nowMs)} ${streakKeptLine(nowMs, pending.streak)}`,
					...(paid.online ? [] : ["-# The character is offline; the sigils are on its save for the next login."]),
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
