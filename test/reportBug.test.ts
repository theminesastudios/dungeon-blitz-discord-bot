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
	resolveUploadedAttachments,
	uploadsAllowed,
	validateReportInput,
} from "../src/commands/report-bug.js";
import type { APIAttachment } from "discord-api-types/v10";
import { interactionUsername } from "../src/utils/discordInteractions.js";

/* ------------------------------------------------------------------
 * normalizeIssueTitle
 * ------------------------------------------------------------------ */

// No source prefix: the `from-discord` label already records provenance, and a prefix
// would spend the title budget restating it.
assert.equal(normalizeIssueTitle("  Quest  crashes  on load "), "Quest crashes on load");
// Collapsing whitespace keeps a title from eating its budget on stray newlines.
assert.equal(normalizeIssueTitle("a\n\nb\tc"), "a b c");
assert.equal(normalizeIssueTitle("   "), "");

// GitHub rejects titles over 256 characters, so the cap is the whole budget.
const longTitle = "x".repeat(400);
const capped = normalizeIssueTitle(longTitle);
assert.equal(capped.length, 120, `title must stay short, got ${capped.length}`);

/* ------------------------------------------------------------------
 * buildIssueBody
 * ------------------------------------------------------------------ */

const body = buildIssueBody({
	reporterId: "1234567890",
	reporterUsername: "hansklein",
	description: "The quest log does not load.",
	steps: "1. Open the quest log\n2. Observe",
	attachments: [
		{ url: "https://cdn.discordapp.com/attachments/1/2/shot.png", filename: "shot.png", isImage: true },
	],
});

assert.ok(body.includes("hansklein"), "reporter username is recorded");
assert.ok(body.includes("1234567890"), "reporter id is recorded");
// Username then id in parentheses, which is how staff read a Discord identity.
assert.ok(body.includes("Reported by hansklein (1234567890)"), "reporter is name (id)");
assert.ok(body.includes("The quest log does not load."), "description is carried through");

// The guild and the timestamp were dropped: one issue lands in one tracker, and GitHub
// stamps its own open time.
assert.ok(!body.includes("Server"), "no server section");
assert.ok(!/Submitted|2026-09-26T/.test(body), "no submitted timestamp");

// Free text is fenced, so a player cannot inject an @everyone ping or a tracking link
// into a ticket that staff read.
assert.ok(body.includes("```\nThe quest log does not load.\n```"), "description is fenced");
assert.ok(body.includes("## Steps to reproduce"), "steps section is present");

// A screenshot renders inline so staff see it without clicking.
assert.ok(
	body.includes("![shot.png](<https://cdn.discordapp.com/attachments/1/2/shot.png>)"),
	"an image upload renders inline",
);

// A non-image (a log, a save) stays a plain link rather than a broken image.
const withFile = buildIssueBody({
	reporterId: "1",
	reporterUsername: null,
	description: "d",
	steps: "",
	attachments: [
		{ url: "https://cdn.discordapp.com/attachments/1/3/crash.log", filename: "crash.log", isImage: false },
	],
});
assert.ok(withFile.includes("- [crash.log](<https://cdn.discordapp.com/attachments/1/3/crash.log>)"), "a non-image is a bullet link");
assert.ok(!withFile.includes("![crash.log]"), "a non-image is not an image embed");

// Anything not HTTPS is dropped: a crafted value must not smuggle a javascript: or
// data: link into a ticket staff read.
const hostile = buildIssueBody({
	reporterId: "1",
	reporterUsername: null,
	description: "d",
	steps: "",
	attachments: [
		{ url: "javascript:alert(1)", filename: "x", isImage: true },
		{ url: "data:text/html,<script>", filename: "y", isImage: true },
		{ url: "https://cdn.discordapp.com/ok.png", filename: "ok.png", isImage: true },
	],
});
assert.ok(!hostile.includes("javascript:"), "a javascript: URL is dropped");
assert.ok(!hostile.includes("data:text/html"), "a data: URL is dropped");
assert.ok(hostile.includes("https://cdn.discordapp.com/ok.png"), "a valid attachment survives");

