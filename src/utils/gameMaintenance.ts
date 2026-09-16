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

async function requestGameServerAdmin<T extends { ok: true }>(
	path: string,
	body: Record<string, unknown>,
	action: string,
): Promise<T> {
	const baseUrl = getGameServerBaseUrl();
	const secret = String(process.env.DISCORD_MAINTENANCE_API_SECRET ?? "").trim();
	if (!secret) {
		throw new Error(
			"the bot deployment is missing DISCORD_MAINTENANCE_API_SECRET, so it cannot authorize with the game server. Set it there to the same value configured on the game server.",
		);
	}

	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
	if (!response.ok || !payload || !("ok" in payload) || payload.ok !== true) {
		throw new Error(
			`Game server rejected ${action} (${response.status}): ${payload && "error" in payload ? payload.error ?? "unknown error" : "invalid response"}`,
		);
	}
	return payload;
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
