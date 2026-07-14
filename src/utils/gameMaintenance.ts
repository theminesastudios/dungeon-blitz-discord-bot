export type MaintenanceBroadcastResult = {
	ok: true;
	seconds: number;
	recipients: number;
};

export async function broadcastGameMaintenance(seconds: number): Promise<MaintenanceBroadcastResult> {
	const baseUrl = String(process.env.GAME_SERVER_BASE_URL ?? "").trim().replace(/\/$/, "");
	const secret = String(process.env.DISCORD_MAINTENANCE_API_SECRET ?? "").trim();
	if (!baseUrl || !secret) {
		throw new Error("GAME_SERVER_BASE_URL and DISCORD_MAINTENANCE_API_SECRET are required");
	}

	const response = await fetch(`${baseUrl}/api/admin/maintenance`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ seconds }),
		signal: AbortSignal.timeout(10_000),
	});
	const payload = (await response.json().catch(() => null)) as
		| MaintenanceBroadcastResult
		| { error?: string }
		| null;
	if (!response.ok || !payload || !("ok" in payload) || payload.ok !== true) {
		throw new Error(
			`Game server rejected maintenance broadcast (${response.status}): ${payload && "error" in payload ? payload.error ?? "unknown error" : "invalid response"}`,
		);
	}
	return payload;
}