// A report with no steps still reads as a complete ticket.
const noSteps = buildIssueBody({
	reporterId: "1234567890",
	reporterUsername: null,
	description: "Something broke.",
	steps: "   ",
});
assert.ok(noSteps.includes("Not provided."), "missing steps get an explicit placeholder");
// A player with no resolvable username still has an id to go on.
assert.ok(noSteps.includes("Reported by 1234567890"), "id alone identifies the reporter");
assert.ok(!noSteps.includes("## Attachments"), "no attachments section when none were sent");

// Fencing actually neutralises a mention: the ping is inside a code fence, so GitHub
// will not render it as a mention.
const injection = buildIssueBody({
	reporterId: "1",
	reporterUsername: null,
	description: "@everyone please read this",
	steps: "",
});
const descriptionSection = injection.slice(injection.indexOf("## Description"));
assert.ok(
	descriptionSection.indexOf("```") < descriptionSection.indexOf("@everyone"),
	"the fence opens before any mention in the description",
);

/* ------------------------------------------------------------------
 * interactionUsername
 *
 * A guild interaction nests the user under `member` and omits the top-level
 * one. Reading `interaction.user` alone yields "", which does not throw — it
 * quietly files every report as a bare ID with no name on it.
 * ------------------------------------------------------------------ */

assert.equal(
	interactionUsername({ member: { user: { id: "1", username: "hansklein" } } }),
	"hansklein",
	"a guild interaction resolves the name from member.user",
);
assert.equal(
	interactionUsername({ user: { id: "1", username: "hansklein" } }),
	"hansklein",
	"a DM interaction resolves the name from user",
);
assert.equal(interactionUsername({}), "", "an unidentifiable interaction yields no name");
assert.equal(
	interactionUsername({ member: { user: { id: "1", username: "  " } } }),
	"",
	"a blank name is trimmed away rather than rendered as whitespace",
);

/* ------------------------------------------------------------------
 * uploadsAllowed
 * ------------------------------------------------------------------ */

const previousUploads = process.env.BUG_REPORT_ALLOW_UPLOADS;
delete process.env.BUG_REPORT_ALLOW_UPLOADS;
assert.equal(uploadsAllowed(), true, "uploads are on by default");
for (const off of ["false", "FALSE", "0", "no", "off", " false "]) {
	process.env.BUG_REPORT_ALLOW_UPLOADS = off;
	assert.equal(uploadsAllowed(), false, `${off} must turn uploads off`);
}
for (const on of ["true", "1", "yes", "on"]) {
	process.env.BUG_REPORT_ALLOW_UPLOADS = on;
	assert.equal(uploadsAllowed(), true, `${on} must keep uploads on`);
}
// The flag is a kill switch, not a filter: a value it does not recognise leaves the
// default in place rather than silently dropping the component.
process.env.BUG_REPORT_ALLOW_UPLOADS = "maybe";
assert.equal(uploadsAllowed(), true, "an unrecognised value keeps the default");
if (previousUploads === undefined) delete process.env.BUG_REPORT_ALLOW_UPLOADS;
else process.env.BUG_REPORT_ALLOW_UPLOADS = previousUploads;

/* ------------------------------------------------------------------
 * resolveUploadedAttachments
 * ------------------------------------------------------------------ */

const CHANNEL = "555000111222";
const A_ID = "1000000000000000001";
const B_ID = "1000000000000000002";

const resolved = {
	[A_ID]: {
		id: A_ID,
		filename: "shot.png",
		content_type: "image/png",
		url: "https://media.discordapp.net/attachments/1/2/shot.png",
	},
	[B_ID]: {
		id: B_ID,
		filename: "crash.log",
		content_type: "text/plain",
		url: "https://media.discordapp.net/attachments/1/3/crash.log",
	},
} as unknown as Record<string, APIAttachment>;

const resolvedOut = resolveUploadedAttachments({
	attachmentIds: [A_ID, B_ID],
	resolved,
	channelId: CHANNEL,
});
assert.equal(resolvedOut.length, 2);
assert.equal(resolvedOut[0].isImage, true, "png is an image");
assert.equal(resolvedOut[1].isImage, false, "a log is not an image");
assert.equal(
	resolvedOut[0].url,
	`https://media.discordapp.net/attachments/${CHANNEL}/${A_ID}/shot.png`,
	"the URL is rebuilt from channel, id and filename",
);
// The supplied url names a different channel and id, so reusing it verbatim would
// point the ticket at the wrong file.
assert.ok(
	!resolvedOut[0].url.includes("/attachments/1/2/"),
	"the url supplied in the payload is not reused",
);

