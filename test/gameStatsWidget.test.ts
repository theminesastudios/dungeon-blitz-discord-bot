import assert from "node:assert/strict";
import {
	ACCOUNT_LINK_SCOPES,
	APPLICATION_IDENTITIES_WRITE_SCOPE,
	DYNAMIC_FIELD_LIMIT,
	GameStatsAuthorizationError,
	GameStatsConfigError,
	GameStatsRequestError,
	GameStatsValidationError,
	PROFILE_DATA_LIMIT_BYTES,
	ROLE_LINK_SCOPES,
	assertProfileDataWithinLimits,
	checkGameStatsAccess,
	getApplicationIdentityProfile,
	measureProfileDataBytes,
	resolveGameStatsApiConfig,
	updateApplicationIdentityProfile,
} from "../src/utils/gameStatsProfile.js";
import {
	GAME_STATS_DYNAMIC_FIELDS,
	buildGameStatsProfilePayload,
	masterClassName,
} from "../src/utils/gameStatsSync.js";
import type { GameWalletSummary } from "../src/utils/gameWallet.js";

function wallet(overrides: Partial<GameWalletSummary>): GameWalletSummary {
	return {
		id: "1",
		selector: "saves:1:hero",
		source: "saves",
		gameUserId: 1,
		characterName: "Hero",
		characterClass: "Mage",
		characterMasterClass: 0,
		characterLevel: 10,
		gold: 0,
		mammothIdols: 0,
		dragonKeys: 0,
		dragonOre: 0,
		silverSigils: 0,
		royalSigils: 0,
		updatedAtMs: 1_700_000_000_000,
		...overrides,
	};
}

// The widget scope is deliberately NOT requested. Discord refuses it for an application that
// has not been approved for game stats, and that refusal fails the whole authorization — so
// asking for it took account creation down with it. Put it back in both lists once the app is
// approved (checkGameStatsAccess reports that), then have players re-link.
assert.ok(!ACCOUNT_LINK_SCOPES.includes(APPLICATION_IDENTITIES_WRITE_SCOPE));
assert.ok(!ROLE_LINK_SCOPES.includes(APPLICATION_IDENTITIES_WRITE_SCOPE));
assert.equal(new Set(ACCOUNT_LINK_SCOPES).size, ACCOUNT_LINK_SCOPES.length, "scopes are not repeated");
assert.equal(new Set(ROLE_LINK_SCOPES).size, ROLE_LINK_SCOPES.length, "scopes are not repeated");

// Missing configuration is reported as a config error rather than a failed request.
assert.throws(() => resolveGameStatsApiConfig({} as NodeJS.ProcessEnv), GameStatsConfigError);
assert.throws(
	() => resolveGameStatsApiConfig({ DISCORD_APPLICATION_ID: "1" } as NodeJS.ProcessEnv),
	GameStatsConfigError,
	"a bot token is required"
);

const config = resolveGameStatsApiConfig({
	DISCORD_APPLICATION_ID: " \"1447954255452311695\" ",
	DISCORD_BOT_TOKEN: " token ",
} as NodeJS.ProcessEnv);
assert.equal(config.applicationId, "1447954255452311695", "quoted env values are unwrapped");
assert.equal(config.botToken, "token");
assert.equal(config.apiBase, "https://discord.com/api/v10");

// The featured character is the strongest one, and every mapped field is a real save value.
const previousBaseUrl = process.env.GAME_SERVER_BASE_URL;
process.env.GAME_SERVER_BASE_URL = "http://dungeonblitzr.theminesa.studio/";

const payload = buildGameStatsProfilePayload({
	wallets: [
		wallet({ characterName: "Rookie", characterLevel: 3, gold: 10 }),
		wallet({
			characterName: "Veteran",
			characterClass: "Brute",
			characterMasterClass: 8,
			characterLevel: 42,
			gold: 1500,
			mammothIdols: 7,
			dragonKeys: 2,
			dragonOre: 5,
			silverSigils: 9,
		}),
	],
	season: "Season 1",
});

assert.ok(payload, "a roster with characters produces a payload");
assert.equal(payload.username, "Veteran");
assert.equal(payload.data?.primary?.featured_played_character, "Veteran");
assert.equal(payload.data?.primary?.season, "Season 1");
assert.equal(
	payload.data?.primary?.featured_played_character_image?.url,
	"http://dungeonblitzr.theminesa.studio/portraits/veteran.png?v=1700000000"
);

const dynamic = new Map(
	(payload.data?.dynamic ?? []).map((field) => [field.name, field.value] as const)
);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.characterClass), "Brute");
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.masterClass), "Flameseer");
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.characterLevel), 42);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.highestLevel), 42);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.gold), 1500);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.mammothIdols), 7);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.dragonKeys), 2);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.dragonOre), 5);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.silverSigils), 9);
assert.equal(dynamic.get(GAME_STATS_DYNAMIC_FIELDS.characterCount), 2);
assertProfileDataWithinLimits(payload.data!);

