/**
 * Out-of-band health check for the Dungeon Blitz game host.
 *
 * The bot deployment runs on Vercel — a different network and DNS resolver than
 * the game server and any developer machine — so probing from here is an
 * independent vantage point. When the game hostname stops resolving or its
 * sockets stop answering, this notices and alerts, so a silent DNS or socket
 * outage cannot go unnoticed for hours again (2026-09: the dungeonblitzr A
 * record went missing during a DNS migration and nobody was told).
 *
 * Consumed by api/game-health.ts, which is called on a schedule (the game
 * server pings it every few minutes; a Vercel Cron or any external pinger
 * works too). Alerts go to a Discord webhook (GAME_HEALTH_WEBHOOK_URL) or a
 * Discord DM (GAME_HEALTH_ALERT_DISCORD_ID plus the bot token). Alert state is
 * deduped in MongoDB so an outage produces one alert plus periodic reminders
 * and one recovery message — not a ping on every check.
 */
import * as dns from "node:dns";
import * as net from "node:net";
import { MongoClient } from "mongodb";

const DEFAULT_HOSTNAME = "dungeonblitzr.theminesa.studio";
const DEFAULT_EXPECTED_IP = "35.185.71.109";
const DEFAULT_PAGE_PATH = "/api/auth/discord/config";
const DEFAULT_REMINDER_MINUTES = 60;
const CONNECT_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 5_000;
const POLICY_TIMEOUT_MS = 4_000;
const POLICY_REQUEST = "<policy-file-request/>\0";

export type GameHealthDnsStatus = "ok" | "nxdomain" | "mismatch" | "error";
export type GameHealthSocketStatus = "ok" | "refused" | "timeout" | "error";
export type GameHealthOverall = "healthy" | "degraded" | "down";

export type GameHealthReport = {
	checkedAt: string;
	hostname: string;
	expectedIp: string;
	dns: { status: GameHealthDnsStatus; resolvedIps: string[]; error?: string };
	page: { status: "ok" | "error"; httpStatus?: number; error?: string };
	socket843: { status: GameHealthSocketStatus; answeredPolicy: boolean; error?: string };
	socket8080: { status: GameHealthSocketStatus; error?: string };
	overall: GameHealthOverall;
};

export type GameHealthStateRecord = {
	_id: string;
	alertOpen: boolean;
	firstUnhealthyAt?: string;
	lastUnhealthyAt?: string;
	lastHealthyAt?: string;
	lastAlertAt?: string;
	lastReminderAt?: string;
	lastRecoveryAt?: string;
	lastSummary?: string;
};

export type GameHealthStateStore = {
	findOne(query: { _id: string }): Promise<GameHealthStateRecord | null>;
	upsert(record: GameHealthStateRecord): Promise<void>;
};

export type GameHealthAlertResult = {
	sent: boolean;
	kind: "alert" | "reminder" | "recovery" | null;
	channel: string | null;
	error?: string;
};

export type GameHealthDeliverer = {
	channel: string;
	deliver: (text: string) => Promise<string | null>;
};

export type SocketProbe = { status: GameHealthSocketStatus; answeredPolicy?: boolean; error?: string };

export type GameHealthCheckOptions = {
	hostname?: string;
	expectedIp?: string;
	pagePath?: string;
	now?: Date;
	resolve4?: (hostname: string) => Promise<string[]>;
	fetchPage?: (url: string) => Promise<{ status: number }>;
	connectSocket?: (port: number) => Promise<SocketProbe>;
};

export type GameHealthNotifyOptions = {
	store?: GameHealthStateStore | null;
	deliver?: GameHealthDeliverer | null;
	reminderMinutes?: number;
	now?: Date;
};

function defaultResolve4(): (hostname: string) => Promise<string[]> {
	return (hostname) => dns.promises.resolve4(hostname);
}

async function defaultFetchPage(url: string): Promise<{ status: number }> {
	const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
	return { status: response.status };
}

