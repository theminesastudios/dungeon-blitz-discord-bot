import assert from "node:assert/strict";
import {
	buildIssueBody,
	getIssueRepo,
	getReportCooldownMs,
	normalizeIssueTitle,
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
