import { createSign } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import { errorMessage, logError, logWarn } from "./logger.js";

/**
 * Bug reports filed from Discord into the private issue tracker.
 *
 * Authentication is a GitHub App, not a personal token: the app belongs to the
 * studio rather than to whoever set it up, so it survives staff turnover and
 * nothing expires on a calendar. Its private key only ever signs a short-lived
 * JWT, which is exchanged for an installation access token scoped to the one
 * repository — the same reason the sponsor/contributor `GITHUB_TOKEN` is kept
 * separate, so neither credential can do the other's job.
 */

const DEFAULT_REPO_OWNER = "theminesastudios";
const DEFAULT_REPO_NAME = "private-dungeon-blitz-r";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_URL = "https://api.github.com";

/** Label applied to reports, so Discord filings are filterable. */
const REPORT_LABEL = "from-discord";

/** Well inside an interaction's budget: a stalled GitHub must surface as an error, not a hang. */
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

/** GitHub caps an app JWT at 10 minutes; stay well inside that. */
const APP_JWT_TTL_SECONDS = 540;

/** Backdate the JWT to absorb clock skew between here and GitHub. */
const APP_JWT_CLOCK_SKEW_SECONDS = 60;

/** Installation tokens last an hour; renew this far ahead so a request never races expiry. */
const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 60_000;

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/** How many past reports to keep per player as a triage breadcrumb. */
const REPORT_HISTORY_LIMIT = 10;

/** Mirrors the driver's own timeouts: a dead database must fail fast. */
const MONGO_SERVER_SELECTION_TIMEOUT_MS = 5_000;
const MONGO_SOCKET_TIMEOUT_MS = 8_000;

export type IssueFailureReason =
	| "not-configured"
	| "unauthorized"
	| "forbidden"
	| "not-found"
	| "rate-limited"
	| "invalid"
	| "unavailable";

export type CreateIssueResult =
	| { ok: true; number: number; url: string }
	| { ok: false; reason: IssueFailureReason; detail: string };

/* ------------------------------------------------------------------
 * GitHub App authentication
 *
 * The app's private key signs a short-lived JWT, which GitHub exchanges for an
 * installation access token. That token — not the key — is what actually calls
 * the API, and it is cached until shortly before it expires so a busy minute
 * does not mint one token per bug report.
 * ------------------------------------------------------------------ */

export type AppAuthResult =
	| { ok: true; token: string }
	| { ok: false; reason: IssueFailureReason; detail: string };

export function getAppConfig(): {
	appId: string | null;
	installationId: string | null;
	privateKey: string | null;
} {
	const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	return {
		appId: process.env.GITHUB_APP_ID?.trim() || null,
		installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim() || null,
		// A PEM in a single-line env var keeps its newlines as literal "\n", and shells
		// that wrap values in quotes leave the quotes behind. Undo both, or node:crypto
		// rejects the key and every report fails with an opaque "Invalid key data".
		privateKey: rawKey ? normalizePrivateKey(rawKey) : null,
	};
}

export function normalizePrivateKey(raw: string): string {
	const unquoted = raw.replace(/^["']|["']$/g, "");
	return unquoted.includes("\\n") ? unquoted.replace(/\\n/g, "\n") : unquoted;
}

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/** RS256 JWT identifying the app itself, which is what mints installation tokens. */
function createAppJwt(config: { appId: string; privateKey: string }): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			iat: now - APP_JWT_CLOCK_SKEW_SECONDS,
			exp: now + APP_JWT_TTL_SECONDS,
			iss: config.appId,
		}),
	);
	const signature = createSign("RSA-SHA256")
		.update(`${header}.${payload}`)
		.sign(config.privateKey, "base64url");
	return `${header}.${payload}.${signature}`;
}

type CachedInstallationToken = { token: string; expiresAtMs: number };

let cachedInstallationToken: CachedInstallationToken | null = null;
/** Held while a token is being minted, so a burst of reports mints one, not one each. */
let installationTokenPromise: Promise<AppAuthResult> | null = null;