// An id Discord did not resolve is dropped, not linked blindly.
assert.deepEqual(
	resolveUploadedAttachments({ attachmentIds: ["999"], resolved, channelId: CHANNEL }),
	[],
	"an unresolved id yields no attachment",
);
assert.deepEqual(
	resolveUploadedAttachments({ attachmentIds: [A_ID], resolved: undefined, channelId: CHANNEL }),
	[],
	"a missing resolved map yields no attachment",
);
assert.deepEqual(
	resolveUploadedAttachments({ attachmentIds: [], resolved, channelId: CHANNEL }),
	[],
	"no upload yields no attachment",
);

// More ids than the modal allows are still bounded here.
const overflow = resolveUploadedAttachments({
	attachmentIds: [A_ID, B_ID, A_ID, B_ID, A_ID, B_ID, A_ID],
	resolved,
	channelId: CHANNEL,
});
assert.equal(overflow.length, 3, "the count is capped regardless of what was submitted");

// With no channel to build the CDN path from, the URL Discord supplied is used.
const noChannel = resolveUploadedAttachments({ attachmentIds: [A_ID], resolved, channelId: null });
assert.equal(noChannel[0].url, "https://media.discordapp.net/attachments/1/2/shot.png");

// A filename containing ")" survives into the URL, and the renderer brackets the
// destination so it cannot close the Markdown link early.
const nasty = resolveUploadedAttachments({
	attachmentIds: [A_ID],
	resolved: { [A_ID]: { id: A_ID, filename: "a)b.png", content_type: "image/png", url: "https://x/y" } } as unknown as Record<string, APIAttachment>,
	channelId: CHANNEL,
});
assert.ok(nasty[0].url.endsWith("/a)b.png"), `expected the paren preserved, got ${nasty[0].url}`);
const nastyBody = buildIssueBody({
	reporterId: "1",
	reporterUsername: null,
	description: "d",
	steps: "",
	attachments: nasty,
});
assert.ok(
	nastyBody.includes(`![a)b.png](<${nasty[0].url}>)`),
	"a paren in the filename is protected by the bracketed destination",
);

// A filename with brackets cannot open a link inside the caption.
const bracketBody = buildIssueBody({
	reporterId: "1",
	reporterUsername: null,
	description: "d",
	steps: "",
	attachments: [{ url: "https://cdn.discordapp.com/x.png", filename: "a[b]c.png", isImage: true }],
});
assert.ok(bracketBody.includes("![a\\[b\\]c.png]"), `brackets must be escaped, got ${bracketBody}`);

// An attachment with no filename still produces a usable, non-empty caption.
const unnamed = resolveUploadedAttachments({
	attachmentIds: [A_ID],
	resolved: { [A_ID]: { id: A_ID, filename: "  ", content_type: "image/png", url: "https://x/y" } } as unknown as Record<string, APIAttachment>,
	channelId: CHANNEL,
});
assert.equal(unnamed[0].filename, `attachment-${A_ID}`);

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
assert.equal(formatCooldownRemaining(120_001), "3 minutes");
// The default cooldown, so the wording a player actually sees is pinned.
assert.equal(formatCooldownRemaining(600_000), "10 minutes");
assert.equal(formatCooldownRemaining(600_001), "11 minutes");
// Hours are still formatted, for a cooldown raised by configuration.
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
assert.equal(getReportCooldownMs(), 10 * 60 * 1000, "one report per 10 minutes by default");

// A malformed cooldown must not silently disable the only guard on the tracker.
process.env.BUG_REPORT_COOLDOWN_MS = "not-a-number";
assert.equal(getReportCooldownMs(), 10 * 60 * 1000, "garbage falls back to the default");
process.env.BUG_REPORT_COOLDOWN_MS = "-5";
assert.equal(getReportCooldownMs(), 10 * 60 * 1000, "a negative cooldown falls back");
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
