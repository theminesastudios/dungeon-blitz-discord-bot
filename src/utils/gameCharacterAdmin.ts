import { postGameServerAdmin } from "./gameMaintenance.js";

/**
 * Renaming and deleting a character change the save the game server holds in memory for an
 * online player, so — like idol adjustments — they go through the game server instead of a
 * direct MongoDB write, which a live session would silently overwrite on its next save.
 *
 *   POST /api/admin/character/rename { userId, characterName, newName, cost, requestedByDiscordId }
 *     200 { ok: true, userId, oldName, newName, idolsBefore, idolsAfter }
 *   POST /api/admin/character/delete { userId, characterName, requestedByDiscordId }
 *     200 { ok: true, userId, characterName, remaining }
 *
 * A refusal is `{ error, code }` with code `online`, `name-taken`, `invalid-name`,
 * `insufficient-idols` or `not-found`. The game server checks the idol balance and charges
 * it in the same step as the rename, so a player can never pay without being renamed.
 */

/** What a rename costs, in Mammoth Idols (account-wide, see game issue #529). */
export const RENAME_COST_IDOLS = 500;

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{2,15}$/;

/** Bot-side pre-check so an obviously bad name never reaches the confirmation step. */
export function validateCharacterName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
	const name = raw.trim();
	if (!NAME_PATTERN.test(name)) {
		return {
			ok: false,
			reason: "Names are 3-16 letters or digits and start with a letter.",
		};
	}
	return { ok: true, name };
}

export type CharacterAdminRefusal =
	| "online"
	| "name-taken"
	| "invalid-name"
	| "insufficient-idols"
	| "not-found"
	| "unavailable";

export type RenameResult =
	| { ok: true; oldName: string; newName: string; idolsBefore: number; idolsAfter: number }
	| { ok: false; refusal: CharacterAdminRefusal; message: string };

export type DeleteResult =
	| { ok: true; characterName: string; remaining: number }
	| { ok: false; refusal: CharacterAdminRefusal; message: string };

const REFUSAL_TEXT: Record<CharacterAdminRefusal, string> = {
	online: "You are signed in to the game right now. Log out completely, then try again.",
	"name-taken": "That name is already taken by another character.",
	"invalid-name": "The game does not accept that name.",
	"insufficient-idols": `You need ${RENAME_COST_IDOLS} Mammoth Idols to rename a character.`,
	"not-found": "That character no longer exists on your account.",
	unavailable: "The game server could not be reached. Nothing was changed — please try again later.",
};

const KNOWN_CODES = new Set<CharacterAdminRefusal>([
	"online",
	"name-taken",
	"invalid-name",
	"insufficient-idols",
	"not-found",
]);

function refusalFrom(status: number, payload: unknown): CharacterAdminRefusal {
	const code = String((payload as { code?: unknown } | null)?.code ?? "");
	if (KNOWN_CODES.has(code as CharacterAdminRefusal)) return code as CharacterAdminRefusal;
	if (status === 404 && payload && typeof payload === "object") return "not-found";
	// A 404 without a JSON body is Express's page for a route the game server does not have yet.
	return "unavailable";
}

async function call(
	path: string,
	body: Record<string, unknown>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; refusal: CharacterAdminRefusal; message: string }> {
	try {
		const { status, payload } = await postGameServerAdmin(path, body);
		const answer = payload as Record<string, unknown> | null;
		if (status >= 200 && status < 300 && answer?.ok === true) return { ok: true, payload: answer };
		const refusal = refusalFrom(status, payload);
		if (refusal === "unavailable") {
			console.error(`[character-admin] ${path} answered ${status}:`, payload);
		}
		return { ok: false, refusal, message: REFUSAL_TEXT[refusal] };
	} catch (error) {
		console.error(`[character-admin] ${path} failed:`, error);
		return { ok: false, refusal: "unavailable", message: REFUSAL_TEXT.unavailable };
	}
}

export async function renameGameCharacter(input: {
	userId: number;
	characterName: string;
	newName: string;
	requestedByDiscordId: string;
}): Promise<RenameResult> {
	const result = await call("/api/admin/character/rename", { ...input, cost: RENAME_COST_IDOLS });
	if (!result.ok) return result;
	return {
		ok: true,
		oldName: String(result.payload.oldName ?? input.characterName),
		newName: String(result.payload.newName ?? input.newName),
		idolsBefore: Number(result.payload.idolsBefore ?? 0),
		idolsAfter: Number(result.payload.idolsAfter ?? 0),
	};
}

export async function deleteGameCharacter(input: {
	userId: number;
	characterName: string;
	requestedByDiscordId: string;
}): Promise<DeleteResult> {
	const result = await call("/api/admin/character/delete", input);
	if (!result.ok) return result;
	return {
		ok: true,
		characterName: String(result.payload.characterName ?? input.characterName),
		remaining: Number(result.payload.remaining ?? 0),
	};
}
