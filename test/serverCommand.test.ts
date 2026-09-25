import assert from "node:assert/strict";
import { buildServerControlContainer, describeRunningServer } from "../src/commands/server.js";
import type { CloudBranch, GameServerState } from "../src/utils/gameServerDeploy.js";

// The container is the whole feature, and its shape is what Discord renders. Each assertion
// here is something an administrator would notice breaking: the running commit, the branch
// list, which branch is preselected, and the button ids the handlers parse.

const COMMIT = "b2e0728c89b9c899679ae1bc81712afd0ece1578";

function state(overrides: Partial<GameServerState> = {}): GameServerState {
	return {
		repo: "/home/USER/dungeon-blitz-r",
		pm2App: "dungeon-mp",
		deployBranch: "main",
		checkoutBranch: "release/2026-10-02",
		commit: COMMIT,
		shortCommit: "b2e0728",
		commitSubject: "feat: operator log channel for game server lifecycle",
		commitAt: "2026-09-25T00:00:00.000Z",
		buildCommit: COMMIT,
		dirty: false,
		hold: false,
		uptimeSeconds: 3_600,
		onlinePlayers: 3,
		pendingRestart: null,
		...overrides,
	};
}

function branches(names: string[], currentName = "main"): CloudBranch[] {
	return names.map((name, index) => ({
		name,
		commit: String(index).repeat(40).slice(0, 40),
		shortCommit: `c${index}`.padEnd(7, "0"),
		current: name === currentName,
	}));
}

type Component = Record<string, any>;

function componentsOf(container: ReturnType<typeof buildServerControlContainer>): Component[] {
	return (container.toJSON() as unknown as { components: Component[] }).components;
}

function findSelect(components: Component[]): Component {
	for (const component of components) {
		if (component.type === 1) {
			const child = (component.components as Component[]).find((entry) => entry.type === 3);
			if (child) return child;
		}
	}
	throw new Error("no select menu was rendered");
}

function findButtons(components: Component[]): Component[] {
	return components
		.filter((component) => component.type === 1)
		.flatMap((row) => row.components as Component[])
		.filter((component) => component.type === 2);
}

function textOf(components: Component[]): string {
	return components
		.filter((component) => component.type === 10)
		.map((component) => String(component.content))
		.join("\n");
}

const branchList = branches(["main", "release/2026-10-02", "fix/mob-random-deaths"]);

// What the panel says about the running server.
function testRunningServerSummary(): void {
	const lines = describeRunningServer(state());
	const text = lines.join("\n");
	assert.match(text, /Running.*release\/2026-10-02.*b2e0728.*operator log channel/);
	assert.match(text, /Deploy branch.*main/);
	assert.match(text, /Build.*b2e0728/);
	assert.match(text, /Uptime.*1h 0m/);
	assert.match(text, /Online.*3/);
	assert.ok(!lines.some((line) => line.includes("maintenance hold")), "no warning without a hold");

	// A hold, local edits, and a stale build are the three states worth warning about.
	const warned = describeRunningServer(
		state({ hold: true, dirty: true, buildCommit: "0".repeat(40) }),
	).join("\n");
	assert.match(warned, /maintenance hold is set/);
	assert.match(warned, /local edits/);
	assert.match(warned, /running build is not the checked-out commit/);
}

// The list of cloud branches, which is the reason the command exists.
function testBranchMenu(): void {
	const container = buildServerControlContainer({
		state: state(),
		branches: branchList,
		branchCount: 3,
	});
	const components = componentsOf(container);

	assert.equal((container.toJSON() as unknown as Component).type, 17, "a Components V2 container");
	assert.match(textOf(components), /Cloud branches\*\* 3/);
	assert.equal(
		textOf(components).includes("showing the first"),
		false,
		"a list that fits says nothing about truncation",
	);

	const select = findSelect(components);
	assert.equal(select.custom_id, "server:branch");
	assert.deepEqual(
		(select.options as Component[]).map((option) => option.value),
		["main", "release/2026-10-02", "fix/mob-random-deaths"],
	);
	assert.equal(
		(select.options as Component[]).filter((option) => option.default).length,
		1,
		"exactly one branch is preselected",
	);
	// With nothing selected the running branch is the one under the cursor.
	assert.equal(
		((select.options as Component[]).find((option) => option.default) as Component).value,
		"release/2026-10-02",
	);
	assert.equal(
		((select.options as Component[]).find((option) => option.value === "main") as Component)
			.description,
		"running now · commit c000000",
	);
}

// Discord allows 25 options; a 40-branch repository must still render, and say so.
function testBranchMenuTruncatesAtDiscordLimit(): void {
	const many = branches(
		Array.from({ length: 40 }, (_, index) => `feature/branch-${String(index).padStart(2, "0")}`),
	);
	const components = componentsOf(
		buildServerControlContainer({ state: state(), branches: many, branchCount: many.length }),
	);
	const select = findSelect(components);
	assert.equal((select.options as Component[]).length, 25);
	assert.match(textOf(components), /Cloud branches\*\* 40 \(showing the first 25\)/);
}

