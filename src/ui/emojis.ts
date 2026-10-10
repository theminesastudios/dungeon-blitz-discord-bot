import type { APIMessageComponentEmoji } from "discord-api-types/v10";
import { EMOJI_IDS } from "./emojiIds.js";

/**
 * Game icons uploaded as application emojis: `scripts/sync-emojis.ts` uploads the PNGs in
 * `assets/emojis/` (exported from the client SWFs with FFDec) and writes `emojiIds.ts`.
 *
 * Every icon has a unicode fallback, so a fresh deployment — or one whose application has
 * not had the emojis uploaded yet — still renders something sensible instead of `:name:`.
 */
const FALLBACKS = {
	class_mage: "🔮",
	class_rogue: "🗡️",
	class_paladin: "🛡️",
	disc_executioner: "🪓",
	disc_shadowwalker: "🌑",
	disc_soulthief: "👻",
	disc_sentinel: "🏰",
	disc_justicar: "⚖️",
	disc_templar: "✝️",
	disc_frostwarden: "❄️",
	disc_flameseer: "🔥",
	disc_necromancer: "💀",
	cur_gold: "💰",
	cur_idol: "🗿",
	cur_dragon_key: "🗝️",
	cur_dragon_ore: "⛏️",
	cur_silver_sigil: "🪙",
	cur_royal_sigil: "👑",
	ui_level: "⭐",
	ui_quest: "📜",
	ui_character: "👤",
	ui_rename: "✏️",
	ui_delete: "🗑️",
} as const;

export type EmojiName = keyof typeof FALLBACKS;

function uploadedId(name: EmojiName): string | null {
	const id = String(EMOJI_IDS[name] ?? "").trim();
	return /^\d{15,25}$/.test(id) ? id : null;
}

/** Inline form for text: `<:cur_gold:123>` or the unicode fallback. */
export function emoji(name: EmojiName): string {
	const id = uploadedId(name);
	return id ? `<:${name}:${id}>` : FALLBACKS[name];
}

/** Component form for buttons and select options. */
export function componentEmoji(name: EmojiName): APIMessageComponentEmoji {
	const id = uploadedId(name);
	return id ? { id, name } : { name: FALLBACKS[name] };
}

const CLASS_EMOJI: Record<string, EmojiName> = {
	mage: "class_mage",
	rogue: "class_rogue",
	paladin: "class_paladin",
};

/** The base-class icon, or the generic character icon for a class the bot does not know. */
export function classEmoji(characterClass: string): string {
	return emoji(CLASS_EMOJI[characterClass.trim().toLowerCase()] ?? "ui_character");
}

export function classComponentEmoji(characterClass: string): APIMessageComponentEmoji {
	return componentEmoji(CLASS_EMOJI[characterClass.trim().toLowerCase()] ?? "ui_character");
}

/** Discipline icon by `MasterClassID`; empty for none chosen or an id the bot does not know. */
const DISCIPLINE_EMOJI: Record<number, EmojiName> = {
	1: "disc_executioner",
	2: "disc_shadowwalker",
	3: "disc_soulthief",
	4: "disc_sentinel",
	5: "disc_justicar",
	6: "disc_templar",
	7: "disc_frostwarden",
	8: "disc_flameseer",
	9: "disc_necromancer",
};

export function disciplineEmoji(masterClassId: number): string {
	const name = DISCIPLINE_EMOJI[Math.trunc(Number(masterClassId))];
	return name ? emoji(name) : "";
}
