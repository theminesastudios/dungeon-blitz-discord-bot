import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	CommandContext,
	ContainerBuilder,
	IntegrationType,
	InteractionFlags,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
} from "@minesa-org/mini-interaction";
import { MessageFlags } from "discord-api-types/v10";
import type { MessageActionRowComponent } from "@minesa-org/mini-interaction";
import type {
	CommandInteraction,
	MessageComponentInteraction,
} from "@minesa-org/mini-interaction";
import { isAdministrator, interactionDiscordId } from "../utils/discordInteractions.js";
import { errorMessage, formatDuration, logInfo, logWarn, logError, startTimer } from "../utils/logger.js";
import {
	fetchGameServerBranches,
	fetchGameServerState,
	cancelGameServerRestart,
	restartGameServer,
	type CloudBranch,
	type GameServerState,
} from "../utils/gameServerDeploy.js";

/**
 * `/server` — the operator's view of the live game server.
 *
 * One container holds everything an administrator needs to decide: what is running and how
 * long it has been up, every branch the VM can pull, and the two ways to restart onto the
 * selected one (with the one-minute player warning, or immediately). The branch menu is the
 * point of the command: switching the deployed branch used to be an ssh session and a
 * memorised pm2 incantation, and the branch names were whatever the operator happened to
 * remember.
 *
 * The panel is ephemeral and administrator-only, because restarting disconnects everyone.
 */

const BRANCH_SELECT_ID = "server:branch";
const RESTART_BUTTON_PREFIX = "server:restart:";
const REFRESH_BUTTON_PREFIX = "server:refresh:";
const CANCEL_BUTTON_ID = "server:cancel";

/** Discord allows 25 options in one select menu; more branches need a second page, not a bug. */
const MAX_BRANCH_OPTIONS = 25;
/** A select option's label and value both cap at 100 characters — git refs do not. */
const MAX_OPTION_LENGTH = 100;
const PANEL_ACCENT = 0x5865f2;
const PANEL_ERROR_ACCENT = 0xe74c3c;
const PANEL_WARN_ACCENT = 0xf39c12;

const CONTAINER_FLAGS = MessageFlags.IsComponentsV2;
const CONTAINER_EPHEMERAL_FLAGS = (
	MessageFlags.IsComponentsV2 | InteractionFlags.Ephemeral
) as MessageFlags;

export const DEFAULT_RESTART_SECONDS = 60;

export type ServerPanelView = {
	state: GameServerState | null;
	branches: CloudBranch[];
	/** Branches origin has, which can exceed the 25 the select menu can show. */
	branchCount: number;
	stateError?: string;
	branchesError?: string;
};

function shortCommit(value: string | null | undefined): string {
	const text = String(value ?? "").trim();
	return text ? text.slice(0, 7) : "unknown";
}

function timestamp(iso: string | null | undefined): string | null {
	const parsed = Date.parse(String(iso ?? ""));
	return Number.isFinite(parsed) ? `<t:${Math.floor(parsed / 1000)}:R>` : null;
}

/** Everything an operator should know before pressing a restart button. */
export function describeRunningServer(state: GameServerState): string[] {
	const lines = [
		`**Running** \`${state.checkoutBranch}\` · \`${shortCommit(state.commit)}\`${state.commitSubject ? ` — ${state.commitSubject}` : ""}`,
		`**Deploy branch** \`${state.deployBranch}\` · **Build** \`${shortCommit(state.buildCommit)}\` · **Uptime** ${formatDuration(state.uptimeSeconds)} · **Online** ${state.onlinePlayers}`,
	];
	const warnings: string[] = [];
	if (state.hold) {
		warnings.push("🛑 a maintenance hold is set — a restart will not switch branches until it is released");
	}
	// Worth saying out loud: the branch a restart pulls is not always the one checked out.
	if (state.deployBranch && state.checkoutBranch && state.deployBranch !== state.checkoutBranch) {
		warnings.push(
			`⚠️ a restart deploys \`${state.deployBranch}\`, not the checked-out \`${state.checkoutBranch}\``,
		);
	}
	if (state.dirty) {
		warnings.push("⚠️ the server checkout has local edits");
	}
	if (state.buildCommit && state.commit && state.buildCommit !== state.commit) {
		warnings.push("⚠️ the running build is not the checked-out commit");
	}
	for (const warning of warnings) {
		lines.push(`-# ${warning}`);
	}
	return lines;
}