async function defaultConnectSocket(host: string, port: number): Promise<SocketProbe> {
	return await new Promise<SocketProbe>((resolve) => {
		const socket = net.createConnection({ host, port });
		let settled = false;
		let buffer = "";
		const finish = (probe: SocketProbe) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(probe);
		};
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish({ status: "timeout" }));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			const code = error.code ?? "";
			finish({
				status: code === "ECONNREFUSED" || code === "ECONNRESET" ? "refused" : "error",
				error: code || String(error),
			});
		});
		socket.on("connect", () => {
			if (port !== 843) {
				finish({ status: "ok" });
				return;
			}
			// A TCP connect alone proves little on 843: ask for the Flash policy file
			// and require the policy document back, which is what the game client does.
			socket.setTimeout(POLICY_TIMEOUT_MS);
			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.includes("cross-domain-policy")) {
					finish({ status: "ok", answeredPolicy: true });
				}
			});
			socket.on("close", () => {
				if (!settled) {
					finish({
						status: "error",
						error: buffer ? "closed without a policy document" : "closed without answering the policy request",
					});
				}
			});
			socket.write(POLICY_REQUEST);
		});
	});
}

/**
 * DNS must resolve (and still point at the VM), the site must answer over HTTP,
 * and both game sockets must respond. Any DNS or page failure is "down"; a
 * socket failure with the site up is "degraded" (players cannot play, but the
 * deployment is reachable and worth a different diagnosis).
 */
export async function checkGameHealth(options: GameHealthCheckOptions = {}): Promise<GameHealthReport> {
	const hostname = options.hostname?.trim() || DEFAULT_HOSTNAME;
	const expectedIp = options.expectedIp?.trim() || DEFAULT_EXPECTED_IP;
	const pagePath = options.pagePath?.trim() || DEFAULT_PAGE_PATH;
	const resolve4 = options.resolve4 ?? defaultResolve4();
	const fetchPage = options.fetchPage ?? defaultFetchPage;
	const connectSocket =
		options.connectSocket ?? ((port: number) => defaultConnectSocket(hostname, port));
	const checkedAt = (options.now ?? new Date()).toISOString();

	let dnsStatus: GameHealthDnsStatus;
	let dnsError: string | undefined;
	let resolvedIps: string[] = [];
	try {
		resolvedIps = await resolve4(hostname);
		if (!Array.isArray(resolvedIps) || resolvedIps.length === 0) dnsStatus = "nxdomain";
		else if (!resolvedIps.includes(expectedIp)) dnsStatus = "mismatch";
		else dnsStatus = "ok";
	} catch (error) {
		dnsStatus = "error";
		dnsError = error instanceof Error ? error.message : String(error);
	}

	let pageHttpStatus: number | undefined;
	let pageError: string | undefined;
	let pageStatus: "ok" | "error" = "error";
	try {
		const page = await fetchPage(`http://${hostname}${pagePath}`);
		pageHttpStatus = page.status;
		pageStatus = page.status >= 200 && page.status < 400 ? "ok" : "error";
		if (pageStatus === "error") pageError = "unexpected status";
	} catch (error) {
		pageError = error instanceof Error ? error.message : String(error);
	}

	const [socket843, socket8080] = await Promise.all([
		connectSocket(843).catch((error: unknown): SocketProbe => ({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		})),
		connectSocket(8080).catch((error: unknown): SocketProbe => ({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		})),
	]);

	let overall: GameHealthOverall;
	if (dnsStatus !== "ok" || pageStatus !== "ok") overall = "down";
	else if (socket843.status !== "ok" || socket8080.status !== "ok") overall = "degraded";
	else overall = "healthy";

	return {
		checkedAt,
		hostname,
		expectedIp,
		dns: { status: dnsStatus, resolvedIps, ...(dnsError ? { error: dnsError } : {}) },
		page: {
			status: pageStatus,
			...(pageHttpStatus === undefined ? {} : { httpStatus: pageHttpStatus }),
			...(pageError ? { error: pageError } : {}),
		},
		socket843: {
			status: socket843.status,
			answeredPolicy: socket843.answeredPolicy === true,
			...(socket843.error ? { error: socket843.error } : {}),
		},
		socket8080: {
			status: socket8080.status,
			...(socket8080.error ? { error: socket8080.error } : {}),
		},
		overall,
	};
}

