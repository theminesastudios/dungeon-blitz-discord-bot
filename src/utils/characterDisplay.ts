import { MISSIONS, type MissionInfo } from "../data/missions.js";
import { classEmoji, disciplineEmoji, emoji } from "../ui/emojis.js";
import { masterClassName } from "./gameStatsSync.js";
import type { GameWalletSummary } from "./gameWallet.js";

/** The game's mission states (`MissionHandler`): only 1 and 2 are a quest still on the tracker. */
const MISSION_IN_PROGRESS = 1;
const MISSION_READY_TO_TURN_IN = 2;

export type CurrentQuest = MissionInfo & { id: number; readyToTurnIn: boolean };

/**
 * The quest a player is on: of the missions still on their tracker, the story quest first
 * (that is the one the game's tracker leads with), then the highest-level one.
 */
export function currentQuest(missions: Record<string, number>): CurrentQuest | null {
	let best: CurrentQuest | null = null;
	for (const [key, state] of Object.entries(missions)) {
		if (state !== MISSION_IN_PROGRESS && state !== MISSION_READY_TO_TURN_IN) continue;
		const id = Number(key);
		const info = MISSIONS[id];
		if (!info) continue;
		const candidate = { ...info, id, readyToTurnIn: state === MISSION_READY_TO_TURN_IN };
		if (
			!best ||
			Number(candidate.story) - Number(best.story) > 0 ||
			(candidate.story === best.story &&
				(candidate.level > best.level || (candidate.level === best.level && id > best.id)))
		) {
			best = candidate;
		}
	}
	return best;
}

/** `**Goblin Assault** — Defend the Niobe…`, or a plain line when nothing is tracked. */
export function formatQuest(quest: CurrentQuest | null): string {
	if (!quest) return "No active quest";
	const objective = quest.readyToTurnIn ? quest.turnIn || "Ready to turn in" : quest.tracker;
	return objective ? `**${quest.name}** — ${objective}` : `**${quest.name}**`;
}

/** The discipline's name, or null while the character has not chosen one. */
export function disciplineName(character: Pick<GameWalletSummary, "characterMasterClass">): string | null {
	return masterClassName(character.characterMasterClass) || null;
}

/**
 * The small grey line under a character's name:
 * `-# ⭐ Level 50 · 🔮 Mage · 🔥 Flameseer`.
 */
export function characterSubtitle(character: GameWalletSummary): string {
	const parts = [`${emoji("ui_level")} Level ${character.characterLevel}`];
	if (character.characterClass) {
		parts.push(`${classEmoji(character.characterClass)} ${character.characterClass}`);
	}
	const discipline = disciplineName(character);
	parts.push(
		discipline
			? `${disciplineEmoji(character.characterMasterClass)} ${discipline}`.trim()
			: "No discipline yet",
	);
	return `-# ${parts.join(" · ")}`;
}