// Lifetime wins/kills/deaths/playtime are never invented: the game does not track them.
for (const field of [
	"total_wins",
	"total_games",
	"total_kills",
	"total_assists",
	"total_deaths",
	"playtime_hours",
	"rank_name",
] as const) {
	assert.equal(payload.data?.primary?.[field], undefined, `${field} must stay unset`);
}

// Every MasterClassID the game defines maps to a name, and an unchosen or unknown one is left
// out so the widget falls back instead of repeating the base class.
assert.deepEqual(
	[1, 2, 3, 4, 5, 6, 7, 8, 9].map(masterClassName),
	[
		"Executioner",
		"Shadowwalker",
		"Soulthief",
		"Sentinel",
		"Justicar",
		"Templar",
		"Frostwarden",
		"Flameseer",
		"Necromancer",
	]
);
assert.equal(masterClassName(0), "", "an unchosen discipline has no name");
assert.equal(masterClassName(undefined), "");
assert.equal(masterClassName("not-a-number"), "");
assert.equal(masterClassName(42), "", "an unknown id is omitted rather than guessed");

const noDiscipline = new Map(
	(
		buildGameStatsProfilePayload({
			wallets: [wallet({ characterName: "Fresh", characterMasterClass: 0 })],
		})?.data?.dynamic ?? []
	).map((field) => [field.name, field.value] as const)
);
assert.equal(noDiscipline.has(GAME_STATS_DYNAMIC_FIELDS.masterClass), false);

// An empty roster is "nothing to publish" rather than an empty widget record.
assert.equal(buildGameStatsProfilePayload({ wallets: [] }), null);
assert.equal(buildGameStatsProfilePayload({ wallets: [wallet({ characterName: "  " })] }), null);

// Portrait URLs are optional: without a game server base the payload is still valid.
delete process.env.GAME_SERVER_BASE_URL;
const withoutPortrait = buildGameStatsProfilePayload({ wallets: [wallet({})] });
assert.equal(withoutPortrait?.data?.primary?.featured_played_character_image, undefined);
if (previousBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
else process.env.GAME_SERVER_BASE_URL = previousBaseUrl;

// Long character names are clamped to Discord's per-field character limit.
const longName = "N".repeat(140);
const clamped = buildGameStatsProfilePayload({ wallets: [wallet({ characterName: longName })] });
assert.equal(clamped?.username?.length, 100);
assertProfileDataWithinLimits(clamped!.data!);

// Oversized payloads fail locally, before a request is made.
assert.throws(
	() =>
		assertProfileDataWithinLimits({
			dynamic: Array.from({ length: DYNAMIC_FIELD_LIMIT + 1 }, (_, index) => ({
				type: 2 as const,
				name: `field_${index}`,
				value: index,
			})),
		}),
	GameStatsValidationError
);
assert.throws(
	() => assertProfileDataWithinLimits({ primary: { rank_name: "R".repeat(101) } }),
	GameStatsValidationError
);
assert.throws(
	() =>
		assertProfileDataWithinLimits({
			dynamic: [{ type: 1, name: "note", value: "x".repeat(200) }],
		}),
	GameStatsValidationError
);
// The byte guard runs before the per-field guards, so the 10 KB ceiling is reported as such.
assert.throws(
	() =>
		assertProfileDataWithinLimits({
			dynamic: [{ type: 1, name: "note", value: "z".repeat(PROFILE_DATA_LIMIT_BYTES) }],
		}),
	(error: unknown) =>
		error instanceof GameStatsValidationError && error.message.includes("bytes")
);
assert.equal(
	measureProfileDataBytes(payload!.data),
	Buffer.byteLength(JSON.stringify(payload!.data), "utf8"),
	"the reported size matches what goes on the wire"
);

// Requests: the URL, method, bot auth header and body all have to match the documented API.
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function stubFetch(status: number, body: string): void {
	globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
		calls.push({
			url: String(url),
			method: String(init.method ?? "GET"),
			headers: (init.headers ?? {}) as Record<string, string>,
			...(typeof init.body === "string" ? { body: init.body } : {}),
		});
		return { status, text: async () => body } as Response;
	}) as typeof fetch;
}

function stubFetchReject(error: Error): void {
	globalThis.fetch = (async () => {
		throw error;
	}) as typeof fetch;
}

