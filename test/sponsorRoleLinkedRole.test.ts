import assert from "node:assert/strict";

/**
 * `/admin sponsor-role` marks a player as a sponsor by writing two things: the stored
 * `isSponsor` flag, and the linked-role metadata Discord awards the Sponsor role from.
 *
 * It must **never** call `PUT /guilds/{g}/members/{u}/roles/{r}`. That endpoint grants a
 * *plain* role; the Sponsor role is a linked role, which Discord awards from the
 * metadata when the player authorizes. Against a linked role the call answers
 * `403 Missing Access` (code 50001), so issuing it could only fail — and it made the
 * command report failure while the metadata write, the part that actually decides
 * whether the player can claim the role, never happened.
 *
 * This drives the real handler with a fake interaction and a stubbed `fetch`, so the
 * assertions are on the requests that actually go out.
 */

process.env.MONGODB_URI ??= "mongodb://localhost:27017/test";
process.env.DISCORD_BOT_TOKEN = "bot-token-for-tests";
process.env.DISCORD_GUILD_ID = "guild-1";
process.env.DISCORD_APPLICATION_ID = "app-1";
process.env.DISCORD_CLIENT_SECRET = "client-secret-for-tests";
process.env.GITHUB_SPONSOR_TARGETS = "revolutionr1";

const { db } = await import("../src/utils/database.js");
const { handleSponsorRole } = await import("../src/commands/sponsor-role.js");

const TARGET_ID = "111111111111111111";
const SPONSOR_ROLE = "1365618632415248444";

type RecordedWrite = { key: string; data: Record<string, unknown> };
const profileWrites: RecordedWrite[] = [];

// A stand-in profile document, in memory: the handler reads it and spreads it, and a
// real Mongo is not needed to observe what it would have written. It carries the token
// the linked-roles callback stored, comfortably valid so the push never renews it.
const stored: Record<string, Record<string, unknown>> = {
	[TARGET_ID]: {
		userId: TARGET_ID,
		platform_username: "revolutionr1",
		accessToken: "player-access-token",
		refreshToken: "player-refresh-token",
		expiresAt: Date.now() + 3_600_000,
		scope: "identify role_connections.write",
	},
};

(db as unknown as { get: unknown }).get = async (key: string) => stored[key] ?? null;
(db as unknown as { set: unknown }).set = async (
	key: string,
	data: Record<string, unknown>
) => {
	profileWrites.push({ key, data });
	stored[key] = data;
	return true;
};

const requests: Array<{ method: string; url: string; body?: string }> = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	const method = (init?.method ?? "GET").toUpperCase();
	requests.push({
		method,
		url,
		body: typeof init?.body === "string" ? init.body : undefined,
	});

	// Read-only member lookup: the member is in the guild and does not yet hold the role.
	if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(url)) {
		return new Response(JSON.stringify({ roles: ["111"] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	// The role-connection read the push merges against.
	if (url.includes("/role-connection")) {
		if (method === "GET") {
			return new Response(
				JSON.stringify({
					platform_name: "Dungeon Blitz",
					metadata: {
						is_sponsor: "0",
						contributor: "1",
						platform_username: "revolutionr1",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}
		return new Response(
			JSON.stringify({
				platform_name: "Dungeon Blitz",
				metadata: {
					is_sponsor: "1",
					contributor: "1",
					platform_username: "revolutionr1",
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } }
		);
	}

	// The access token is seeded as already valid, so no refresh grant is needed.
	if (url.includes("/oauth2/token")) {
		return new Response("{}", { status: 400 });
	}

	throw new Error(`unexpected fetch: ${method} ${url}`);
}) as typeof globalThis.fetch;

const replies: string[] = [];
const interaction = {
	member: { permissions: "8", roles: [], user: { id: "operator" } },
	user: { id: "operator" },
	options: {
		getUser: () => ({ user: { id: TARGET_ID, username: "RevolutionR1" } }),
		getString: (name: string) =>
			name === "mode" ? "grant" : name === "github_username" ? null : null,
	},
	deferReply: async () => {},
	reply: async (payload: { content?: string }) => {
		replies.push(payload?.content ?? "");
	},
	editReply: async (payload: { content?: string }) => {
		replies.push(payload?.content ?? "");
		return payload;
	},
};

try {
	await handleSponsorRole(interaction as never);
} finally {
	globalThis.fetch = originalFetch;
}

const reply = replies.join("\n");

// 1. No direct role grant is attempted. A linked role is never granted this way, and
//    the call can only fail on a guild where the bot does not hold Manage Roles.
const roleWrite = requests.find((r) =>
	new RegExp(`/guilds/[^/]+/members/[^/]+/roles/${SPONSOR_ROLE}`).test(r.url)
);
assert.equal(
	roleWrite,
	undefined,
	"a linked role must not be granted through the member role endpoint"
);

// 2. The badge metadata is pushed — this is what actually awards the linked role.
const connectionPut = requests.find(
	(r) => r.method === "PUT" && r.url.includes("/role-connection")
);
assert.ok(
	connectionPut,
	"the role-connection metadata must be pushed so Discord awards the linked role"
);
const metadata = (
	JSON.parse(connectionPut!.body ?? "{}") as {
		metadata?: Record<string, string>;
	}
).metadata;
assert.equal(
	metadata?.is_sponsor,
	"1",
	"the pushed metadata must claim the sponsor badge"
);
assert.equal(
	metadata?.contributor,
	"1",
	"the verification-owned contributor badge must survive the staff push"
);

// 3. The stored profile says sponsor, so packs and credit unlock.
const write = profileWrites.find((w) => w.key === TARGET_ID);
assert.ok(write, "the stored profile must be written");
assert.equal(
	write!.data.isSponsor,
	true,
	"the player must be marked as a sponsor so packs and credit unlock"
);

// 4. The reply tells the operator what the player still has to do, instead of
//    reporting a role-grant failure.
assert.doesNotMatch(
	reply,
	/Role change failed/,
	"there is no role change left to fail"
);
assert.match(
	reply,
	/linked role/i,
	"the reply must explain the role is awarded by Discord from the metadata"
);
assert.match(
	reply,
	/authorize/i,
	"the reply must say the player authorizes to receive the role"
);

console.log("sponsor-role marks the linked role via metadata, with no role grant");