export function describePendingRestart(state: GameServerState): string | null {
	const pending = state.pendingRestart;
	if (!pending) return null;
	const when = timestamp(pending.restartAt);
	const warned = pending.recipients === 0
		? "no players were connected"
		: `${pending.recipients} player${pending.recipients === 1 ? "" : "s"} warned`;
	return [
		`⏳ **Restart to \`${pending.branch}\` scheduled** ${when ?? pending.restartAt}`,
		`-# ${shortCommit(pending.commit)} · ${warned}${pending.requestedBy ? ` · requested by ${pending.requestedBy}` : ""}`,
	].join("\n");
}

function buildBranchSelectRow(
	branches: CloudBranch[],
	selectedBranch: string,
): ActionRowBuilder<MessageActionRowComponent> | null {
	if (branches.length === 0) return null;
	const options = branches.slice(0, MAX_BRANCH_OPTIONS);
	const select = new StringSelectMenuBuilder()
		.setCustomId(BRANCH_SELECT_ID)
		.setPlaceholder("Select a cloud branch to restart onto…")
		.setMinValues(1)
		.setMaxValues(1)
		.setOptions(
			options.map((branch) => {
				const description = [
					branch.current ? "running now" : null,
					branch.shortCommit ? `commit ${branch.shortCommit}` : "not on origin",
				]
					.filter(Boolean)
					.join(" · ");
				return new StringSelectMenuOptionBuilder()
					.setLabel(branch.name.slice(0, MAX_OPTION_LENGTH))
					.setValue(branch.name)
					.setDescription(description.slice(0, MAX_OPTION_LENGTH))
					.setDefault(branch.name === selectedBranch);
			}),
		);
	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(select);
}

function buildButtonRow(
	selectedBranch: string,
	hasPendingRestart: boolean,
	canRestart: boolean,
): ActionRowBuilder<MessageActionRowComponent> {
	// Discord caps button labels at 80 characters and branch names can run to 120.
	const restartWarned = new ButtonBuilder()
		.setLabel(`Restart to ${selectedBranch} in ${DEFAULT_RESTART_SECONDS}s`.slice(0, 80))
		.setStyle(ButtonStyle.Primary)
		.setCustomId(`${RESTART_BUTTON_PREFIX}${DEFAULT_RESTART_SECONDS}:${selectedBranch}`)
		.setDisabled(!canRestart);
	const restartNow = new ButtonBuilder()
		.setLabel("Restart now")
		.setStyle(ButtonStyle.Danger)
		.setCustomId(`${RESTART_BUTTON_PREFIX}0:${selectedBranch}`)
		.setDisabled(!canRestart);
	const refresh = new ButtonBuilder()
		.setLabel("Refresh")
		.setStyle(ButtonStyle.Secondary)
		.setCustomId(`${REFRESH_BUTTON_PREFIX}${selectedBranch}`);

	const row = new ActionRowBuilder<MessageActionRowComponent>().addComponents(
		restartWarned,
		restartNow,
		refresh,
	);
	if (hasPendingRestart) {
		row.addComponents(
			new ButtonBuilder()
				.setLabel("Cancel scheduled restart")
				.setStyle(ButtonStyle.Secondary)
				.setCustomId(CANCEL_BUTTON_ID),
		);
	}
	return row;
}

/**
 * Pure on purpose: the container is the whole feature, and the shapes pinned in the test are
 * the ones Discord renders.
 */