export function summarizeGameHealth(report: GameHealthReport): string {
	const dnsLine =
		report.dns.status === "ok"
			? `DNS: ${report.hostname} resolves to ${report.dns.resolvedIps.join(", ")}`
			: report.dns.status === "nxdomain"
				? `DNS: ${report.hostname} does not resolve (NXDOMAIN) — expected ${report.expectedIp}`
				: report.dns.status === "mismatch"
					? `DNS: ${report.hostname} resolves to ${report.dns.resolvedIps.join(", ")}, expected ${report.expectedIp}`
					: `DNS: lookup failed (${report.dns.error ?? "unknown error"})`;
	const pageLine =
		report.page.status === "ok"
			? `Page: HTTP ${report.page.httpStatus}`
			: `Page: failed${report.page.httpStatus === undefined ? "" : ` (HTTP ${report.page.httpStatus})`}${report.page.error ? ` (${report.page.error})` : ""}`;
	const p843 =
		report.socket843.status === "ok"
			? `answering${report.socket843.answeredPolicy ? " (policy served)" : ""}`
			: report.socket843.status;
	return [
		dnsLine,
		pageLine,
		`Port 843 (policy server): ${p843}`,
		`Port 8080 (game protocol): ${report.socket8080.status}`,
		`Overall: ${report.overall} at ${report.checkedAt}`,
	].join("\n");
}

export function createWebhookDeliverer(webhookUrl: string): GameHealthDeliverer {
	return {
		channel: "discord-webhook",
		deliver: async (text) => {
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: text }),
				signal: AbortSignal.timeout(8_000),
			});
			return response.ok ? "discord-webhook" : null;
		},
	};
}

export function createDiscordDmDeliverer(userId: string, botToken: string): GameHealthDeliverer {
	return {
		channel: `discord-dm:${userId}`,
		deliver: async (text) => {
			const openResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
				method: "POST",
				headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
				body: JSON.stringify({ recipient_id: userId }),
				signal: AbortSignal.timeout(8_000),
			});
			if (!openResponse.ok) return null;
			const { id } = (await openResponse.json()) as { id?: string };
			if (!id) return null;
			const messageResponse = await fetch(`https://discord.com/api/v10/channels/${id}/messages`, {
				method: "POST",
				headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
				body: JSON.stringify({ content: text }),
				signal: AbortSignal.timeout(8_000),
			});
			return messageResponse.ok ? `discord-dm:${userId}` : null;
		},
	};
}

export function resolveGameHealthDeliverer(env: NodeJS.ProcessEnv = process.env): GameHealthDeliverer | null {
	const webhookUrl = env.GAME_HEALTH_WEBHOOK_URL?.trim();
	if (webhookUrl) return createWebhookDeliverer(webhookUrl);
	const userId = env.GAME_HEALTH_ALERT_DISCORD_ID?.trim();
	const botToken = env.DISCORD_BOT_TOKEN?.trim();
	if (userId && botToken) return createDiscordDmDeliverer(userId, botToken);
	return null;
}

