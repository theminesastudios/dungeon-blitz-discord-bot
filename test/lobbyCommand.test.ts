import assert from "node:assert/strict";
import { lobbyCommand } from "../src/commands/lobby.js";
import { dailyCommand } from "../src/commands/daily.js";

// `/lobby guild` and `/lobby world`, Administrator-gated and guild-only.
const lobby = lobbyCommand.data.toJSON() as {
	name: string;
	default_member_permissions?: string | null;
	contexts?: number[];
	options?: Array<{ name: string; type: number; options?: Array<{ name: string; required?: boolean }> }>;
};
assert.equal(lobby.name, "lobby");
assert.equal(lobby.default_member_permissions, "8");
assert.deepEqual(lobby.contexts, [0]);
assert.deepEqual(
	lobby.options?.map((option) => [option.name, option.type]),
	[
		["guild", 1],
		["world", 1],
	],
);
for (const subcommand of lobby.options ?? []) {
	assert.deepEqual(subcommand.options?.map((option) => [option.name, option.required ?? false]), [["channel", false]]);
}

// Both subcommands refuse a caller without Administrator before anything is read.
for (const subcommand of ["guild", "world"]) {
	let reply: { content?: string } | null = null;
	await lobbyCommand.handler({
		guild_id: "111111111111111111",
		member: { permissions: "0", user: { id: "222222222222222222" } },
		options: {
			getSubcommand: () => subcommand,
			getString: () => null,
		},
		reply: async (payload: { content?: string }) => {
			reply = payload;
		},
		deferReply: () => assert.fail("an unauthorized caller is never deferred"),
	} as never);
	assert.match(String((reply as { content?: string } | null)?.content), /Administrator permission is required/);
}

// `/daily` takes one optional, autocompleted character.
const daily = dailyCommand.data.toJSON() as {
	name: string;
	default_member_permissions?: string | null;
	options?: Array<{ name: string; required?: boolean; autocomplete?: boolean }>;
};
assert.equal(daily.name, "daily");
assert.equal(daily.default_member_permissions ?? null, null);
assert.deepEqual(daily.options?.map((option) => [option.name, option.required ?? false, option.autocomplete]), [
	["character", false, true],
]);

console.log("lobbyCommand: ok");
