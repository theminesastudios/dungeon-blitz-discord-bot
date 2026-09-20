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
import * as tls from "node:tls";
import { MongoClient } from "mongodb";

const DEFAULT_HOSTNAME = "dungeonblitzr.theminesa.studio";
// The address the VM actually answers from — the GCP reserved external IP
// (dungeon-blitz-eu-ip) attached to the dungeon-blitz-eu instance. Override
// with GAME_HEALTH_EXPECTED_IP when the VM moves. 35.185.71.109 is a reserved
// but idle address in the same project; it is never the right answer, and the
// stale default here made every check read as a DNS mismatch (2026-09-20).
const DEFAULT_EXPECTED_IP = "35.241.250.170";
const DEFAULT_PAGE_PATH = "/api/auth/discord/config";
const DEFAULT_REMINDER_MINUTES = 60;
const CONNECT_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 5_000;
const POLICY_TIMEOUT_MS = 4_000;
const POLICY_REQUEST = "<policy-file-request/>\0";
const TLS_TIMEOUT_MS = 5_000;
// Warn this many days before the TLS certificate expires (Caddy renews
// automatically; the warning is for when that silently stops happening).
const DEFAULT_CERT_WARN_DAYS = 14;

export type GameHealthDnsStatus = "ok" | "nxdomain" | "mismatch" | "error";
export type GameHealthSocketStatus = "ok" | "refused" | "timeout" | "error";
export type GameHealthTlsStatus = "ok" | "expiring" | "expired" | "error";
export type GameHealthOverall = "healthy" | "degraded" | "down";

/** What the TLS inspector itself observed before the warn-window classification. */
export type GameHealthTlsProbe = {
	status: "ok" | "error";
	daysRemaining?: number;
	expiresAt?: string;
	issuer?: string;
	error?: string;
};

export type GameHealthReport = {
	checkedAt: string;
	hostname: string;
	expectedIp: string;
	dns: { status: GameHealthDnsStatus; resolvedIps: string[]; error?: string };
	page: { status: "ok" | "error"; httpStatus?: number; error?: string };
	https: { status: "ok" | "error"; httpStatus?: number; error?: string };
	tls: {
		status: GameHealthTlsStatus;
		daysRemaining?: number;
		expiresAt?: string;
		issuer?: string;
		error?: string;
	};
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
	// Certificate-expiry warning lifecycle, tracked separately from the
	// up/down alert so an expiring cert warns once and a renewal confirms once
	// without touching the outage alert machinery.
	certWarningOpen?: boolean;
	lastCertWarningAt?: string;
};

export type GameHealthStateStore = {
	findOne(query: { _id: string }): Promise<GameHealthStateRecord | null>;
	upsert(record: GameHealthStateRecord): Promise<void>;
};

export type GameHealthAlertResult = {
	sent: boolean;
	kind: "alert" | "reminder" | "recovery" | "warning" | null;
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
	/** Distinct from fetchPage so a test can simulate "https down, http up". */
	fetchHttpsPage?: (url: string) => Promise<{ status: number }>;
	/** Injected in tests; the default opens a real TLS connection to :443. */
	inspectTls?: (hostname: string) => Promise<GameHealthTlsProbe>;
	/** Warn when the certificate has this many days (or fewer) left. */
	certWarnDays?: number;
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
 * Opens a real TLS session to :443 and reads the served certificate.
 * Verification is left on, so a wrong/self-signed/MITM'd certificate reads as
 * an error rather than silently passing; an expired certificate surfaces the
 * verification error, which the caller classifies as "expired". Caddy fronts
 * 443 since 2026-09-20, so this is what catches a dead Caddy, a closed 443, or
 * a certificate nobody renewed.
 */
async function defaultInspectTls(hostname: string): Promise<GameHealthTlsProbe> {
	return await new Promise<GameHealthTlsProbe>((resolve) => {
		const socket = tls.connect({
			host: hostname,
			port: 443,
			servername: hostname,
			rejectUnauthorized: true,
		});
		let settled = false;
		const finish = (probe: GameHealthTlsProbe) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(probe);
		};
		socket.setTimeout(TLS_TIMEOUT_MS, () => finish({ status: "error", error: "timeout" }));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			finish({ status: "error", error: error.code || error.message || String(error) });
		});
		socket.on("secureConnect", () => {
			const cert = socket.getPeerCertificate();
			const rawExpiry = cert?.valid_to;
			if (!rawExpiry) {
				finish({ status: "error", error: "no peer certificate presented" });
				return;
			}
			const expiresAtMs = Date.parse(rawExpiry);
			if (!Number.isFinite(expiresAtMs)) {
				finish({ status: "error", error: `unparseable certificate expiry: ${rawExpiry}` });
				return;
			}
			const rawIssuer =
				typeof cert.issuer === "object" && cert.issuer ? cert.issuer.O : cert.issuer;
			const issuer = Array.isArray(rawIssuer)
				? rawIssuer.join(", ")
				: typeof rawIssuer === "string"
					? rawIssuer
					: undefined;
			finish({
				status: "ok",
				daysRemaining: Math.floor((expiresAtMs - Date.now()) / 86_400_000),
				expiresAt: new Date(expiresAtMs).toISOString(),
				...(issuer ? { issuer } : {}),
			});
		});
	});
}