try {
	calls.length = 0;
	stubFetch(201, "");
	const created = await updateApplicationIdentityProfile(
		{
			discordUserId: "1447954255452311695",
			providerIssuedUserId: 77,
			username: payload!.username,
			data: payload!.data,
		},
		config
	);
	assert.equal(created.outcome, "created");
	assert.equal(created.status, 201);
	assert.equal(
		calls[0].url,
		"https://discord.com/api/v10/applications/1447954255452311695/users/1447954255452311695/identities/77/profile"
	);
	assert.equal(calls[0].method, "PATCH");
	assert.equal(calls[0].headers.Authorization, "Bot token");
	assert.equal(calls[0].headers["Content-Type"], "application/json");
	const sent = JSON.parse(calls[0].body ?? "{}");
	assert.equal(sent.username, "Veteran");
	assert.equal(sent.data.primary.featured_played_character, "Veteran");
	assert.ok(!("provider_issued_user_id" in sent), "the identity comes from the path, not the body");

	// 204 is the documented answer for an update of an existing profile.
	calls.length = 0;
	stubFetch(204, "");
	const updated = await updateApplicationIdentityProfile(
		{ discordUserId: "1447954255452311695", providerIssuedUserId: 77 },
		config
	);
	assert.equal(updated.outcome, "updated");

	// A 403 is always "the player must re-link", and it is surfaced as its own error type.
	calls.length = 0;
	stubFetch(403, JSON.stringify({ message: "Missing scope", code: 50001 }));
	await assert.rejects(
		() =>
			updateApplicationIdentityProfile(
				{ discordUserId: "1447954255452311695", providerIssuedUserId: 77 },
				config
			),
		GameStatsAuthorizationError
	);

	// Other API rejections keep their status so callers can tell 413 from 400.
	calls.length = 0;
	stubFetch(400, JSON.stringify({ message: "Provider user ID does not match" }));
	await assert.rejects(
		() =>
			updateApplicationIdentityProfile(
				{ discordUserId: "1447954255452311695", providerIssuedUserId: 77 },
				config
			),
		(error: unknown) =>
			error instanceof GameStatsRequestError &&
			error.status === 400 &&
			error.message.includes("Provider user ID does not match")
	);

	// Reads use the same identity path.
	calls.length = 0;
	stubFetch(200, JSON.stringify({ username: "Veteran", data: payload!.data }));
	const profile = await getApplicationIdentityProfile(
		{ discordUserId: "1447954255452311695", providerIssuedUserId: 77 },
		config
	);
	assert.equal(profile.username, "Veteran");
	assert.equal(calls[0].method, "GET");
	assert.ok(!("body" in calls[0]), "GET sends no body");

	// The application-level gate. Discord hides the Application Identity routes from an app that
	// is not approved for game stats: the generic route-not-found body comes back where the
	// documented permission failure is a 403. Both stop every widget write, and only one of them
	// is fixed by enabling game stats for the application, so they must not be confused.
	calls.length = 0;
	stubFetch(200, JSON.stringify({ identities: [] }));
	const authorized = await checkGameStatsAccess(
		{ discordUserId: "1447954255452311695" },
		config
	);
	assert.equal(authorized.state, "authorized");
	assert.equal(
		calls[0].url,
		"https://discord.com/api/v10/applications/1447954255452311695/users/1447954255452311695/identities"
	);
	assert.equal(calls[0].method, "GET");
	assert.equal(calls[0].headers.Authorization, "Bot token");

	stubFetch(403, JSON.stringify({ message: "Application not authorized for game stats" }));
	assert.equal(
		(await checkGameStatsAccess({ discordUserId: "1447954255452311695" }, config)).state,
		"not-authorized"
	);

	stubFetch(404, JSON.stringify({ message: "404: Not Found", code: 0 }));
	const notEnabled = await checkGameStatsAccess(
		{ discordUserId: "1447954255452311695" },
		config
	);
	assert.equal(notEnabled.state, "not-enabled");
	assert.equal(notEnabled.status, 404);
	assert.ok(
		notEnabled.summary.includes("Social SDK") && notEnabled.summary.includes("claim"),
		"the operator summary names the portal fix"
	);
	assert.equal(
		(await checkGameStatsAccess({ discordUserId: "1447954255452311695" }, config)).state,
		"not-enabled",
		"only a 403 is reported as a permissions problem"
	);

	stubFetch(401, JSON.stringify({ message: "401: Unauthorized", code: 0 }));
	assert.equal(
		(await checkGameStatsAccess({ discordUserId: "1447954255452311695" }, config)).state,
		"bad-credentials"
	);

	// An unreachable Discord is reported, never thrown: the probe runs on a player's page.
	stubFetchReject(new Error("fetch failed"));
	const unreachable = await checkGameStatsAccess(
		{ discordUserId: "1447954255452311695" },
		config
	);
	assert.equal(unreachable.state, "unknown");
	assert.equal(unreachable.status, null);
	assert.ok(unreachable.detail.includes("fetch failed"));

	// Bad identifiers never reach Discord.
	calls.length = 0;
	await assert.rejects(
		() =>
			updateApplicationIdentityProfile(
				{ discordUserId: "not-a-snowflake", providerIssuedUserId: 77 },
				config
			),
		GameStatsValidationError
	);
	await assert.rejects(
		() =>
			updateApplicationIdentityProfile(
				{ discordUserId: "1447954255452311695", providerIssuedUserId: "" },
				config
			),
		GameStatsValidationError
	);
	await assert.rejects(
		() =>
			updateApplicationIdentityProfile(
				{
					discordUserId: "1447954255452311695",
					providerIssuedUserId: 77,
					data: { primary: { rank_name: "R".repeat(101) } },
				},
				config
			),
		GameStatsValidationError
	);
	assert.equal(calls.length, 0, "validation failures must not call Discord at all");
} finally {
	globalThis.fetch = originalFetch;
}

console.log("game stats widget checks passed");
