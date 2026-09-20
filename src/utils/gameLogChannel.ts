/**
 * The operator log channel.
 *
 * The game server reports its own lifecycle here — starting, stopping, and the
 * exception it is about to die of. That is deliberately not the health check's
 * job: the pinger notices a dead host a few minutes late and can only say "down",
 * while an uncaught exception knows what broke, how long the process had been up
 * and whether pm2 is about to restart it. Together the two cover the whole
 * failure surface — pm2's own restarts show up as a start message, a hard kill
 * (OOM, machine death) shows up as the health check going red.
 *
 * Delivery mirrors the health alerts: the bot token posts to
 * DISCORD_LOG_CHANNEL_ID when it is set, otherwise the same webhook the health
 * alerts use. Both accept the embed this module builds, so the log channel keeps
 * the formatting either way.
 */

export const DEFAULT_LOG_CHANNEL_ID = "1551118889503432765";

const EMBED_TITLE_LIMIT = 256;
const EMBED_DESCRIPTION_LIMIT = 4000;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const MAX_FIELDS = 25;
const DELIVERY_TIMEOUT_MS = 8_000;

export type GameLogEvent =
	| "started"
	| "stopping"
	| "crashed"
	| "startup-failed"
	| "reloading"
	| (string & {});

export type GameLogField = {
	name: string;
	value: string;
	inline?: boolean;
};

export type GameLogPayload = {
	event: GameLogEvent;
	/** Overrides the built-in title for the event. */
	title?: string;
	/** Free text: the one line an operator reads first. */
	message?: string;
	fields?: GameLogField[];
	/** Which host sent this, e.g. "dungeonblitzr.theminesa.studio". */
	host?: string;
	/** ISO timestamp; defaults to now. */
	at?: string;
};

export type GameLogEmbed = {
	title: string;
	description?: string;
	color: number;
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
	timestamp: string;
	footer?: { text: string };
};

export type GameLogDeliverer = {
	channel: string;
	deliver: (embed: GameLogEmbed) => Promise<string | null>;
};

export type GameLogPublishResult = {
	sent: boolean;
	channel: string | null;
	error?: string;
};

const EVENT_TITLES: Record<string, string> = {
	started: "🟢 Game server started",
	stopping: "🟡 Game server shutting down",
	crashed: "🛑 Game server crashed",
	"startup-failed": "🔴 Game server failed to start",
	reloading: "🔁 Game server reloading",
};

const EVENT_COLORS: Record<string, number> = {
	started: 0x2ecc71,
	stopping: 0xf1c40f,
	crashed: 0xe74c3c,
	"startup-failed": 0x992d22,
	reloading: 0x3498db,
};

const DEFAULT_COLOR = 0x5865f2;

export function normalizeLogEvent(raw: unknown): string {
	const value = String(raw ?? "").trim().toLowerCase();
	if (!value) return "unknown";
	return value.slice(0, 64).replace(/[^a-z0-9_-]/g, "");
}

export function logEventTitle(event: string, override?: string): string {
	const explicit = cleanText(override, EMBED_TITLE_LIMIT);
	if (explicit) return explicit;
	const known = EVENT_TITLES[event];
	if (known) return known;
	return `ℹ️ Game server event: ${cleanText(event, 64) || "unknown"}`;
}

export function logEventColor(event: string): number {
	return EVENT_COLORS[event] ?? DEFAULT_COLOR;
}