/**
 * DNS must resolve (and still point at the VM), the site must answer over HTTP,
 * the site must also answer over HTTPS (Caddy on 443 — browsers auto-upgrade
 * and players land there first), and both game sockets must respond. Any DNS or
 * HTTP page failure is "down"; an HTTPS, TLS, or socket failure with the site
 * otherwise up is "degraded" (some or all players cannot get in, but the
 * deployment is reachable and worth a different diagnosis).
 */
export async function checkGameHealth(options: GameHealthCheckOptions = {}): Promise<GameHealthReport> {
	const hostname = options.hostname?.trim() || DEFAULT_HOSTNAME;
	const expectedIp = options.expectedIp?.trim() || DEFAULT_EXPECTED_IP;
	const pagePath = options.pagePath?.trim() || DEFAULT_PAGE_PATH;
	const resolve4 = options.resolve4 ?? defaultResolve4();
	const fetchPage = options.fetchPage ?? defaultFetchPage;
	const fetchHttpsPage = options.fetchHttpsPage ?? defaultFetchPage;
	const inspectTls = options.inspectTls ?? defaultInspectTls;
	const certWarnDays = options.certWarnDays ?? DEFAULT_CERT_WARN_DAYS;
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

	const [socket843, socket8080, httpsPage, tlsProbe] = await Promise.all([
		connectSocket(843).catch((error: unknown): SocketProbe => ({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		})),
		connectSocket(8080).catch((error: unknown): SocketProbe => ({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		})),
		(async (): Promise<{ status: "ok" | "error"; httpStatus?: number; error?: string }> => {
			try {
				const page = await fetchHttpsPage(`https://${hostname}${pagePath}`);
				return {
					status: page.status >= 200 && page.status < 400 ? ("ok" as const) : ("error" as const),
					httpStatus: page.status,
					...(page.status >= 200 && page.status < 400 ? {} : { error: "unexpected status" }),
				};
			} catch (error) {
				return {
					status: "error" as const,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		})(),
		inspectTls(hostname).catch((error: unknown): GameHealthTlsProbe => ({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		})),
	]);

	// Classify the certificate probe: a verification failure whose message names
	// expiry reads as "expired"; a valid chain inside the warn window reads as
	// "expiring"; everything else valid is "ok".
	let tlsStatus: GameHealthTlsStatus;
	if (tlsProbe.status === "error") {
		tlsStatus = /expired/i.test(tlsProbe.error ?? "") ? "expired" : "error";
	} else {
		tlsStatus =
			(tlsProbe.daysRemaining ?? Number.POSITIVE_INFINITY) <= certWarnDays ? "expiring" : "ok";
	}

	let overall: GameHealthOverall;
	if (dnsStatus !== "ok" || pageStatus !== "ok") overall = "down";
	else if (
		socket843.status !== "ok" ||
		socket8080.status !== "ok" ||
		httpsPage.status !== "ok" ||
		tlsStatus === "expired" ||
		tlsStatus === "error"
	)
		overall = "degraded";
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
		https: {
			status: httpsPage.status,
			...(httpsPage.httpStatus === undefined ? {} : { httpStatus: httpsPage.httpStatus }),
			...(httpsPage.error ? { error: httpsPage.error } : {}),
		},
		tls: {
			status: tlsStatus,
			...(tlsProbe.daysRemaining === undefined ? {} : { daysRemaining: tlsProbe.daysRemaining }),
			...(tlsProbe.expiresAt === undefined ? {} : { expiresAt: tlsProbe.expiresAt }),
			...(tlsProbe.issuer === undefined ? {} : { issuer: tlsProbe.issuer }),
			...(tlsProbe.error === undefined ? {} : { error: tlsProbe.error }),
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
	const httpsLine =
		report.https.status === "ok"
			? `HTTPS page: HTTP ${report.https.httpStatus}`
			: `HTTPS page: failed${report.https.httpStatus === undefined ? "" : ` (HTTP ${report.https.httpStatus})`}${report.https.error ? ` (${report.https.error})` : ""}`;
	const tlsLine =
		report.tls.status === "ok"
			? `TLS cert: valid, ${report.tls.daysRemaining} day(s) left (expires ${report.tls.expiresAt ?? "unknown"}${report.tls.issuer ? `, ${report.tls.issuer}` : ""})`
			: report.tls.status === "expiring"
				? `TLS cert: ⚠️ expires in ${report.tls.daysRemaining} day(s) (${report.tls.expiresAt ?? "unknown date"})`
				: report.tls.status === "expired"
					? "TLS cert: EXPIRED — browsers refuse the site"
					: `TLS cert: check failed (${report.tls.error ?? "unknown error"})`;
	const p843 =
		report.socket843.status === "ok"
			? `answering${report.socket843.answeredPolicy ? " (policy served)" : ""}`
			: report.socket843.status;
	return [
		dnsLine,
		pageLine,
		httpsLine,
		tlsLine,
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
				certWarningOpen: previous.certWarningOpen ?? false,
			});
			return result;
		}
		// Certificate-expiry warnings run here, in the healthy lane, because they
		// are maintenance warnings rather than outages: warn once when the cert
		// enters the warn window, confirm once once it is renewed, and never let
		// them interact with the up/down alert machinery.
		if (report.tls.status === "expiring" && !previous?.certWarningOpen) {
			const result = await attempt(
				"warning",
				`⚠️ Dungeon Blitz TLS certificate expires in ${report.tls.daysRemaining ?? "?"} day(s): ${report.hostname}\n(expires ${report.tls.expiresAt ?? "unknown date"}${report.tls.issuer ? `, issued by ${report.tls.issuer}` : ""})\nCaddy renews automatically; only act if the expiry date is not moving across checks.`,
			);
			await persist({
				_id: report.hostname,
				alertOpen: false,
				...(previous?.firstUnhealthyAt ? { firstUnhealthyAt: previous.firstUnhealthyAt } : {}),
				...(previous?.lastAlertAt ? { lastAlertAt: previous.lastAlertAt } : {}),
				lastHealthyAt: now.toISOString(),
				lastSummary: "healthy",
				certWarningOpen: result.sent,
				...(result.sent ? { lastCertWarningAt: now.toISOString() } : {}),
			});
			return result;
		}
		if (report.tls.status !== "expiring" && previous?.certWarningOpen) {
			const result = await attempt(
				"warning",
				`✅ Dungeon Blitz TLS certificate renewed: ${report.hostname}\n${summarizeGameHealth(report)}`,
			);
			await persist({
				_id: report.hostname,
				alertOpen: false,
				...(previous?.firstUnhealthyAt ? { firstUnhealthyAt: previous.firstUnhealthyAt } : {}),
				...(previous?.lastAlertAt ? { lastAlertAt: previous.lastAlertAt } : {}),
				lastHealthyAt: now.toISOString(),
				lastSummary: "healthy",
				certWarningOpen: false,
				lastCertWarningAt: previous.lastCertWarningAt,
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
			certWarningOpen: previous?.certWarningOpen ?? false,
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
			certWarningOpen: previous?.certWarningOpen ?? false,
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
