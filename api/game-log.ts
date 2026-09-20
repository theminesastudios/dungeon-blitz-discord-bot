import { publishGameLog, resolveGameLogDeliverer, resolveLogChannelId } from "../src/utils/gameLogChannel.js";
import { isRequestAuthorized, sendJson } from "../src/utils/requestAuth.js";

/**
 * Relay for the game server's own lifecycle messages.
 *
 * The game server cannot post to Discord itself (it has no bot token, and the
 * token should not be copied onto the VM), so it posts here with the same shared
 * secret the health pinger already uses. This endpoint only formats and
 * forwards — all decisions about what is worth saying are made on the server,
 * because it is the only side that knows them.
 *
 * POST only: this writes to a channel, and a link that logs a server in or out
 * when someone clicks it is not something to leave lying around.
 *
 * Auth: `Authorization: Bearer <HEALTH_CHECK_SECRET>` (or `?secret=`, or the
 * `x-health-secret` header). Unauthorized requests are refused before the body
 * is even looked at, and an unconfigured deployment answers 503 rather than
 * silently dropping the message.
 */

const MAX_BODY_BYTES = 16_384;

function readJsonBody(req: any): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
	const raw = req?.body;
	if (raw == null) return { ok: false, error: "Missing JSON body." };

	if (typeof raw === "string") {
		if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
			return { ok: false, error: "Body too large." };
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { ok: false, error: "Body must be a JSON object." };
			}
			return { ok: true, body: parsed as Record<string, unknown> };
		} catch {
			return { ok: false, error: "Body is not valid JSON." };
		}
	}

	if (typeof raw === "object" && !Array.isArray(raw)) {
		let encoded = "";
		try {
			encoded = JSON.stringify(raw);
		} catch {
			return { ok: false, error: "Body is not serializable." };
		}
		if (encoded.length > MAX_BODY_BYTES) {
			return { ok: false, error: "Body too large." };
		}
		return { ok: true, body: raw as Record<string, unknown> };
	}

	return { ok: false, error: "Body must be a JSON object." };
}

export default async function handler(req: any, res: any) {
	const method = String(req?.method ?? "POST").toUpperCase();
	if (method !== "POST") {
		res.setHeader("Allow", "POST");
		sendJson(res, 405, { ok: false, error: "Use POST." });
		return;
	}

	if (!isRequestAuthorized(req)) {
		sendJson(res, 401, { ok: false, error: "Unauthorized." });
		return;
	}

	const parsed = readJsonBody(req);
	if (!parsed.ok) {
		sendJson(res, 400, { ok: false, error: parsed.error });
		return;
	}

	const body = parsed.body;
	const event = String(body.event ?? "").trim();
	if (!event) {
		sendJson(res, 400, { ok: false, error: "Missing event." });
		return;
	}

	if (!resolveGameLogDeliverer()) {
		sendJson(res, 503, {
			ok: false,
			error:
				"log channel not configured: set DISCORD_LOG_CHANNEL_ID with DISCORD_BOT_TOKEN, or GAME_HEALTH_WEBHOOK_URL",
			channelId: resolveLogChannelId(),
		});
		return;
	}

	const result = await publishGameLog({
		event,
		...(typeof body.title === "string" ? { title: body.title } : {}),
		...(typeof body.message === "string" ? { message: body.message } : {}),
		...(Array.isArray(body.fields) ? { fields: body.fields as any } : {}),
		...(typeof body.host === "string" ? { host: body.host } : {}),
		...(typeof body.at === "string" ? { at: body.at } : {}),
	});

	if (result.sent) {
		console.log(`[game-log] ${event} → ${result.channel}`);
		sendJson(res, 200, { ok: true, sent: true, channel: result.channel });
		return;
	}

	console.error(`[game-log] ${event} delivery failed: ${result.error ?? "unknown error"}`);
	sendJson(res, 502, { ok: false, sent: false, error: result.error ?? "delivery failed" });
}
