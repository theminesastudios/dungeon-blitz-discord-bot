import assert from "node:assert/strict";
import { createVerify, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
	buildIssueBody,
	createBugReportIssue,
	getAppConfig,
	getIssueRepo,
	getReportCooldownMs,
	normalizeIssueTitle,
	normalizePrivateKey,
	__resetInstallationTokenCache,
	type IssueFailureReason,
} from "../src/utils/githubIssues.js";
import {
	describeFailure,
	formatCooldownRemaining,
	validateReportInput,
} from "../src/commands/report-bug.js";

/* ------------------------------------------------------------------
 * normalizeIssueTitle
 * ------------------------------------------------------------------ */

assert.equal(normalizeIssueTitle("  Quest  crashes  on load "), "[Discord] Quest crashes on load");
// Collapsing whitespace keeps a title from eating its budget on stray newlines.
assert.equal(normalizeIssueTitle("a\n\nb\tc"), "[Discord] a b c");
// An empty title cannot reach here (validation demands 4+ characters), but the
// defensive fallback still has to yield a valid, clearly-sourced title.
assert.equal(normalizeIssueTitle("   "), "[Discord]");

// GitHub rejects titles over 256 characters; the prefix is part of that budget.
const longTitle = "x".repeat(400);
const capped = normalizeIssueTitle(longTitle);
assert.ok(capped.length <= 128, `title must stay short, got ${capped.length}`);
assert.ok(capped.startsWith("[Discord] "));

/* ------------------------------------------------------------------
 * buildIssueBody
 * ------------------------------------------------------------------ */

const body = buildIssueBody({
	reporterId: "1234567890",
	reporterUsername: "hansklein",
	guildName: "The Minesa Studios",
	guildId: "9876543210",
	description: "The quest log does not load.",
	steps: "1. Open the quest log\n2. Observe",
	submittedAt: new Date("2026-09-26T14:03:11.000Z"),
});

assert.ok(body.includes("hansklein"), "reporter username is recorded");
assert.ok(body.includes("1234567890"), "reporter id is recorded");
assert.ok(body.includes("The Minesa Studios"), "guild name is recorded");
assert.ok(body.includes("9876543210"), "guild id is recorded");
assert.ok(body.includes("2026-09-26T14:03:11.000Z"), "timestamp is recorded");
assert.ok(body.includes("The quest log does not load."), "description is carried through");

// Free text is fenced, so a player cannot inject an @everyone ping or a tracking link
// into a ticket that staff read.
assert.ok(body.includes("```\nThe quest log does not load.\n```"), "description is fenced");
assert.ok(body.includes("## Steps to reproduce"), "steps section is present");

// A report with no steps still reads as a complete ticket.
const noSteps = buildIssueBody({
	reporterId: "1234567890",
	reporterUsername: null,
	guildName: null,
	guildId: "9876543210",
	description: "Something broke.",
	steps: "   ",
	submittedAt: new Date("2026-09-26T14:03:11.000Z"),
});
assert.ok(noSteps.includes("Not provided."), "missing steps get an explicit placeholder");
assert.ok(noSteps.includes("9876543210"), "guild id still recorded without a name");
assert.ok(!noSteps.includes("Unknown (direct message)"), "a guild report is not labelled a DM");

// Fencing actually neutralises a mention: the ping is inside a code fence, so GitHub
// will not render it as a mention.
const injection = buildIssueBody({
	reporterId: "1",
	reporterUsername: null,
	guildName: "G",
	guildId: "2",
	description: "@everyone please read this",
	steps: "",
	submittedAt: new Date("2026-09-26T14:03:11.000Z"),
});
const descriptionSection = injection.slice(injection.indexOf("## Description"));
assert.ok(
	descriptionSection.indexOf("```") < descriptionSection.indexOf("@everyone"),
	"the fence opens before any mention in the description",
);

/* ------------------------------------------------------------------
 * validateReportInput
 * ------------------------------------------------------------------ */

assert.equal(validateReportInput({ title: "Real title", description: "Long enough detail." }), null);
assert.match(validateReportInput({ title: "ab", description: "Long enough detail." }) ?? "", /title/i);
assert.match(validateReportInput({ title: "Real title", description: "short" }) ?? "", /describe/i);
// Whitespace does not count toward the minimums.
assert.match(validateReportInput({ title: "    ", description: "Long enough detail." }) ?? "", /title/i);
assert.match(validateReportInput({ title: "Real title", description: "          " }) ?? "", /describe/i);

