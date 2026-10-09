import { formatDuration } from "./logger.js";

/**
 * A character's key in the account's `gameStats.characterPlaytimeMs`, as the game server writes
 * it (`characterPlaytimeKey` in src/server/database/Database.ts): the lowercased name, with '%',
 * '.' and '$' escaped as %XX so it is a safe Mongo field name.
 */
export function characterPlaytimeKey(name: unknown): string {
	return String(name ?? "")
		.trim()
		.toLowerCase()
		.replace(/[%.$]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Playtime for a Discord field: "3d 4h", "2h 15m", "12m 5s", or "—" when none is recorded. */
export function formatPlaytime(ms: number | null | undefined): string {
	const value = Number(ms);
	if (!Number.isFinite(value) || value <= 0) return "—";
	return formatDuration(value / 1000);
}

export type PlaytimeCharacter = {
	characterName: string;
	characterClass: string;
	characterLevel: number;
};

/**
 * One line per character for `/account view` (#443). Discord caps a field at 1024 characters,
 * so the list stops early with a count of the rest.
 */
export function formatCharacterPlaytimeLines(
	characters: PlaytimeCharacter[],
	playtimeByKey: Record<string, number> | null | undefined,
	limit = 1024,
): string {
	if (characters.length === 0) return "No characters yet.";
	const lines: string[] = [];
	let length = 0;
	for (const [index, character] of characters.entries()) {
		const className = character.characterClass ? ` ${character.characterClass}` : "";
		const playtime = formatPlaytime(playtimeByKey?.[characterPlaytimeKey(character.characterName)]);
		const line = `**${character.characterName}** · Lv ${character.characterLevel}${className} — ${playtime}`;
		const rest = characters.length - index - 1;
		const reserve = rest > 0 ? `\n…and ${rest} more`.length : 0;
		if (length + line.length + 1 + reserve > limit) {
			lines.push(`…and ${characters.length - index} more`);
			break;
		}
		lines.push(line);
		length += line.length + 1;
	}
	return lines.join("\n");
}
