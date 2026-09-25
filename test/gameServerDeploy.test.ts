import assert from "node:assert/strict";
import {
	cancelGameServerRestart,
	fetchGameServerBranches,
	fetchGameServerState,
	restartGameServer,
} from "../src/utils/gameServerDeploy.js";

// The three calls `/server` makes, pinned against a captured fetch: the deploy routes are
// read-only via GET, the restart is a POST, every call carries the same shared secret, and a
// refusal from the game server surfaces its own words instead of a generic failure.

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;

type Call = {
	url: string;
	method: string;
	authorization: string;
	body: unknown;
};

const calls: Call[] = [];

function respond(payload: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
	globalThis.fetch = (async (input: unknown, init: any) => {
		calls.push({
			url: String(input),
			method: String(init?.method ?? "GET"),
			authorization: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		const url = String(input);
		if (url.endsWith("/api/admin/server/state")) {
			return respond({
				ok: true,
				repo: "/home/USER/dungeon-blitz-r",
				pm2App: "dungeon-mp",
				deployBranch: "main",
				checkoutBranch: "main",
				commit: "b2e0728c89b9c899679ae1bc81712afd0ece1578",
				shortCommit: "b2e0728",
				commitSubject: "feat: operator log channel",
				commitAt: "2026-09-25T00:00:00.000Z",
				buildCommit: "b2e0728c89b9c899679ae1bc81712afd0ece1578",
				dirty: false,
				hold: false,
				uptimeSeconds: 3600,
				onlinePlayers: 2,
				pendingRestart: null,
			});
		}
		if (url.endsWith("/api/admin/server/branches")) {
			return respond({
				ok: true,
				repo: "/home/USER/dungeon-blitz-r",
				deployBranch: "main",
				count: 2,
				branches: [
					{ name: "main", commit: "a".repeat(40), shortCommit: "aaaaaaa", current: true },
					{ name: "release/2026-10-02", commit: "b".repeat(40), shortCommit: "bbbbbbb", current: false },
				],
			});
		}
		if (url.endsWith("/api/admin/server/restart/cancel")) {
			return respond({
				ok: true,
				branch: "main",
				commit: "a".repeat(40),
				seconds: 60,
				requestedAt: "2026-09-25T03:00:00.000Z",
				restartAt: "2026-09-25T03:01:00.000Z",
				recipients: 2,
				requestedBy: "1",
			});
		}
		return respond(
			{
				ok: true,
				branch: "release/2026-10-02",
				commit: "b".repeat(40),
				seconds: 60,
				requestedAt: "2026-09-25T03:00:00.000Z",
				restartAt: "2026-09-25T03:01:00.000Z",
				recipients: 3,
				hold: false,
				dryRun: false,
			},
			202,
		);
	}) as any;

	// A read is a GET with no body — a status check must never be able to schedule anything.
	const state = await fetchGameServerState();
	assert.equal(calls[0]!.method, "GET");
	assert.equal(calls[0]!.url, "https://game.example.com/api/admin/server/state");
	assert.equal(calls[0]!.authorization, "Bearer test-secret");
	assert.equal(calls[0]!.body, null);
	assert.equal(state.checkoutBranch, "main");
	assert.equal(state.onlinePlayers, 2);
	assert.equal(state.pendingRestart, null);

	const branches = await fetchGameServerBranches();
	assert.equal(calls[1]!.method, "GET");
	assert.equal(calls[1]!.url, "https://game.example.com/api/admin/server/branches");
	assert.equal(calls[1]!.body, null);
	assert.equal(branches.count, 2);
	assert.equal(branches.branches[0]!.name, "main");
	assert.equal(branches.branches[0]!.current, true);

	const restart = await restartGameServer({
		branch: "release/2026-10-02",
		seconds: 60,
		requestedBy: "1447954255452311695",
	});
	assert.equal(calls[2]!.method, "POST");
	assert.equal(calls[2]!.url, "https://game.example.com/api/admin/server/restart");
	assert.deepEqual(calls[2]!.body, {
		branch: "release/2026-10-02",
		seconds: 60,
		requestedBy: "1447954255452311695",
	});
	assert.equal(restart.branch, "release/2026-10-02");
	assert.equal(restart.recipients, 3);
	assert.equal(restart.dryRun, false);

	// The default restart names no branch: the server stays on whatever it deploys.
	await restartGameServer({ seconds: 0 });
	assert.deepEqual(calls[3]!.body, { seconds: 0 });

	const cancelled = await cancelGameServerRestart();
	assert.equal(calls[4]!.method, "POST");
	assert.equal(calls[4]!.url, "https://game.example.com/api/admin/server/restart/cancel");
	assert.deepEqual(calls[4]!.body, {});
	assert.equal(cancelled.branch, "main");

	// A refusal travels verbatim: the operator reads the game server's reason, not "failed".
	globalThis.fetch = (async () =>
		respond(
			{ ok: false, error: "a maintenance hold is set (tools/server-maintenance.sh --hold)" },
			409,
		)) as any;
	let refusal = "";
	try {
		await restartGameServer({ branch: "main", seconds: 60 });
	} catch (error) {
		refusal = error instanceof Error ? error.message : String(error);
	}
	assert.match(refusal, /Game server rejected the restart to main \(409\)/);
	assert.match(refusal, /maintenance hold is set/);

	// Without the shared secret nothing is sent, and the reason names what to set.
	delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	let calledFetch = false;
	globalThis.fetch = (async () => {
		calledFetch = true;
		return respond({ ok: true });
	}) as any;
	let missingSecret = "";
	try {
		await fetchGameServerState();
	} catch (error) {
		missingSecret = error instanceof Error ? error.message : String(error);
	}
	assert.equal(calledFetch, false);
	assert.match(missingSecret, /DISCORD_MAINTENANCE_API_SECRET/);

	console.log("gameServerDeploy.test: ok");
} finally {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
}