/* ------------------------------------------------------------------
 * formatCooldownRemaining
 * ------------------------------------------------------------------ */

assert.equal(formatCooldownRemaining(60_000), "1 minute");
// Always at least one minute, so a cooldown never reads as "0 minutes left".
assert.equal(formatCooldownRemaining(1), "1 minute");
assert.equal(formatCooldownRemaining(0), "1 minute");
assert.equal(formatCooldownRemaining(120_000), "2 minutes");
assert.equal(formatCooldownRemaining(3_600_000), "1 hour");
assert.equal(formatCooldownRemaining(3_900_000), "1 hour 5 minutes");
assert.equal(formatCooldownRemaining(4_200_000), "1 hour 10 minutes");
assert.equal(formatCooldownRemaining(7_200_000), "2 hours");

/* ------------------------------------------------------------------
 * describeFailure
 * ------------------------------------------------------------------ */

const reasons: IssueFailureReason[] = [
	"not-configured",
	"unauthorized",
	"forbidden",
	"not-found",
	"rate-limited",
	"invalid",
	"unavailable",
];

const seen = new Set<string>();
for (const reason of reasons) {
	const message = describeFailure(reason);
	assert.ok(message.length > 0, `${reason} must have a message`);
	// Players must never be shown the tracker name, a token, or a raw GitHub payload.
	assert.ok(!message.includes("private-dungeon-blitz-r"), `${reason} leaks the repo name`);
	assert.ok(!/github|token|http/i.test(message), `${reason} leaks internals`);
	seen.add(message);
}
// Different causes should not all collapse into one identical apology.
assert.ok(seen.size >= 3, `expected distinct messages, got ${seen.size}`);

/* ------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------ */

const repo = getIssueRepo();
assert.equal(repo.owner, "theminesastudios");
assert.equal(repo.repo, "private-dungeon-blitz-r");
assert.equal(getReportCooldownMs(), 60 * 60 * 1000, "one report per hour by default");

// A malformed cooldown must not silently disable the only guard on the tracker.
process.env.BUG_REPORT_COOLDOWN_MS = "not-a-number";
assert.equal(getReportCooldownMs(), 60 * 60 * 1000, "garbage falls back to the default");
process.env.BUG_REPORT_COOLDOWN_MS = "-5";
assert.equal(getReportCooldownMs(), 60 * 60 * 1000, "a negative cooldown falls back");
process.env.BUG_REPORT_COOLDOWN_MS = "0";
assert.equal(getReportCooldownMs(), 0, "zero is honoured, so the guard can be lifted deliberately");
delete process.env.BUG_REPORT_COOLDOWN_MS;

/* ------------------------------------------------------------------
 * GitHub App authentication
 *
 * The app signs a short-lived JWT that is exchanged for an installation
 * token; the key itself never calls the API. These cover the two things
 * that actually break in production — a PEM mangled by the environment,
 * and minting a fresh token on every single report.
 * ------------------------------------------------------------------ */

const PEM = "-----BEGIN PRIVATE KEY-----\nline-one\nline-two\n-----END PRIVATE KEY-----\n";

// A PEM pasted into a single-line env var arrives with literal backslash-n.
assert.equal(
	normalizePrivateKey(PEM.replace(/\n/g, "\\n")),
	PEM,
	"escaped newlines are restored",
);
// Some shells leave the wrapping quotes behind; node:crypto then rejects the key.
assert.equal(normalizePrivateKey(`"${PEM}"`), PEM, "wrapping quotes are stripped");
assert.equal(normalizePrivateKey(PEM), PEM, "a real PEM is left alone");

const originalEnv = { ...process.env };
function clearAppEnv() {
	delete process.env.GITHUB_APP_ID;
	delete process.env.GITHUB_APP_INSTALLATION_ID;
	delete process.env.GITHUB_APP_PRIVATE_KEY;
	__resetInstallationTokenCache();
}

const realFetch = globalThis.fetch;

function stubGitHub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init ?? {});
	}) as typeof fetch;
	return calls;
}

// No app configured must be reported as a setup problem, not attempted.
clearAppEnv();
assert.equal(getAppConfig().appId, null, "app id is unset");
assert.equal(getAppConfig().installationId, null, "installation id is unset");
assert.equal(getAppConfig().privateKey, null, "private key is unset");

