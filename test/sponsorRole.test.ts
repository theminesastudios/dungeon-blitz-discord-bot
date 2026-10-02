import assert from "node:assert/strict";

// The admin command module pulls in the database layer, which needs Mongo env
// vars at import time; the payload test only needs the builders, so point the
// constructor at a dummy URI like the other env-dependent tests do.
process.env.MONGODB_URI ??= "mongodb://localhost:27017/test";

const { adminCommand } = await import("../src/commands/admin.js");

// Command payloads are validated by CommandBuilder as they are built, so importing the
// module is half the check: a bad option name or an over-long description throws here.
const adminPayload = adminCommand.data.toJSON() as {
	name: string;
	options?: Array<{
		name: string;
		description: string;
		options?: Array<{
			name: string;
			required?: boolean;
			choices?: Array<{ name: string; value: string }>;
		}>;
	}>;
};

const sponsorRole = adminPayload.options?.find(
	(option) => option.name === "sponsor-role",
);
assert.ok(sponsorRole, "the admin command must offer the sponsor-role subcommand");
assert.ok(
	sponsorRole!.description.length <= 100,
	"Discord allows 100 characters for a description",
);

const userOption = sponsorRole!.options?.find((option) => option.name === "user");
assert.ok(userOption, "the sponsor-role subcommand must take a user");
assert.equal(
	userOption!.required,
	false,
	"the user option is optional when a github_username resolves the member",
);

const githubOption = sponsorRole!.options?.find(
	(option) => option.name === "github_username",
);
assert.ok(
	githubOption,
	"the sponsor-role subcommand must accept a github_username",
);
assert.equal(githubOption!.required, false);

const modeOption = sponsorRole!.options?.find((option) => option.name === "mode");
assert.ok(modeOption, "the sponsor-role subcommand must offer a mode");
assert.equal(modeOption!.required, false, "granting is the default");
assert.deepEqual(
	modeOption!.choices?.map((choice) => choice.value),
	["grant", "remove"],
);

// The handler is reachable through the admin dispatcher's import graph; if the
// import of sponsor-role.js were broken the module above would have thrown.
console.log("sponsor-role wiring ok");
