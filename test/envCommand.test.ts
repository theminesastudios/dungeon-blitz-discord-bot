import assert from "node:assert/strict";
import {
	buildEnvChangeContainer,
	buildEnvViewContainer,
	envCommand,
	normalizeEnvKey,
} from "../src/commands/env.js";
import { changeGameServerEnv, fetchGameServerEnv } from "../src/utils/gameServerEnv.js";
import type { EnvChange, GameServerEnv } from "../src/utils/gameServerEnv.js";

// `/env` turns a live .env edit (on 2026-10-23, SERVER_LOGS and BUFF_RELAY_TRACE filling the
// disk) into a slash command. Pinned here: what the panel shows and hides, that the restart it
// offers is `/server`'s own button for the deploy branch, and the requests the game server's
// /api/admin/server/env route reads (src/server/test/server_env_api_regression.ts there).

type Component = Record<string, any>;

function componentsOf(container: { toJSON(): unknown }): Component[] {
	return (container.toJSON() as { components: Component[] }).components;
}

function textOf(components: Component[]): string {
	return components
		.filter((component) => component.type === 10)
		.map((component) => String(component.content))
		.join("\n");
}

function buttonsOf(components: Component[]): Component[] {
	return components
		.filter((component) => component.type === 1)
		.flatMap((row) => row.components as Component[])
		.filter((component) => component.type === 2);
}

function env(overrides: Partial<GameServerEnv> = {}): GameServerEnv {
	return {
		path: "/home/USER/dungeon-blitz-r/src/server/.env",
		exists: true,
		deployBranch: "release/2026-10-29",
		restartPending: false,
		entries: [
			{ key: "SERVER_LOGS", inFile: true, value: "on", secret: false, editable: true, running: "same" },
			{ key: "MONGODB_URI", inFile: true, value: null, secret: true, editable: false, reason: "credential", running: "same" },
			{ key: "DEPLOY_BRANCH", inFile: true, value: "main", secret: false, editable: false, reason: "belongs to /server", running: "differs", runningValue: "release/2026-10-29" },
		],
		...overrides,
	};
}

function change(overrides: Partial<EnvChange> = {}): EnvChange {
	return {
		key: "SERVER_LOGS",
		action: "set",
		previous: "on",
		previousHidden: false,
		value: "off",
		changed: true,
		added: false,
		removedDuplicates: 0,
		restartRequired: true,
		running: "differs",
		known: true,
		deployBranch: "release/2026-10-29",
		...overrides,
	};
}

function testViewShowsValuesButNoSecret(): void {
	const components = componentsOf(buildEnvViewContainer(env()));
	const text = textOf(components);
	assert.match(text, /\*\*SERVER_LOGS\*\* `on`/);
	assert.match(text, /\*\*MONGODB_URI\*\* •••• \*\(secret, hidden\)\* 🔒/, "a secret is shown as set, never by value");
	assert.match(text, /\*\*DEPLOY_BRANCH\*\* `main` 🔒/);
	assert.match(text, /⏳ running `release\/2026-10-29` — restart to apply/);
	assert.deepEqual(buttonsOf(components), [], "nothing is owed, so no restart is offered");

	const pending = componentsOf(buildEnvViewContainer(env({ restartPending: true })));
	assert.deepEqual(
		buttonsOf(pending).map((button) => button.custom_id),
		["server:restart:300:release/2026-10-29", "server:refresh:release/2026-10-29"],
		"the restart is /server's own five-minute button, onto the deploy branch",
	);
	assert.equal((buildEnvViewContainer(env({ restartPending: true })).toJSON() as Component).accent_color, 0xf39c12);

	const missing = textOf(componentsOf(buildEnvViewContainer(env({ exists: false, entries: [] }))));
	assert.match(missing, /There is no \.env/);

	// A long file stops before Discord's 4000-character limit and says how much it left out.
	const many = env({
		entries: Array.from({ length: 80 }, (_, index) => ({
			key: `SETTING_${index}`,
			inFile: true,
			value: "x".repeat(60),
			secret: false,
			editable: true,
			running: "same" as const,
		})),
	});
	const long = textOf(componentsOf(buildEnvViewContainer(many)));
	assert.ok(long.length < 4_000, `the view is ${long.length} characters`);
	assert.match(long, /…and \d+ more/);
}