export function buildServerControlContainer(
	view: ServerPanelView,
	selectedBranch?: string,
	notice?: string,
): ContainerBuilder {
	const state = view.state;
	const accent = view.stateError
		? PANEL_ERROR_ACCENT
		: state?.hold || state?.dirty
			? PANEL_WARN_ACCENT
			: PANEL_ACCENT;
	const container = new ContainerBuilder().setAccentColor(accent);

	const header: string[] = ["## 🖥️ Dungeon Blitz server"];
	if (notice) header.push("", notice);
	if (state) {
		header.push("", ...describeRunningServer(state));
		const pending = describePendingRestart(state);
		if (pending) header.push("", pending);
	} else {
		header.push(
			"",
			`⚠️ **The game server did not answer:** ${view.stateError ?? "unknown error"}`,
		);
	}
	container.addComponent(new TextDisplayBuilder().setContent(header.join("\n")));

	container.addComponent(
		new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);

	// A branch whose name is longer than a select option allows cannot be offered here; it is
	// counted and named as unavailable rather than dropped silently.
	const branches = view.branches.filter((branch) => branch.name.length <= MAX_OPTION_LENGTH);
	const unselectable = view.branches.length - branches.length;
	const shown = Math.min(branches.length, MAX_BRANCH_OPTIONS);
	const selected = selectedBranch && branches.some((branch) => branch.name === selectedBranch)
		? selectedBranch
		: state?.checkoutBranch ?? state?.deployBranch ?? branches[0]?.name ?? "";
	const listLines = view.branchesError
		? [`⚠️ **Cloud branches unavailable:** ${view.branchesError}`]
		: [
				`**Cloud branches** ${view.branchCount}${shown < view.branchCount ? ` (showing the first ${shown})` : ""}`,
				"-# Pick a branch, then restart onto it. Everyone connected is disconnected by a restart.",
			];
	if (!view.branchesError && branches.length === 0) {
		listLines.push("-# origin reported no branches — check the server's git credentials");
	}
	if (unselectable > 0) {
		listLines.push(
			`-# ${unselectable} branch name${unselectable === 1 ? " is" : "s are"} longer than Discord's select menu allows and cannot be chosen here`,
		);
	}
	container.addComponent(new TextDisplayBuilder().setContent(listLines.join("\n")));

	const selectRow = buildBranchSelectRow(branches, selected);
	if (selectRow) {
		container.addComponent(selectRow);
	}
	container.addComponent(buildButtonRow(selected, Boolean(state?.pendingRestart), Boolean(selected)));

	return container;
}

async function loadServerPanelView(): Promise<ServerPanelView> {
	// Both calls are independent and both are allowed to fail on their own: a dead game server
	// must still render a panel that says so, not an error message with no context.
	const [stateResult, branchesResult] = await Promise.allSettled([
		fetchGameServerState(),
		fetchGameServerBranches(),
	]);

	const view: ServerPanelView = {
		state: stateResult.status === "fulfilled" ? stateResult.value : null,
		branches: branchesResult.status === "fulfilled" ? branchesResult.value.branches : [],
		branchCount: branchesResult.status === "fulfilled" ? branchesResult.value.count : 0,
	};
	if (stateResult.status === "rejected") {
		view.stateError = errorMessage(stateResult.reason);
	}
	if (branchesResult.status === "rejected") {
		view.branchesError = errorMessage(branchesResult.reason);
	}
	return view;
}

async function handleOpen(
	interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
	if (!isAdministrator(interaction)) {
		return interaction.reply({
			content: "Administrator permission is required.",
			flags: InteractionFlags.Ephemeral,
		});
	}

	await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
	try {
		const view = await loadServerPanelView();
		return interaction.editReply({
			components: [buildServerControlContainer(view)],
			flags: CONTAINER_EPHEMERAL_FLAGS,
		});
	} catch (error) {
		logError("server", "panel_failed", { error: errorMessage(error) });
		return interaction.editReply({
			content: `The server panel could not be loaded: ${errorMessage(error)}`,
		});
	}
}

async function renderPanel(
	interaction: MessageComponentInteraction,
	options: { selectedBranch?: string; notice?: string } = {},
): Promise<unknown> {
	const view = await loadServerPanelView();
	return interaction.update({
		components: [buildServerControlContainer(view, options.selectedBranch, options.notice)],
		flags: CONTAINER_FLAGS,
	});
}

/** `server:restart:<seconds>:<branch>` — a git ref cannot contain ":", so the split is safe. */
function parseRestartPayload(customId: string): { seconds: number; branch: string } | null {
	const payload = customId.slice(RESTART_BUTTON_PREFIX.length);
	const separator = payload.indexOf(":");
	if (separator < 0) return null;
	const seconds = Number(payload.slice(0, separator));
	const branch = payload.slice(separator + 1).trim();
	if (!Number.isInteger(seconds) || seconds < 0 || !branch) return null;
	return { seconds, branch };
}