/** Strips control characters that would break rendering, then caps the length. */
export function cleanText(raw: unknown, limit: number): string {
	const text = String(raw ?? "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function cleanFields(fields: GameLogPayload["fields"]): Array<{ name: string; value: string; inline?: boolean }> | undefined {
	if (!Array.isArray(fields)) return undefined;
	const cleaned: Array<{ name: string; value: string; inline?: boolean }> = [];
	for (const field of fields) {
		if (!field || typeof field !== "object") continue;
		const name = cleanText(field.name, FIELD_NAME_LIMIT);
		const value = cleanText(field.value, FIELD_VALUE_LIMIT);
		if (!name || !value) continue;
		cleaned.push({ name, value, ...(field.inline ? { inline: true } : {}) });
		if (cleaned.length >= MAX_FIELDS) break;
	}
	return cleaned.length ? cleaned : undefined;
}

/**
 * One payload in, one Discord embed out. Pure on purpose: the shape is the only
 * thing worth pinning in tests, and the game server never has to know what a
 * Discord embed looks like.
 */
export function buildGameLogEmbed(payload: GameLogPayload, now: Date = new Date()): GameLogEmbed {
	const event = normalizeLogEvent(payload.event);
	const timestamp = (() => {
		const raw = String(payload.at ?? "").trim();
		if (!raw) return now.toISOString();
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now.toISOString();
	})();
	const description = cleanText(payload.message, EMBED_DESCRIPTION_LIMIT);
	const fields = cleanFields(payload.fields);
	const host = cleanText(payload.host, 100);

	return {
		title: logEventTitle(event, payload.title),
		...(description ? { description } : {}),
		color: logEventColor(event),
		...(fields ? { fields } : {}),
		timestamp,
		...(host ? { footer: { text: host } } : {}),
	};
}

export function createLogChannelDeliverer(channelId: string, botToken: string): GameLogDeliverer {
	const targetChannel = String(channelId ?? "").trim();
	return {
		channel: `discord-channel:${targetChannel}`,
		deliver: async (embed) => {
			const response = await fetch(`https://discord.com/api/v10/channels/${targetChannel}/messages`, {
				method: "POST",
				headers: {
					Authorization: `Bot ${botToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
				signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
			});
			return response.ok ? `discord-channel:${targetChannel}` : null;
		},
	};
}

export function createLogWebhookDeliverer(webhookUrl: string): GameLogDeliverer {
	return {
		channel: "discord-webhook",
		deliver: async (embed) => {
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ embeds: [embed] }),
				signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
			});
			return response.ok ? "discord-webhook" : null;
		},
	};
}

export function resolveLogChannelId(env: NodeJS.ProcessEnv = process.env): string {
	return (env.DISCORD_LOG_CHANNEL_ID ?? "").trim() || DEFAULT_LOG_CHANNEL_ID;
}

/**
 * Transports, in the order that keeps a working deployment working:
 *
 *   1. DISCORD_LOG_WEBHOOK_URL — an explicit log webhook wins outright.
 *   2. DISCORD_LOG_CHANNEL_ID + DISCORD_BOT_TOKEN — an explicitly named channel
 *      is posted by the bot, which is assumed to have been granted access to it.
 *   3. GAME_HEALTH_WEBHOOK_URL — the default deployment's transport. The alert
 *      webhook already points at the log channel, so a bot token alone does not
 *      get to shadow it: a bot that lacks View Channel/Send Messages in that
 *      channel would fail every message while a webhook that works sits unused.
 *   4. DISCORD_BOT_TOKEN with the built-in channel id — for deployments without
 *      any webhook at all.
 */
export function resolveGameLogDeliverer(env: NodeJS.ProcessEnv = process.env): GameLogDeliverer | null {
	const botToken = (env.DISCORD_BOT_TOKEN ?? "").trim();
	const explicitLogWebhook = (env.DISCORD_LOG_WEBHOOK_URL ?? "").trim();
	if (explicitLogWebhook) {
		return createLogWebhookDeliverer(explicitLogWebhook);
	}

	const explicitChannelId = (env.DISCORD_LOG_CHANNEL_ID ?? "").trim();
	if (explicitChannelId && botToken) {
		return createLogChannelDeliverer(explicitChannelId, botToken);
	}

	const healthWebhook = (env.GAME_HEALTH_WEBHOOK_URL ?? "").trim();
	if (healthWebhook) {
		return createLogWebhookDeliverer(healthWebhook);
	}

	if (botToken) {
		return createLogChannelDeliverer(DEFAULT_LOG_CHANNEL_ID, botToken);
	}

	return null;
}

/**
 * Never throws: a lifecycle message that cannot be delivered must not be the
 * reason a shutdown or a crash handler misbehaves.
 */
export async function publishGameLog(
	payload: GameLogPayload,
	options: { env?: NodeJS.ProcessEnv; deliver?: GameLogDeliverer | null; now?: Date } = {},
): Promise<GameLogPublishResult> {
	const deliverer = options.deliver !== undefined ? options.deliver : resolveGameLogDeliverer(options.env);
	if (!deliverer) {
		return {
			sent: false,
			channel: null,
			error:
				"no log channel configured: set DISCORD_LOG_WEBHOOK_URL or GAME_HEALTH_WEBHOOK_URL, or DISCORD_LOG_CHANNEL_ID with DISCORD_BOT_TOKEN",
		};
	}

	try {
		const embed = buildGameLogEmbed(payload, options.now);
		const channel = await deliverer.deliver(embed);
		if (channel) return { sent: true, channel };
		return { sent: false, channel: null, error: "delivery failed" };
	} catch (error) {
		return {
			sent: false,
			channel: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
