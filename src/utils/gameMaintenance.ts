/**
 * Live Dungeon Blitz game server. Used when GAME_SERVER_BASE_URL is not set
 * so the admin commands keep working without per-deploy configuration.
 *
 * This must be the public hostname, not the VM's raw address. `35.185.71.109`
 * was the default here until 2026-10-03 and is a **reserved but idle** address
 * in the same GCP project — the same finding `gameHealthCheck.ts` already records
 * against that IP. Nothing game-related listens there, so every admin call
 * went to an address that cannot answer, while the site itself lives at
 * `dungeonblitzr.theminesa.studio` (35.241.250.170). Prefer setting
 * GAME_SERVER_BASE_URL per deployment; this default just has to be right when
 * it is not set.
 */
const DEFAULT_GAME_SERVER_BASE_URL = "http://dungeonblitzr.theminesa.studio";

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

/**
 * A rejection from the game server, carrying the HTTP status so a caller can
 * tell a refusal apart from a route the game server does not have. Express
 * answers an unregistered path with an HTML 404 page, which arrives as a
 * non-JSON body rather than the `{ error }` shape the admin routes use.
 */
export class GameServerAdminError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "GameServerAdminError";
		this.status = status;
	}
}

/** Parses a body that may be JSON, or the HTML error page a missing route returns. */
function parseResponseBody(raw: string): unknown {
	const text = raw.trim();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** One rejection reads the same whichever transport met it. */
function rejectionMessage(action: string, status: number, payload: unknown, rawBody = ""): string {
	const detail =
		payload && typeof payload === "object" && "error" in payload
			? String((payload as { error?: unknown }).error ?? "unknown error")
			: status === 404
				? "the game server has no route at this path (it answered with an HTML error page). The route has to be added to the game server before the bot can push to it"
				: rawBody.trim().startsWith("<")
					? "the game server answered with an HTML page instead of JSON, so this request did not reach an admin route"
					: "invalid response";
	return `Game server rejected ${action} (${status}): ${detail}`;
}

/**
 * Shared transport for the game server's `/api/admin/*` endpoints. Every moderation and
 * content tool authorizes with the same shared secret, so the header/error handling lives
 * here instead of being copied per command.
 */
/**
 * `requireOk: false` is for the routes that answer with the state they stored
 * rather than an acknowledgement — the lobby chat channel route replies with the
 * channel it is now linked to, which is data the operator is about to read back.
 * Only an explicit `ok: false` (or an HTTP error) is then treated as a refusal,
 * exactly as the GET helper treats it.
 */
export async function requestGameServerAdmin<T>(
	path: string,
	body: Record<string, unknown>,
	action: string,
	options: { requireOk?: boolean } = {},
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
	const rawBody = await response.text().catch(() => "");
	const payload = parseResponseBody(rawBody) as T | { error?: string } | null;
	const answer = payload as Record<string, unknown> | null;
	const refused =
		options.requireOk === false
			? !response.ok || !answer || answer.ok === false
			: !response.ok || !answer || answer.ok !== true;
	if (refused) {
		throw new GameServerAdminError(
			rejectionMessage(action, response.status, payload, rawBody),
			response.status,
		);
	}
	return payload as T;
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
	const rawBody = await response.text().catch(() => "");
	const payload = parseResponseBody(rawBody) as T | null;
	if (!response.ok) {
		throw new GameServerAdminError(
			rejectionMessage(action, response.status, payload, rawBody),
			response.status,
		);
	}
	if (
		payload &&
		typeof payload === "object" &&
		(payload as { ok?: unknown }).ok === false
	) {
		throw new GameServerAdminError(
			rejectionMessage(action, response.status, payload, rawBody),
			response.status,
		);
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