async function handleRestart(
	interaction: MessageComponentInteraction,
	seconds: number,
	branch: string,
): Promise<unknown> {
	if (!isAdministrator(interaction)) {
		return interaction.reply({
			content: "Administrator permission is required.",
			flags: InteractionFlags.Ephemeral,
		});
	}

	const discordId = interactionDiscordId(interaction) || "unknown";
	const elapsed = startTimer();
	try {
		const result = await restartGameServer({
			branch,
			seconds,
			requestedBy: discordId,
		});
		const warnNotice = result.seconds > 0
			? `warned **${result.recipients}** connected player${result.recipients === 1 ? "" : "s"}`
			: "no warning was sent";
		const notice =
			result.seconds > 0
				? `✅ **Restart to \`${result.branch}\` scheduled in ${result.seconds}s** (${warnNotice}) — commit \`${shortCommit(result.commit)}\`.`
				: `✅ **Restart to \`${result.branch}\` requested now** (${warnNotice}) — commit \`${shortCommit(result.commit)}\`.`;
		logInfo("server", "restart_scheduled", {
			branch: result.branch,
			commit: shortCommit(result.commit),
			seconds: result.seconds,
			recipients: result.recipients,
			user: discordId,
			ms: elapsed(),
		});
		return renderPanel(interaction, { selectedBranch: branch, notice });
	} catch (error) {
		logWarn("server", "restart_failed", {
			branch,
			user: discordId,
			ms: elapsed(),
			error: errorMessage(error),
		});
		return renderPanel(interaction, {
			selectedBranch: branch,
			notice: `⚠️ **The restart was refused:** ${errorMessage(error)}`,
		});
	}
}

async function handleCancel(interaction: MessageComponentInteraction): Promise<unknown> {
	if (!isAdministrator(interaction)) {
		return interaction.reply({
			content: "Administrator permission is required.",
			flags: InteractionFlags.Ephemeral,
		});
	}

	try {
		const cancelled = await cancelGameServerRestart();
		logInfo("server", "restart_cancelled", {
			branch: cancelled.branch,
			user: interactionDiscordId(interaction),
		});
		return renderPanel(interaction, {
			notice: `↩️ Cancelled the scheduled restart to \`${cancelled.branch}\`.`,
		});
	} catch (error) {
		logWarn("server", "cancel_failed", { error: errorMessage(error) });
		return renderPanel(interaction, { notice: `⚠️ **Nothing was cancelled:** ${errorMessage(error)}` });
	}
}

export const serverCommand = {
	data: new CommandBuilder()
		.setContexts([CommandContext.Guild])
		.setIntegrationTypes([IntegrationType.GuildInstall])
		.setName("server")
		.setDescription("Show the game server's branch and restart it onto another one")
		.setDefaultMemberPermissions(8n)
		.setDMPermission(false),
	handler: (interaction: CommandInteraction) => handleOpen(interaction),
};

export const serverBranchSelectComponent = {
	customId: BRANCH_SELECT_ID,
	handler: (interaction: MessageComponentInteraction) => {
		const selected = interaction.getStringValues()[0];
		if (!selected) {
			return interaction.reply({
				content: "Select a branch first.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		return renderPanel(interaction, { selectedBranch: selected });
	},
};

export const serverRestartComponent = {
	// Trailing "*" registers this as a prefix handler.
	customId: `${RESTART_BUTTON_PREFIX}*`,
	handler: (interaction: MessageComponentInteraction) => {
		const parsed = parseRestartPayload(interaction.data.custom_id);
		if (!parsed) {
			return interaction.reply({
				content: "That restart button is no longer valid — run `/server` again.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		return handleRestart(interaction, parsed.seconds, parsed.branch);
	},
};

export const serverRefreshComponent = {
	customId: `${REFRESH_BUTTON_PREFIX}*`,
	handler: (interaction: MessageComponentInteraction) =>
		renderPanel(interaction, { selectedBranch: interaction.data.custom_id.slice(REFRESH_BUTTON_PREFIX.length) }),
};

export const serverCancelComponent = {
	customId: CANCEL_BUTTON_ID,
	handler: (interaction: MessageComponentInteraction) => handleCancel(interaction),
};