{
	const calls = stubGitHub(() => new Response("{}"));
	const result = await createBugReportIssue({ title: "[Discord] t", body: "b" });
	assert.equal(result.ok, false, "an unconfigured app cannot file a report");
	assert.equal(result.ok === false && result.reason, "not-configured");
	assert.equal(calls.length, 0, "no request is attempted without credentials");
	globalThis.fetch = realFetch;
}

// A private key that is not a usable PEM fails loudly, not silently.
{
	process.env.GITHUB_APP_ID = "1";
	process.env.GITHUB_APP_INSTALLATION_ID = "2";
	process.env.GITHUB_APP_PRIVATE_KEY = "not-a-key";
	__resetInstallationTokenCache();
	stubGitHub(() => new Response("{}"));
	const result = await createBugReportIssue({ title: "[Discord] t", body: "b" });
	assert.equal(result.ok, false, "a malformed key cannot file a report");
	assert.equal(result.ok === false && result.reason, "not-configured");
	globalThis.fetch = realFetch;
	clearAppEnv();
}

// The full chain: a real RSA key, a verifiable JWT, a cached installation token.
{
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});

	process.env.GITHUB_APP_ID = "123456";
	process.env.GITHUB_APP_INSTALLATION_ID = "999888";
	// Exactly how a PEM arrives from a dashboard field: one line, escaped newlines.
	process.env.GITHUB_APP_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
	__resetInstallationTokenCache();

	let seenJwt: string | null = null;
	const calls = stubGitHub((url, init) => {
		if (url.includes("/access_tokens")) {
			seenJwt = String((init.headers as Record<string, string>).Authorization).replace(
				"Bearer ",
				"",
			);
			return new Response(
				JSON.stringify({
					token: "ghs_installation_token",
					expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				}),
				{ status: 201 },
			);
		}
		return new Response(JSON.stringify({ number: 5, html_url: "https://example/5" }), {
			status: 201,
		});
	});

	const first = await createBugReportIssue({ title: "[Discord] t", body: "b" });
	assert.equal(first.ok, true, "a configured app files the report");
	assert.equal(first.ok === true && first.number, 5);

	// The JWT is a genuine RS256 token identifying the app.
	assert.ok(seenJwt, "an app JWT was sent to the token endpoint");
	const [header, payload, signature] = String(seenJwt).split(".");
	assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
		alg: "RS256",
		typ: "JWT",
	});
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
	assert.equal(claims.iss, "123456", "the JWT is issued by the app id");
	// GitHub rejects an exp more than 10 minutes out.
	assert.ok(claims.exp - claims.iat <= 600, "the JWT lifetime is within GitHub's limit");
	assert.ok(
		claims.iat <= Math.floor(Date.now() / 1000) + 1,
		"the JWT is not issued in the future",
	);
	assert.equal(
		createVerify("RSA-SHA256")
			.update(`${header}.${payload}`)
			.verify(createPublicKey(publicKey), Buffer.from(signature, "base64url")),
		true,
		"the JWT signature verifies against the app's public key",
	);

	// The issue itself is called with the installation token, never the JWT.
	const issueCall = calls.find((call) => call.url.includes("/issues"));
	assert.ok(issueCall, "the issue was POSTed");
	assert.equal(
		(issueCall!.init?.headers as Record<string, string>).Authorization,
		"Bearer ghs_installation_token",
		"the private key never leaves the process",
	);

	// A second report reuses the cached installation token.
	await createBugReportIssue({ title: "[Discord] t2", body: "b" });
	assert.equal(
		calls.filter((call) => call.url.includes("/access_tokens")).length,
		1,
		"the installation token is minted once and reused",
	);

	globalThis.fetch = realFetch;
	clearAppEnv();
}

// Failures are never cached, so fixing the app and retrying works immediately.
{
	process.env.GITHUB_APP_ID = "1";
	process.env.GITHUB_APP_INSTALLATION_ID = "2";
	process.env.GITHUB_APP_PRIVATE_KEY = "not-a-key";
	__resetInstallationTokenCache();
	const calls = stubGitHub(() => new Response("{}"));
	await createBugReportIssue({ title: "[Discord] t", body: "b" });
	await createBugReportIssue({ title: "[Discord] t", body: "b" });
	assert.equal(calls.length, 0, "a bad key is retried rather than cached as a failure");
	globalThis.fetch = realFetch;
	clearAppEnv();
}

process.env = originalEnv;