function parseReminderMinutes(raw: string | undefined): number | undefined {
	const parsed = Number(raw?.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Sends the first alert on a down/degraded transition, reminders at most once
 * per window while it lasts, and one recovery message when healthy returns.
 * Delivery happens before the state is saved, so a failed delivery is retried
 * on the next check instead of being swallowed by the dedupe.
 */
export async function maybeAlertOnGameHealth(
	report: GameHealthReport,
	options: GameHealthNotifyOptions = {},
): Promise<GameHealthAlertResult> {
	const now = options.now ?? new Date();
	const store = options.store ?? null;
	const deliverer =
		options.deliver !== undefined
			? options.deliver
			: resolveGameHealthDeliverer();
	const reminderMinutes =
		options.reminderMinutes ??
		parseReminderMinutes(process.env.GAME_HEALTH_REMINDER_MINUTES) ??
		DEFAULT_REMINDER_MINUTES;

	const previous = store
		? await store.findOne({ _id: report.hostname }).catch(() => null)
		: null;
	const persist = async (record: GameHealthStateRecord): Promise<void> => {
		if (!store) return;
		await store.upsert(record).catch(() => undefined);
	};

	const attempt = async (
		kind: NonNullable<GameHealthAlertResult["kind"]>,
		text: string,
	): Promise<GameHealthAlertResult> => {
		if (!deliverer) {
			return {
				sent: false,
				kind,
				channel: null,
				error:
					"no alert channel configured: set GAME_HEALTH_WEBHOOK_URL, or GAME_HEALTH_ALERT_DISCORD_ID with DISCORD_BOT_TOKEN",
			};
		}
		try {
			const channel = await deliverer.deliver(text);
			if (channel) return { sent: true, kind, channel };
			return { sent: false, kind, channel: null, error: "delivery failed" };
		} catch (error) {
			return {
				sent: false,
				kind,
				channel: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	if (report.overall === "healthy") {
		if (previous?.alertOpen) {
			const downtimeMinutes = previous.firstUnhealthyAt
				? Math.max(0, Math.round((now.getTime() - Date.parse(previous.firstUnhealthyAt)) / 60_000))
				: null;
			const result = await attempt(
				"recovery",
				`🟢 Dungeon Blitz host recovered: ${report.hostname}\n${
					downtimeMinutes === null ? "" : `Was unhealthy for ~${downtimeMinutes} min. `
				}${summarizeGameHealth(report)}`,
			);
			await persist({
				_id: report.hostname,
				alertOpen: !result.sent,
				firstUnhealthyAt: previous.firstUnhealthyAt,
				lastUnhealthyAt: previous.lastUnhealthyAt,
				lastHealthyAt: now.toISOString(),
				lastAlertAt: previous.lastAlertAt,
				lastReminderAt: previous.lastReminderAt,
				lastRecoveryAt: result.sent ? now.toISOString() : previous.lastRecoveryAt,
				lastSummary: "healthy",
			});
			return result;
		}
		await persist({
			_id: report.hostname,
			alertOpen: false,
			...(previous?.firstUnhealthyAt ? { firstUnhealthyAt: previous.firstUnhealthyAt } : {}),
			...(previous?.lastAlertAt ? { lastAlertAt: previous.lastAlertAt } : {}),
			lastHealthyAt: now.toISOString(),
			lastSummary: "healthy",
		});
		return { sent: false, kind: null, channel: null };
	}

	const firstUnhealthyAt = previous?.firstUnhealthyAt ?? now.toISOString();
	const summary = summarizeGameHealth(report);

	if (!previous?.alertOpen) {
		const result = await attempt("alert", `🔴 Dungeon Blitz host is DOWN: ${report.hostname}\n${summary}`);
		await persist({
			_id: report.hostname,
			alertOpen: result.sent,
			firstUnhealthyAt,
			lastUnhealthyAt: now.toISOString(),
			lastAlertAt: result.sent ? now.toISOString() : undefined,
			lastSummary: summary,
		});
		return result;
	}

	const lastContactAt = previous.lastReminderAt ?? previous.lastAlertAt;
	const reminderDue =
		!lastContactAt || now.getTime() - Date.parse(lastContactAt) >= reminderMinutes * 60_000;

	if (!reminderDue) {
		await persist({ ...previous, lastUnhealthyAt: now.toISOString(), lastSummary: summary });
		return { sent: false, kind: null, channel: null };
	}

	const outageMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(firstUnhealthyAt)) / 60_000));
	const result = await attempt(
		"reminder",
		`🔴 Still down (${outageMinutes} min): ${report.hostname}\n${summary}`,
	);
	await persist({
		...previous,
		lastUnhealthyAt: now.toISOString(),
		lastSummary: summary,
		...(result.sent ? { lastReminderAt: now.toISOString() } : {}),
	});
	return result;
}

let storePromise: Promise<GameHealthStateStore | null> | null = null;

/**
 * MongoDB-backed dedupe store, cached per serverless instance. Returns null
 * when Mongo is unavailable so alerting still happens (unduplicated) rather
 * than being silenced by a state-store outage.
 */
export function getGameHealthStateStore(env: NodeJS.ProcessEnv = process.env): Promise<GameHealthStateStore | null> {
	if (!storePromise) {
		storePromise = (async (): Promise<GameHealthStateStore | null> => {
			const uri = env.GAME_MONGODB_URI?.trim() || env.MONGODB_URI?.trim();
			if (!uri) return null;
			try {
				const client = new MongoClient(uri, { ignoreUndefined: true });
				const db = client.db(
					env.GAME_HEALTH_MONGODB_DB_NAME?.trim() ||
						env.GAME_MONGODB_DB_NAME?.trim() ||
						env.MONGODB_DB_NAME?.trim() ||
						"minidb",
				);
				const collection = db.collection<GameHealthStateRecord>(
					env.GAME_HEALTH_STATE_COLLECTION?.trim() || "game_health_state",
				);
				return {
					async findOne(query) {
						return (await collection.findOne(query)) as GameHealthStateRecord | null;
					},
					async upsert(record) {
						await collection.updateOne({ _id: record._id }, { $set: record }, { upsert: true });
					},
				};
			} catch {
				return null;
			}
		})();
	}
	return storePromise;
}