function testChangeSaysWhetherARestartIsOwed(): void {
	const set = componentsOf(buildEnvChangeContainer(change()));
	assert.match(textOf(set), /✅ \*\*SERVER_LOGS\*\* set to `off`\./);
	assert.match(textOf(set), /was `on`/);
	assert.match(textOf(set), /Applies at the next restart/);
	assert.deepEqual(buttonsOf(set).map((button) => button.label), ["Restart to release/2026-10-29 in 5 min", "Open /server"]);

	const cleared = textOf(componentsOf(buildEnvChangeContainer(change({ key: "BUFF_RELAY_TRACE", action: "clear", previous: "1", value: "" }))));
	assert.match(cleared, /\*\*BUFF_RELAY_TRACE\*\* cleared \(now `BUFF_RELAY_TRACE=`\)/);

	const settled = componentsOf(buildEnvChangeContainer(change({ restartRequired: false, running: "same" })));
	assert.match(textOf(settled), /no restart needed/);
	assert.deepEqual(buttonsOf(settled), []);

	const unchanged = textOf(componentsOf(buildEnvChangeContainer(change({ changed: false }))));
	assert.match(unchanged, /already `off` in \.env — nothing was written/);

	const typo = textOf(componentsOf(buildEnvChangeContainer(change({ key: "SERVR_LOGS", previous: null, added: true, known: false }))));
	assert.match(typo, /`SERVR_LOGS` was not in \.env, \.env\.example or the running environment — check the spelling/);
	assert.match(typo, /was not in \.env · new line added/);

	const hidden = textOf(componentsOf(buildEnvChangeContainer(change({ previous: null, previousHidden: true }))));
	assert.match(hidden, /was a hidden value/);

	// A branch too long for a button id gets no button rather than a broken one.
	const longBranch = componentsOf(buildEnvChangeContainer(change({ deployBranch: `feat/${"x".repeat(90)}` })));
	assert.deepEqual(buttonsOf(longBranch), []);
}

function testCommandShape(): void {
	const data = envCommand.data.toJSON() as Component;
	assert.equal(data.name, "env");
	assert.equal(data.default_member_permissions, "8", "administrators only, like /server");
	assert.deepEqual((data.options as Component[]).map((option) => option.name), ["view", "set", "clear"]);
	assert.equal(normalizeEnvKey(" server_logs "), "SERVER_LOGS");
}

async function testRequests(): Promise<void> {
	const originalFetch = globalThis.fetch;
	const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
	const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
	const calls: Array<{ url: string; method: string; authorization: string; body: unknown }> = [];
	try {
		process.env.GAME_SERVER_BASE_URL = "https://game.example.com/";
		process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
		globalThis.fetch = (async (input: unknown, init: any) => {
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			calls.push({
				url: String(input),
				method: String(init?.method ?? "GET"),
				authorization: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
				body,
			});
			if (body?.key === "MONGODB_URI") {
				return new Response(JSON.stringify({ ok: false, error: "MONGODB_URI holds a credential, so it cannot be changed from Discord." }), { status: 403 });
			}
			if (init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true, ...change() }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true, ...env() }), { status: 200 });
		}) as typeof fetch;

		const view = await fetchGameServerEnv();
		assert.equal(view.entries.length, 3);
		await fetchGameServerEnv("SERVER_LOGS");
		const set = await changeGameServerEnv({ key: "SERVER_LOGS", value: "off", requestedBy: "1234" });
		assert.equal(set.restartRequired, true);
		await changeGameServerEnv({ key: "BUFF_RELAY_TRACE", clear: true });
		await assert.rejects(
			changeGameServerEnv({ key: "MONGODB_URI", value: "mongodb://x" }),
			/rejected the change to MONGODB_URI \(403\): MONGODB_URI holds a credential/,
			"a refusal reads in the game server's own words",
		);

		assert.deepEqual(
			calls.map((call) => [call.method, call.url.replace("https://game.example.com", ""), call.body]),
			[
				["GET", "/api/admin/server/env", null],
				["GET", "/api/admin/server/env?key=SERVER_LOGS", null],
				["POST", "/api/admin/server/env", { key: "SERVER_LOGS", value: "off", requestedBy: "1234" }],
				["POST", "/api/admin/server/env", { key: "BUFF_RELAY_TRACE", clear: true }],
				["POST", "/api/admin/server/env", { key: "MONGODB_URI", value: "mongodb://x" }],
			],
		);
		assert.ok(calls.every((call) => call.authorization === "Bearer test-secret"));
	} finally {
		globalThis.fetch = originalFetch;
		if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
		else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
		if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
		else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
	}
}

testViewShowsValuesButNoSecret();
testChangeSaysWhetherARestartIsOwed();
testCommandShape();
await testRequests();

console.log("envCommand.test: ok");
