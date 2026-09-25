/**
 * Live Dungeon Blitz game server. Used when GAME_SERVER_BASE_URL is not set
 * so the admin commands keep working without per-deploy configuration.
 */
const DEFAULT_GAME_SERVER_BASE_URL = "http://35.185.71.109";

function getGameServerBaseUrl(): string {
	const configured = String(process.env.GAME_SERVER_BASE_URL ?? "").trim().replace(/\/+$/, "");
	return configured || DEFAULT_GAME_SERVER_BASE_URL;
}

export type MaintenanceBroadcastResult = {
	ok: true;
	seconds: number;
	recipients: number;
};

export type GameIdolAdjustmentResult = {
	ok: true;
	userId: number;
	characterName: string;
	operation: "add" | "sub";
	amount: number;
	before: number;
	after: number;
	onlineRecipients: number;
};

/**
 * The shared secret every admin call authorizes with. A missing one is a bot-side
 * misconfiguration, so it is reported before anything is sent and names the fix.
 */
function requireAdminSecret(): string {
	const secret = String(process.env.DISCORD_MAINTENANCE_API_SECRET ?? "").trim();
	if (!secret) {
		throw new Error(
			"the bot deployment is missing DISCORD_MAINTENANCE_API_SECRET, so it cannot authorize with the game server. Set it there to the same value configured on the game server.",
		);
	}
	return secret;
}

/** One rejection reads the same whichever transport met it. */
function rejectionMessage(action: string, status: number, payload: unknown): string {
	const detail =
		payload && typeof payload === "object" && "error" in payload
			? String((payload as { error?: unknown }).error ?? "unknown error")
			: "invalid response";
	return `Game server rejected ${action} (${status}): ${detail}`;
}

/**
 * Shared transport for the game server's `/api/admin/*` endpoints. Every moderation and
 * content tool authorizes with the same shared secret, so the header/error handling lives
 * here instead of being copied per command.
 */
export async function requestGameServerAdmin<T extends { ok: true }>(
	path: string,
	body: Record<string, unknown>,
	action: string,
): Promise<T> {
	const response = await fetch(`${getGameServerBaseUrl()}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${requireAdminSecret()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
	if (!response.ok || !payload || !("ok" in payload) || payload.ok !== true) {
		throw new Error(rejectionMessage(action, response.status, payload));
	}
	return payload;
}

/**
 * GET counterpart of the admin transport. Reading content the game owns is not a
 * moderation action, but it authorizes with the same shared secret, so it shares the
 * base-url resolution and the rejection wording. Unlike the POST helper it does not
 * require `ok: true` in the body — a catalogue is data, and only an explicit
 * `ok: false` is treated as a refusal.
 */
export async function fetchGameServerAdmin<T>(
	path: string,
	action: string,
	timeoutMs = 8_000,
): Promise<T> {
	const response = await fetch(`${getGameServerBaseUrl()}${path}`, {
		headers: {
			Authorization: `Bearer ${requireAdminSecret()}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	const payload = (await response.json().catch(() => null)) as T | null;
	if (!response.ok) {
		throw new Error(rejectionMessage(action, response.status, payload));
	}
	if (
		payload &&
		typeof payload === "object" &&
		(payload as { ok?: unknown }).ok === false
	) {
		throw new Error(rejectionMessage(action, response.status, payload));
	}
	return payload as T;
}

export async function broadcastGameMaintenance(seconds: number): Promise<MaintenanceBroadcastResult> {
	return requestGameServerAdmin<MaintenanceBroadcastResult>(
		"/api/admin/maintenance",
		{ seconds },
		"maintenance broadcast",
	);
}

export async function adjustGameMammothIdols(
	userId: number,
	characterName: string,
	operation: "add" | "sub",
	amount: number,
): Promise<GameIdolAdjustmentResult> {
	return requestGameServerAdmin<GameIdolAdjustmentResult>(
		"/api/admin/idols",
		{ userId, characterName, operation, amount },
		"Mammoth Idol adjustment",
	);
}
