import assert from "node:assert/strict";
import {
	ensureGameItemNames,
	parseItemCatalogue,
	parseItemNameList,
	primeGameItemNames,
	resetGameItemNamesCache,
} from "../src/utils/gameContent.js";
import {
	DYE_NAMES,
	MOUNT_NAMES,
	applyItemNames,
	dyeLabel,
	mountLabel,
} from "../src/utils/gameItemNames.js";
import { formatRewardLine } from "../src/utils/gameRewards.js";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;

try {
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";

	// Both shapes the game server may answer with parse into the same ids and names.
	assert.deepEqual(parseItemNameList([{ id: 81, name: "Skybone Wyrm" }]), [
		{ id: 81, name: "Skybone Wyrm" },
	]);
	assert.deepEqual(parseItemNameList({ 81: "Skybone Wyrm" }), [
		{ id: 81, name: "Skybone Wyrm" },
	]);
	assert.deepEqual(parseItemNameList([{ mountId: 7, label: "Dune Strider" }]), [
		{ id: 7, name: "Dune Strider" },
	]);
	// Garbage in the catalogue must not become a broken select option.
	assert.deepEqual(parseItemNameList([{ id: "nope", name: "x" }, { id: 9, name: "  " }]), []);
	assert.deepEqual(parseItemNameList(null), []);
	assert.deepEqual(
		parseItemCatalogue({ items: { mounts: { 81: "Skybone Wyrm" }, dyes: { 4: "Emberdusk" } } }),
		{
			mounts: [{ id: 81, name: "Skybone Wyrm" }],
			dyes: [{ id: 4, name: "Emberdusk" }],
		},
	);

	let requestedUrl = "";
	let authorization = "";
	let calls = 0;
	globalThis.fetch = async (input, init) => {
		calls += 1;
		requestedUrl = String(input);
		authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
		return new Response(
			JSON.stringify({
				ok: true,
				mounts: [{ id: 81, name: "Skybone Wyrm" }, { id: 82, name: "Emberclaw" }],
				dyes: [{ id: 4, name: "Emberdusk" }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	await ensureGameItemNames();
	assert.equal(requestedUrl, "https://game.example.com/api/admin/content");
	assert.equal(authorization, "Bearer test-secret");
	assert.equal(calls, 1);

	// The game's names reach every surface that renders an id.
	assert.equal(mountLabel(81), "Skybone Wyrm");
	assert.equal(dyeLabel(4), "Emberdusk");
	assert.equal(
		formatRewardLine({ kind: "mount", mountId: 82, exclusive: true, label: "Mount" }),
		"Emberclaw (exclusive)",
	);
	assert.equal(
		formatRewardLine({ kind: "dye", dyeId: 4, legendary: true, label: "Legendary Dye" }),
		"Emberdusk",
	);
	// An id the game server did not name keeps its readable fallback.
	assert.equal(mountLabel(90), "Mount #90");

	// A name pinned by hand outranks the game's report, while an id the game named
	// itself is refreshed when the game renames it.
	MOUNT_NAMES[90] = "Hand-pinned Mount";
	assert.equal(applyItemNames({ mounts: [{ id: 90, name: "Renamed By Game" }] }), 0);
	assert.equal(mountLabel(90), "Hand-pinned Mount");
	assert.equal(applyItemNames({ mounts: [{ id: 81, name: "Skybone Wyrm II" }] }), 1);
	assert.equal(mountLabel(81), "Skybone Wyrm II");

	// The catalogue is cached: a second render does not ask the game server again.
	await ensureGameItemNames();
	assert.equal(calls, 1);

	// The pre-acknowledgement path only starts the load, and never throws in an
	// environment without a request context to attach the work to.
	resetGameItemNamesCache();
	primeGameItemNames();
	assert.equal(calls, 2);
	await ensureGameItemNames();
	assert.equal(mountLabel(81), "Skybone Wyrm");

	// A game server that is down or has no catalog route degrades to ids and is not
	// hammered on every click.
	resetGameItemNamesCache();
	const warn = console.warn;
	console.warn = () => {};
	globalThis.fetch = async () => new Response("{\"error\":\"not found\"}", { status: 404 });
	await ensureGameItemNames();
	assert.equal(mountLabel(81), "Skybone Wyrm", "a failed load must not clear known names");
	assert.equal(
		mountLabel(90),
		"Hand-pinned Mount",
		"a failed load must not clear a hand-pinned name",
	);
	await ensureGameItemNames();
	console.warn = warn;

	// A missing bot-side secret is reported as a configuration problem, not a crash.
	resetGameItemNamesCache();
	delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	let sentWithNoSecret = false;
	globalThis.fetch = async () => {
		sentWithNoSecret = true;
		return new Response("{}", { status: 200 });
	};
	console.warn = () => {};
	await ensureGameItemNames();
	console.warn = warn;
	assert.equal(sentWithNoSecret, false);

	console.log("gameContent tests passed");
} finally {
	globalThis.fetch = originalFetch;
	resetGameItemNamesCache();
	delete MOUNT_NAMES[81];
	delete MOUNT_NAMES[82];
	delete MOUNT_NAMES[90];
	delete DYE_NAMES[4];
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL;
	else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET;
	else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
}
