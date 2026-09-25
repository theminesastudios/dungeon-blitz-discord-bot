import assert from "node:assert/strict";
import { nextSteps, playerReportLines } from "../src/commands/widget-status.js";
import { adminCommand } from "../src/commands/admin.js";

// Command payloads are validated by CommandBuilder as they are built, so importing the module is
// half the check: a bad option name or an over-long description throws here instead of taking
// every interaction in the deployment down with it. The widget tool now lives at `/admin widget`.
const adminPayload = adminCommand.data.toJSON() as {
	name: string;
	description: string;
	default_member_permissions?: string;
	dm_permission?: boolean;
	options?: Array<{
		name: string;
		options?: Array<{ name: string; autocomplete?: boolean; required?: boolean }>;
	}>;
};

assert.equal(adminPayload.name, "admin");
assert.ok(adminPayload.description.length <= 100, "Discord allows 100 characters for a description");
assert.equal(adminPayload.default_member_permissions, "8", "administrator-only, like the other operator commands");
assert.equal(adminPayload.dm_permission, false);

const widgetSubcommand = adminPayload.options?.find((option) => option.name === "widget");
assert.ok(widgetSubcommand, "the admin command must offer the widget subcommand");
const playerOption = widgetSubcommand!.options?.find((option) => option.name === "player");
assert.ok(playerOption, "the widget subcommand must offer a player option");
assert.equal(playerOption!.autocomplete, true);
assert.equal(playerOption!.required, false, "the application-level checks work without a player");

const readyPayload = {
	discordId: "1447954255452311695",
	providerIssuedUserId: "42",
	outcome: "dry-run" as const,
	payload: {
		username: "Hans",
		data: {
			primary: { featured_played_character: "Hans" },
			dynamic: [
				{ type: 1 as const, name: "character_class", value: "Paladin" },
				{ type: 2 as const, name: "character_level", value: 27 },
			],
		},
	},
};

// A player who authorized the widget but whose profile Discord has never been written for: this
// is the case behind an empty widget, and it has to say so rather than showing a field count.
const nothingWritten = playerReportLines({
	userId: 42,
	discordId: "1447954255452311695",
	connections: ["widget"],
	widgetState: "needs-authorization",
	dryRun: { ok: true, value: readyPayload },
	identities: {
		ok: true,
		value: [
			{ user_id: "1447954255452311695", provider_type: "NONE", provider_issued_user_id: "42" },
		],
	},
	stored: { ok: true, value: { username: null, data: {} } },
});
const emptyReport = nothingWritten.lines.join("\n");
assert.equal(nothingWritten.payloadFields, 3, emptyReport);
assert.equal(nothingWritten.storedFields, 0);
assert.ok(emptyReport.includes("stored profile: **empty**"), emptyReport);
assert.ok(emptyReport.includes("widget"), emptyReport);
assert.ok(emptyReport.includes("needs-authorization"), emptyReport);

// The healthy case: data stored, identity linked, username reported back.
const written = playerReportLines({
	userId: 42,
	discordId: "1447954255452311695",
	connections: ["widget", "presence"],
	widgetState: "updated",
	dryRun: { ok: true, value: readyPayload },
	identities: { ok: true, value: [] },
	stored: {
		ok: true,
		value: {
			username: "Hans",
			data: {
				primary: { featured_played_character: "Hans" },
				dynamic: [{ type: 1, name: "character_class", value: "Paladin" }],
			},
		},
	},
});
const writtenReport = written.lines.join("\n");
assert.equal(written.storedFields, 2, writtenReport);
assert.ok(writtenReport.includes("username `Hans`"), writtenReport);
assert.ok(writtenReport.includes("none — nothing has been linked yet"), writtenReport);

// Every dependency failing at once — the sandbox case — must still produce a report. One dead
// reach, an unreachable database and a refused Discord call all have to report themselves.
const allBroken = playerReportLines({
	userId: 42,
	discordId: "1447954255452311695",
	connections: [],
	widgetState: null,
	dryRun: { ok: false, error: "GAME_MONGODB_URI or MONGODB_URI is required" },
	identities: { ok: false, error: "fetch failed" },
	stored: { ok: false, error: "Discord answered 403" },
});
const brokenReport = allBroken.lines.join("\n");
assert.equal(allBroken.payloadFields, 0);
assert.equal(allBroken.storedFields, null);
assert.ok(brokenReport.includes("MONGODB_URI is required"), brokenReport);
assert.ok(brokenReport.includes("fetch failed"), brokenReport);
assert.ok(brokenReport.includes("Discord answered 403"), brokenReport);
assert.ok(brokenReport.includes("last widget sync: never"), brokenReport);

// The advice has to name the right console: a 403 is the portal, a 401 is the bot token, and
// neither should be reported as the other.
const notAuthorized = nextSteps({ accessState: "not-authorized", widgetScopeEnabled: false });
assert.equal(notAuthorized.length, 1, notAuthorized.join(" | "));
assert.ok(notAuthorized[0].includes("403"), notAuthorized.join(" | "));
assert.ok(!notAuthorized[0].includes("WIDGET_SCOPE_ENABLED"), notAuthorized.join(" | "));

const notEnabled = nextSteps({ accessState: "not-enabled", widgetScopeEnabled: false });
assert.ok(notEnabled[0].includes("Social SDK"), notEnabled.join(" | "));

const badToken = nextSteps({ accessState: "bad-credentials", widgetScopeEnabled: true });
assert.equal(badToken.length, 1, badToken.join(" | "));
assert.ok(badToken[0].includes("DISCORD_BOT_TOKEN"), badToken.join(" | "));

const probeFailed = nextSteps({ accessState: "unknown", widgetScopeEnabled: true });
assert.ok(probeFailed[0].includes("could not be checked"), probeFailed.join(" | "));

// Once the application is authorized, the remaining steps are the switch, the re-link, the
// missing write and the publish — and the re-link is never skipped.
const ready = nextSteps({
	accessState: "authorized",
	widgetScopeEnabled: true,
	player: { payloadFields: 12, storedFields: 0 },
});
assert.equal(ready.length, 4, ready.join(" | "));
assert.ok(ready.some((step) => step.includes("/authorize")), ready.join(" | "));
assert.ok(ready.some((step) => step.includes("/api/game-stats/sync")), ready.join(" | "));

// The draft rule is the thing operators get wrong: it is team membership plus Developer Mode, not
// a portal role. Losing that sentence would send someone around the team page again.
const publishStep = ready.find((step) => step.includes("Publish")) ?? "";
assert.ok(publishStep.length > 0, ready.join(" | "));
assert.match(publishStep, /Developer Mode/, publishStep);
assert.match(publishStep, /Read Only/, publishStep);
assert.match(publishStep, /team/, publishStep);

// The sync step is only reachable once the scope switch is on: suggesting a sync that would be
// refused with 403 would send the operator in a circle.
const switchOff = nextSteps({ accessState: "authorized", widgetScopeEnabled: false });
assert.ok(switchOff[0].includes("WIDGET_SCOPE_ENABLED"), switchOff.join(" | "));
assert.ok(!switchOff.some((step) => step.includes("/api/game-stats/sync")), switchOff.join(" | "));
assert.ok(switchOff.some((step) => step.includes("/authorize")), switchOff.join(" | "));

// A player the bot cannot build a payload for gets no sync advice either.
const noPayload = nextSteps({
	accessState: "authorized",
	widgetScopeEnabled: true,
	player: { payloadFields: 0, storedFields: null },
});
assert.equal(noPayload.length, 3, noPayload.join(" | "));

console.log("widgetStatus tests passed");