/** Exposed for tests; production callers go through `getInstallationToken`. */
export function __resetInstallationTokenCache() {
	cachedInstallationToken = null;
	installationTokenPromise = null;
}

async function requestInstallationToken(): Promise<AppAuthResult> {
	const { appId, installationId, privateKey } = getAppConfig();
	if (!appId || !installationId || !privateKey) {
		return {
			ok: false,
			reason: "not-configured",
			detail:
				"GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY must all be set.",
		};
	}

	let jwt: string;
	try {
		jwt = createAppJwt({ appId, privateKey });
	} catch (error) {
		return {
			ok: false,
			reason: "not-configured",
			detail: `GITHUB_APP_PRIVATE_KEY is not a usable PEM key: ${errorMessage(error)}`,
		};
	}

	let response: Response;
	try {
		response = await fetch(
			`${GITHUB_API_URL}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
				},
				signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
			},
		);
	} catch (error) {
		return { ok: false, reason: "unavailable", detail: errorMessage(error) };
	}

	const text = await response.text();

	if (!response.ok) {
		let detail = text;
		try {
			const parsed = JSON.parse(text) as GitHubIssueResponse;
			if (parsed.message) detail = parsed.message;
		} catch {
			// Non-JSON body; the raw text is the best available detail.
		}
		// A 404 here almost always means the app is not installed on the repository,
		// or the installation id is stale after a reinstall.
		return { ok: false, reason: reasonForStatus(response.status, detail), detail };
	}

	let parsed: { token?: string; expires_at?: string };
	try {
		parsed = JSON.parse(text) as { token?: string; expires_at?: string };
	} catch {
		return { ok: false, reason: "unavailable", detail: "GitHub returned a non-JSON response." };
	}
	if (!parsed.token) {
		return { ok: false, reason: "unavailable", detail: "GitHub returned no installation token." };
	}

	const expiresAtMs = parsed.expires_at ? Date.parse(parsed.expires_at) : Date.now() + 50 * 60_000;
	cachedInstallationToken = {
		token: parsed.token,
		expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 50 * 60_000,
	};
	return { ok: true, token: parsed.token };
}

/**
 * An installation token valid for the next API call, minted only when there is no
 * live one cached. Failures are never cached, so fixing the app and retrying works
 * immediately instead of waiting out a cooldown.
 */
export async function getInstallationToken(): Promise<AppAuthResult> {
	const cached = cachedInstallationToken;
	if (cached && cached.expiresAtMs - INSTALLATION_TOKEN_REFRESH_MARGIN_MS > Date.now()) {
		return { ok: true, token: cached.token };
	}
	if (installationTokenPromise) return installationTokenPromise;

	installationTokenPromise = requestInstallationToken().finally(() => {
		installationTokenPromise = null;
	});
	return installationTokenPromise;
}

export function getIssueRepo(): { owner: string; repo: string } {
	return {
		owner: process.env.GITHUB_ISSUES_REPO_OWNER?.trim() || DEFAULT_REPO_OWNER,
		repo: process.env.GITHUB_ISSUES_REPO_NAME?.trim() || DEFAULT_REPO_NAME,
	};
}

export function getReportCooldownMs(): number {
	const raw = process.env.BUG_REPORT_COOLDOWN_MS?.trim();
	if (!raw) return DEFAULT_COOLDOWN_MS;
	const parsed = Number(raw);
	// A malformed or negative value falls back rather than disabling the guard,
	// which would silently remove the only thing standing between the tracker and spam.
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS;
}

function issuesUrl(owner: string, repo: string): string {
	return `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

/** Total issue-title budget, prefix included. GitHub's own cap is 256. */
const MAX_TITLE_LENGTH = 120;
const TITLE_PREFIX = "[Discord] ";

export function normalizeIssueTitle(raw: string): string {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (!collapsed) return TITLE_PREFIX.trim();
	// The prefix is part of the budget, not something added on top of it.
	const capped = collapsed
		.slice(0, Math.max(0, MAX_TITLE_LENGTH - TITLE_PREFIX.length))
		.trim();
	return `${TITLE_PREFIX}${capped}`;
}

/**
 * Renders the issue body. Both free-text fields are fenced so a player cannot inject
 * `@everyone`/`@here` pings or tracking links into a ticket that staff read — the
 * tracker is private, but it is still a shared surface.
 */
export function buildIssueBody(input: {
	reporterId: string;
	reporterUsername: string | null;
	guildName: string | null;
	guildId: string | null;
	description: string;
	steps: string;
	submittedAt: Date;
}): string {
	// The mention already carries the snowflake, so the id is not repeated as text.
	const reporter = input.reporterId
		? input.reporterUsername
			? `<@${input.reporterId}> (\`${input.reporterUsername}\`)`
			: `<@${input.reporterId}>`
		: (input.reporterUsername ?? "Unknown");
	const server =
		input.guildName && input.guildId
			? `${input.guildName} (\`${input.guildId}\`)`
			: input.guildId
				? `\`${input.guildId}\``
				: "Unknown (direct message)";

	const steps = input.steps.trim() || "Not provided.";

	return [
		"## Reported in Discord",
		`- **Reporter:** ${reporter}`,
		`- **Server:** ${server}`,
		`- **Submitted:** ${input.submittedAt.toISOString()}`,
		"",
		"## Description",
		"```",
		input.description.trim(),
		"```",
		"",
		"## Steps to reproduce",
		"```",
		steps,
		"```",
		"",
	].join("\n");
}

type GitHubIssueResponse = {
	number?: number;
	html_url?: string;
	message?: string;
};

/** Maps an HTTP status onto the failure the command turns into a player-facing message. */
function reasonForStatus(status: number, body: string): IssueFailureReason {
	const lowered = body.toLowerCase();
	// GitHub answers a throttled request with 403, so the message decides which it was.
	if (lowered.includes("rate limit") || lowered.includes("abuse detection")) {
		return "rate-limited";
	}
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not-found";
	if (status === 422) return "invalid";
	return "unavailable";
}

async function postIssue(
	token: string,
	owner: string,
	repo: string,
	payload: { title: string; body: string; labels?: string[] },
): Promise<CreateIssueResult> {
	const response = await fetch(issuesUrl(owner, repo), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
		body: JSON.stringify(payload),
	});

	const text = await response.text();

	if (!response.ok) {
		let detail = text;
		try {
			const parsed = JSON.parse(text) as GitHubIssueResponse;
			if (parsed.message) detail = parsed.message;
		} catch {
			// GitHub returned something that is not JSON; the raw text is the best detail.
		}
		return { ok: false, reason: reasonForStatus(response.status, detail), detail };
	}

	let parsed: GitHubIssueResponse;
	try {
		parsed = JSON.parse(text) as GitHubIssueResponse;
	} catch {
		return { ok: false, reason: "unavailable", detail: "GitHub returned a non-JSON response." };
	}
	if (typeof parsed.number !== "number") {
		return { ok: false, reason: "unavailable", detail: "GitHub returned no issue number." };
	}

	return { ok: true, number: parsed.number, url: parsed.html_url ?? "" };
}

/**
 * Files one issue. An unknown label makes GitHub reject the whole request with 422, so
 * a rejection that names the label is retried once without labels — that keeps this
 * working on a fresh tracker with no manual setup.
 */
export async function createBugReportIssue(input: {
	title: string;
	body: string;
}): Promise<CreateIssueResult> {
	const auth = await getInstallationToken();
	if (!auth.ok) return auth;

	const { owner, repo } = getIssueRepo();

	let result: CreateIssueResult;
	try {
		result = await postIssue(auth.token, owner, repo, {
			title: input.title,
			body: input.body,
			labels: [REPORT_LABEL],
		});
	} catch (error) {
		return { ok: false, reason: "unavailable", detail: errorMessage(error) };
	}

	if (result.ok || result.reason !== "invalid") return result;
	if (!result.detail.toLowerCase().includes(REPORT_LABEL)) return result;

	logWarn("githubIssues", `Label "${REPORT_LABEL}" rejected; filing without it`, {
		repo: `${owner}/${repo}`,
		detail: result.detail,
	});
	// The installation token is spent either way, but it outlives this retry by
	// nearly an hour, so a second copy is not needed.
	try {
		return await postIssue(auth.token, owner, repo, { title: input.title, body: input.body });
	} catch (error) {
		return { ok: false, reason: "unavailable", detail: errorMessage(error) };
	}
}

/* ------------------------------------------------------------------
 * Per-player cooldown
 *
 * Every guild member can file, so the tracker needs a guard against a member
 * mashing the button. Failures here are logged and swallowed: a cooldown
 * store outage must degrade to "no cooldown", never to a broken command.
 * ------------------------------------------------------------------ */

/** A type alias rather than an `interface`: only aliases get the implicit index
 * signature `Collection<T>` requires, and an explicit `extends Document` would clash
 * with the `$push` operator's own field typing. */
type BugReportEntry = {
	number: number;
	url: string;
	title: string;
	atMs: number;
};

type RawBugReportDocument = {
	_id: string;
	lastReportAtMs?: number;
	reports?: BugReportEntry[];
};

let clientPromise: Promise<MongoClient> | null = null;

async function getClient(): Promise<MongoClient> {
	if (clientPromise) return clientPromise;
	const uri = process.env.GAME_MONGODB_URI?.trim() || process.env.MONGODB_URI?.trim();
	if (!uri) throw new Error("GAME_MONGODB_URI or MONGODB_URI is required");

	clientPromise = (async () => {
		const client = new MongoClient(uri, {
			ignoreUndefined: true,
			serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
			connectTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
			socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
		});
		await client.connect();
		return client;
	})().catch((error) => {
		clientPromise = null;
		throw error;
	});
	return clientPromise;
}

async function getReportsCollection(): Promise<Collection<RawBugReportDocument>> {
	const client = await getClient();
	return client
		.db(process.env.PROFILE_MONGODB_DB_NAME?.trim() || "minidb")
		.collection<RawBugReportDocument>("bugReports");
}

/**
 * Milliseconds left before this player may file again, or 0 when they may.
 * A store failure returns 0: reporting is more valuable than the guard.
 */
export async function getReportCooldownRemainingMs(discordId: string): Promise<number> {
	const normalized = discordId.trim();
	if (!normalized) return 0;

	try {
		const reports = await getReportsCollection();
		const document = await reports.findOne(
			{ _id: normalized },
			{ projection: { lastReportAtMs: 1 } },
		);
		const lastReportAtMs = Number(document?.lastReportAtMs ?? 0);
		if (!Number.isFinite(lastReportAtMs) || lastReportAtMs <= 0) return 0;

		const elapsed = Date.now() - lastReportAtMs;
		const remaining = getReportCooldownMs() - elapsed;
		return remaining > 0 ? remaining : 0;
	} catch (error) {
		logError("githubIssues", "Cooldown lookup failed; allowing the report", {
			discordId: normalized,
			error: errorMessage(error),
		});
		return 0;
	}
}

/** Stamps the cooldown and keeps a short history of what this player filed. */
export async function recordBugReport(
	discordId: string,
	report: { number: number; url: string; title: string },
): Promise<void> {
	const normalized = discordId.trim();
	if (!normalized) return;

	const atMs = Date.now();
	try {
		const reports = await getReportsCollection();
		await reports.updateOne(
			{ _id: normalized },
			{
				$set: { lastReportAtMs: atMs },
				$push: {
					reports: { $each: [{ ...report, atMs }], $slice: -REPORT_HISTORY_LIMIT },
				},
			},
			{ upsert: true },
		);
	} catch (error) {
		// The issue is already filed, so a bookkeeping failure is not worth surfacing
		// to the player; it only means their next report is not rate-limited.
		logError("githubIssues", "Failed to record bug report", {
			discordId: normalized,
			error: errorMessage(error),
		});
	}
}