// Restarting to the selected branch is two buttons, and they carry the branch name.
function testRestartButtons(): void {
	const container = buildServerControlContainer(
		{ state: state(), branches: branchList, branchCount: 3 },
		"fix/mob-random-deaths",
	);
	const buttons = findButtons(componentsOf(container));
	const ids = buttons.map((button) => button.custom_id);
	assert.deepEqual(ids, [
		"server:restart:60:fix/mob-random-deaths",
		"server:restart:0:fix/mob-random-deaths",
		"server:refresh:fix/mob-random-deaths",
	]);
	assert.match(String(buttons[0]!.label), /Restart to fix\/mob-random-deaths in 60s/);
	assert.equal(buttons[1]!.style, 4, "an immediate restart is the dangerous one");
	assert.equal(
		buttons.some((button) => button.custom_id === "server:cancel"),
		false,
		"nothing is scheduled, so there is nothing to cancel",
	);

	// A very long branch name must not push the label past Discord's 80-character cap, and it
	// cannot be a select option at all (Discord caps option values at 100).
	const longName = `release/${"x".repeat(120)}`;
	const longComponents = componentsOf(
		buildServerControlContainer(
			{ state: state(), branches: branches([longName]), branchCount: 1 },
			longName,
		),
	);
	for (const button of findButtons(longComponents)) {
		assert.ok(String(button.label).length <= 80, `${button.label} is too long for Discord`);
	}
	assert.equal(
		longComponents.some(
			(component) =>
				component.type === 1 &&
				(component.components as Component[]).some((entry) => entry.type === 3),
		),
		false,
		"a 128-character branch name cannot be rendered as a select option",
	);
	assert.match(textOf(longComponents), /longer than Discord's select menu allows/);
}

// A scheduled restart is visible on the panel, with the way to call it off.
function testPendingRestartIsShown(): void {
	const container = buildServerControlContainer({
		state: state({
			pendingRestart: {
				branch: "main",
				commit: COMMIT,
				seconds: 60,
				requestedAt: "2026-09-25T03:00:00.000Z",
				restartAt: "2026-09-25T03:01:00.000Z",
				recipients: 2,
				requestedBy: "1447954255452311695",
			},
		}),
		branches: branchList,
		branchCount: 3,
	});
	const components = componentsOf(container);
	assert.match(textOf(components), /Restart to `main` scheduled/);
	assert.match(textOf(components), /2 players warned/);
	assert.match(textOf(components), /requested by 1447954255452311695/);
	assert.equal(
		findButtons(components).some((button) => button.custom_id === "server:cancel"),
		true,
		"a scheduled restart offers the cancel button",
	);

	// A restart with nobody online says so rather than claiming a warning went out.
	const empty = buildServerControlContainer({
		state: state({
			pendingRestart: {
				branch: "main",
				commit: COMMIT,
				seconds: 0,
				requestedAt: "2026-09-25T03:00:00.000Z",
				restartAt: "2026-09-25T03:00:00.000Z",
				recipients: 0,
				requestedBy: null,
			},
		}),
		branches: branchList,
		branchCount: 3,
	});
	assert.match(textOf(componentsOf(empty)), /no players were connected/);
}

// A dead game server still renders a panel that explains itself.
function testUnreachableServerStillRenders(): void {
	const container = buildServerControlContainer({
		state: null,
		branches: [],
		branchCount: 0,
		stateError: "Game server rejected the game server's deploy state (503): Discord admin API is not configured",
		branchesError: "fetch failed",
	});
	const components = componentsOf(container);
	const text = textOf(components);
	assert.match(text, /The game server did not answer/);
	assert.match(text, /503/);
	assert.match(text, /Cloud branches unavailable/);
	assert.equal(
		components.some((component) => component.type === 1 && (component.components as Component[]).some((entry) => entry.type === 3)),
		false,
		"no branch menu without branches",
	);
	const buttons = findButtons(components);
	assert.deepEqual(
		buttons.slice(0, 2).map((button) => button.disabled),
		[true, true],
		"both restart buttons are disabled without a branch to restart to",
	);
	assert.notEqual(buttons[2]!.disabled, true, "refresh stays available");
	assert.equal((container.toJSON() as unknown as Component).accent_color, 0xe74c3c);
}

// A notice is how the outcome of a restart is reported back on the same panel.
function testNoticeIsRendered(): void {
	const components = componentsOf(
		buildServerControlContainer(
			{ state: state(), branches: branchList, branchCount: 3 },
			"main",
			"✅ **Restart to `main` scheduled in 60s** (warned **2** connected players).",
		),
	);
	assert.match(textOf(components), /Restart to `main` scheduled in 60s/);
	assert.match(textOf(components), /Running/);
}

function testHoldAccentWarns(): void {
	const container = buildServerControlContainer({
		state: state({ hold: true }),
		branches: branchList,
		branchCount: 3,
	});
	assert.equal((container.toJSON() as unknown as Component).accent_color, 0xf39c12);
}

testRunningServerSummary();
testBranchMenu();
testBranchMenuTruncatesAtDiscordLimit();
testRestartButtons();
testPendingRestartIsShown();
testUnreachableServerStillRenders();
testNoticeIsRendered();
testHoldAccentWarns();

console.log("serverCommand.test: ok");
