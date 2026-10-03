import assert from "node:assert/strict";

// database.ts builds the MiniDatabase instance at import time, so the dummy URI has to
// be in place before the module loads; a dynamic import is what keeps that ordering.
process.env.MONGODB_URI ??= "mongodb://localhost:27017/test";

const {
	mergeRoleConnectionPayload,
	roleConnectionPayload,
} = await import("../src/utils/database.js");

/*
 * These two builders are the only place the linked-role body is shaped, so they are
 * what keeps a badge granted by `/admin sponsor-role` identical to the one the
 * verification page writes. Both paths were asserted here rather than in the command
 * handler because the handler needs Discord and Mongo to answer at all.
 */

assert.deepStrictEqual(
	roleConnectionPayload({
		githubUsername: "churrascooo",
		isSponsor: true,
		isContributor: true,
	}),
	{
		platform_name: "Dungeon Blitz",
		platform_username: "churrascooo",
		metadata: { is_sponsor: "1", contributor: "1" },
	},
	"a verified sponsor's payload carries both badges and the GitHub name",
);

// No GitHub link means no platform_username at all. The key is omitted rather than
// sent empty, because that is what the verification flow has always done.
const anonymousPayload = roleConnectionPayload({
	githubUsername: null,
	isSponsor: false,
	isContributor: false,
});
assert.deepStrictEqual(anonymousPayload, {
	platform_name: "Dungeon Blitz",
	metadata: { is_sponsor: "0", contributor: "0" },
});
assert.ok(
	!("platform_username" in anonymousPayload),
	"an unlinked player must not send an empty platform_username",
);

// A staff grant has to produce the exact sponsor value the verification flow sends,
// or the same sponsor ends up with two different badges depending on who granted it.
assert.equal(
	mergeRoleConnectionPayload({}, { isSponsor: true, githubUsername: "octocat" }).metadata
		.is_sponsor,
	roleConnectionPayload({
		githubUsername: "octocat",
		isSponsor: true,
		isContributor: false,
	}).metadata.is_sponsor,
	"a staff grant and a verification agree on the sponsor badge",
);

// The PUT replaces the whole connection, so anything the merge drops is gone from the
// player's profile. A key this deployment never registered still has to survive.
assert.deepStrictEqual(
	mergeRoleConnectionPayload(
		{ metadata: { is_sponsor: "0", contributor: "1", future_key: "keep me" } },
		{ isSponsor: true },
	).metadata,
	{ is_sponsor: "1", contributor: "1", future_key: "keep me" },
	"unknown metadata keys survive, and only the sponsor key is rewritten",
);

// The contributor badge belongs to the verification flow. A staff role change knows
// nothing about it, so it must leave the stored value standing rather than zero it.
assert.equal(
	mergeRoleConnectionPayload(
		{ metadata: { contributor: "1" } },
		{ isSponsor: true },
	).metadata.contributor,
	"1",
	"granting the sponsor role does not reset an existing contributor badge",
);

// An explicit stored value still wins over whatever Discord was holding.
assert.equal(
	mergeRoleConnectionPayload(
		{ metadata: { contributor: "1" } },
		{ isSponsor: true, isContributor: false },
	).metadata.contributor,
	"0",
	"a known contributor value overrides the stored connection",
);

// Removing the sponsor role has to clear the badge, not leave it lit.
assert.equal(
	mergeRoleConnectionPayload(
		{ metadata: { is_sponsor: "1", contributor: "1" } },
		{ isSponsor: false },
	).metadata.is_sponsor,
	"0",
	"removing the role clears the sponsor badge",
);

// The GitHub name is already on the connection from verification; a staff push with
// nothing stored must not blank it out.
assert.equal(
	mergeRoleConnectionPayload(
		{ platform_username: "octocat", metadata: {} },
		{ isSponsor: true },
	).platform_username,
	"octocat",
	"the stored connection's platform_username is reused when the profile has no GitHub name",
);

assert.equal(
	mergeRoleConnectionPayload({ platform_username: "octocat" }, { isSponsor: true })
		.platform_name,
	"Dungeon Blitz",
	"the platform name always comes from this application, not from stored data",
);

// Discord answers with whatever it stored, which need not be an object of strings.
for (const junk of [null, undefined, "nope", ["a"], { is_sponsor: 1 }]) {
	assert.doesNotThrow(
		() => mergeRoleConnectionPayload({ metadata: junk }, { isSponsor: true }),
		`unusable metadata (${JSON.stringify(junk)}) is ignored instead of thrown on`,
	);
}

assert.deepStrictEqual(
	mergeRoleConnectionPayload({}, { isSponsor: true }).metadata,
	{ is_sponsor: "1", contributor: "0" },
	"with no prior connection the known keys are written from scratch",
);

console.log("sponsor-role metadata push ok");
