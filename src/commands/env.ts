import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	ContainerBuilder,
	InteractionFlags,
	TextDisplayBuilder,
} from "@minesa-org/mini-interaction";
import { MessageFlags } from "discord-api-types/v10";
import type { CommandInteraction, MessageActionRowComponent } from "@minesa-org/mini-interaction";
import { isAdministrator, interactionDiscordId } from "../utils/discordInteractions.js";
import { errorMessage, logInfo, logWarn } from "../utils/logger.js";
import {
	changeGameServerEnv,
	fetchGameServerEnv,
	type EnvChange,
	type EnvEntry,
	type GameServerEnv,
} from "../utils/gameServerEnv.js";
import {
	DEFAULT_RESTART_SECONDS,
	serverPanelButtonId,
	serverRestartButtonId,
} from "./server.js";

/**
 * `/env` — read and change the live game server's `.env` from Discord.
 *
 * On 2026-10-23 SERVER_LOGS=on and BUFF_RELAY_TRACE=1 were left on in the live `.env` and filled
 * the VM's disk; switching them off meant an ssh session and a hand edit. Now it is
 * `/env set SERVER_LOGS off` and a restart.
 *
 * Same gate as `/server` (administrators, ephemeral answers). The game server decides what may
 * change (core/envFileEdit.ts there): secrets are never sent here and cannot be set from here,
 * nor can the keys the restart's shell, git or node act on. A change applies at the next
 * restart, so the answer offers `/server`'s own restart button for the deploy branch.
 */

const ACCENT = 0x5865f2;
const WARN_ACCENT = 0xf39c12;
const ERROR_ACCENT = 0xe74c3c;
const CONTAINER_EPHEMERAL_FLAGS = (
	MessageFlags.IsComponentsV2 | InteractionFlags.Ephemeral
) as MessageFlags;
/** A text display holds 4000 characters; the list stops well before that. */
const MAX_VIEW_CHARS = 3_500;
const MAX_SHOWN_VALUE = 120;
/** Discord caps a custom id at 100 characters, and the restart id carries the branch. */
const MAX_CUSTOM_ID = 100;

/** A value as inline code. A backtick cannot be escaped inside one, so it is shown as ˋ. */
function code(value: string): string {
	const shown = value.length > MAX_SHOWN_VALUE ? `${value.slice(0, MAX_SHOWN_VALUE)}…` : value;
	return shown === "" ? "*(empty)*" : `\`${shown.replace(/`/g, "ˋ")}\``;
}

function describeEntry(entry: EnvEntry): string {
	const value = entry.secret
		? entry.inFile ? "•••• *(secret, hidden)*" : "*(not in .env)*"
		: entry.inFile ? code(entry.value ?? "") : "*(not in .env)*";
	const marks: string[] = [];
	if (!entry.editable) marks.push("🔒");
	let line = `**${entry.key}** ${value}${marks.length ? ` ${marks.join(" ")}` : ""}`;
	if (entry.running === "differs") {
		line += entry.secret
			? "\n-# ⏳ the running server has a different value — restart to apply"
			: `\n-# ⏳ running ${entry.runningValue === null || entry.runningValue === undefined ? "*(unset)*" : code(entry.runningValue)} — restart to apply`;
	}
	return line;
}

function restartRow(deployBranch: string): ActionRowBuilder<MessageActionRowComponent> | null {
	const restartId = serverRestartButtonId(DEFAULT_RESTART_SECONDS, deployBranch);
	const panelId = serverPanelButtonId(deployBranch);
	if (!deployBranch || restartId.length > MAX_CUSTOM_ID || panelId.length > MAX_CUSTOM_ID) {
		return null;
	}
	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(
		new ButtonBuilder()
			.setLabel(`Restart to ${deployBranch} in ${DEFAULT_RESTART_SECONDS / 60} min`.slice(0, 80))
			.setStyle(ButtonStyle.Primary)
			.setCustomId(restartId),
		new ButtonBuilder()
			.setLabel("Open /server")
			.setStyle(ButtonStyle.Secondary)
			.setCustomId(panelId),
	);
}

/** Pure, like the `/server` panel: the container is what the test pins. */
export function buildEnvViewContainer(env: GameServerEnv, onlyKey?: string): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(env.restartPending ? WARN_ACCENT : ACCENT);
	const lines: string[] = ["## ⚙️ Game server .env"];
	if (!env.exists) {
		lines.push("", `⚠️ There is no .env at \`${env.path}\` — the first \`/env set\` creates it.`);
	}

	const body: string[] = [];
	let omitted = 0;
	let length = lines.join("\n").length;
	for (const entry of env.entries) {
		const line = describeEntry(entry);
		if (length + line.length + 1 > MAX_VIEW_CHARS) {
			omitted += 1;
			continue;
		}
		body.push(line);
		length += line.length + 1;
	}
	if (body.length > 0) lines.push("", ...body);
	if (omitted > 0) {
		lines.push(`-# …and ${omitted} more — \`/env view key\` shows one key`);
	}
	if (!onlyKey && env.entries.length === 0 && env.exists) {
		lines.push("", "The .env has no settings.");
	}
	lines.push(
		"",
		`-# \`${env.path}\` · 🔒 cannot be changed from Discord (secrets, and keys the restart's shell or node act on)`,
	);
	if (env.restartPending) {
		lines.push("-# ⏳ the running server differs from .env — a restart applies it");
	}
	container.addComponent(new TextDisplayBuilder().setContent(lines.join("\n")));
	const row = env.restartPending ? restartRow(env.deployBranch) : null;
	if (row) container.addComponent(row);
	return container;
}

export function describeEnvChange(change: EnvChange): string[] {
	const lines: string[] = [];
	if (!change.changed) {
		lines.push(`✅ **${change.key}** is already ${code(change.value)} in .env — nothing was written.`);
	} else if (change.action === "clear") {
		lines.push(`✅ **${change.key}** cleared (now \`${change.key}=\`).`);
	} else {
		lines.push(`✅ **${change.key}** set to ${code(change.value)}.`);
	}
	if (change.changed) {
		const previous = change.previousHidden
			? "a hidden value"
			: change.previous === null ? "not in .env" : code(change.previous);
		lines.push(`-# was ${previous}${change.added ? " · new line added" : ""}${change.removedDuplicates > 0 ? ` · ${change.removedDuplicates} duplicate line${change.removedDuplicates === 1 ? "" : "s"} removed` : ""}`);
	}
	if (!change.known) {
		lines.push(
			`⚠️ \`${change.key}\` was not in .env, .env.example or the running environment — check the spelling. \`/env clear ${change.key}\` empties it again.`,
		);
	}
	lines.push(
		change.restartRequired
			? "⏳ **Applies at the next restart.** The running server still has the old value."
			: "-# The running server already has this value; no restart needed.",
	);
	return lines;
}

export function buildEnvChangeContainer(change: EnvChange): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(change.known ? ACCENT : WARN_ACCENT);
	container.addComponent(
		new TextDisplayBuilder().setContent(["## ⚙️ Game server .env", "", ...describeEnvChange(change)].join("\n")),
	);
	const row = change.restartRequired ? restartRow(change.deployBranch) : null;
	if (row) container.addComponent(row);
	return container;
}

function buildErrorContainer(title: string, error: unknown): ContainerBuilder {
	return new ContainerBuilder()
		.setAccentColor(ERROR_ACCENT)
		.addComponent(new TextDisplayBuilder().setContent(`⚠️ **${title}:** ${errorMessage(error)}`));
}

/** Keys are upper case on the game server; accept `server_logs` as a typing convenience. */
export function normalizeEnvKey(value: string | null | undefined): string {
	return String(value ?? "").trim().toUpperCase();
}

async function handleView(interaction: CommandInteraction): Promise<unknown> {
	const key = normalizeEnvKey(interaction.options.getString("key", false)) || undefined;
	await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
	try {
		const env = await fetchGameServerEnv(key);
		return interaction.editReply({ components: [buildEnvViewContainer(env, key)], flags: CONTAINER_EPHEMERAL_FLAGS });
	} catch (error) {
		logWarn("env", "view_failed", { key, user: interactionDiscordId(interaction), error: errorMessage(error) });
		return interaction.editReply({
			components: [buildErrorContainer("Could not read the .env", error)],
			flags: CONTAINER_EPHEMERAL_FLAGS,
		});
	}
}

async function handleChange(interaction: CommandInteraction, clear: boolean): Promise<unknown> {
	const key = normalizeEnvKey(interaction.options.getString("key", true));
	const value = clear ? undefined : String(interaction.options.getString("value", true) ?? "");
	const user = interactionDiscordId(interaction) || "unknown";
	await interaction.deferReply({ flags: InteractionFlags.Ephemeral });
	try {
		const change = await changeGameServerEnv({ key, value, clear, requestedBy: user });
		// The game server refuses secrets, so neither value here is one.
		logInfo("env", clear ? "cleared" : "set", {
			key,
			value: change.value,
			previous: change.previousHidden ? "(hidden)" : change.previous,
			changed: change.changed,
			restartRequired: change.restartRequired,
			user,
		});
		return interaction.editReply({ components: [buildEnvChangeContainer(change)], flags: CONTAINER_EPHEMERAL_FLAGS });
	} catch (error) {
		// No value in the log line: a refused value may be the secret someone pasted by mistake.
		logWarn("env", clear ? "clear_failed" : "set_failed", { key, user, error: errorMessage(error) });
		return interaction.editReply({
			components: [buildErrorContainer(`${key || "The key"} was not changed`, error)],
			flags: CONTAINER_EPHEMERAL_FLAGS,
		});
	}
}

export const envCommand = {
	data: new CommandBuilder()
		.setName("env")
		.setDescription("Read or change the game server's .env (applies at the next restart)")
		.setDefaultMemberPermissions(8n)
		.addSubcommand((sub) =>
			sub
				.setName("view")
				.setDescription("Show the .env's settings (secrets hidden) and what still needs a restart")
				.addStringOption((option) =>
					option.setName("key").setDescription("Only this key, e.g. SERVER_LOGS").setMaxLength(80).setRequired(false),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("set")
				.setDescription("Set a key in the .env, e.g. SERVER_LOGS off")
				.addStringOption((option) =>
					option.setName("key").setDescription("The key, e.g. SERVER_LOGS or BUFF_RELAY_TRACE").setMaxLength(80).setRequired(true),
				)
				.addStringOption((option) =>
					option.setName("value").setDescription("The new value (no secrets: those stay a VM edit)").setMaxLength(1000).setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("clear")
				.setDescription("Empty a key in the .env (KEY=), which a restart then applies")
				.addStringOption((option) =>
					option.setName("key").setDescription("The key to empty").setMaxLength(80).setRequired(true),
				),
		),
	handler: (interaction: CommandInteraction): Promise<unknown> => {
		if (!isAdministrator(interaction)) {
			logWarn("env", "refused", { user: interactionDiscordId(interaction) });
			return interaction.reply({
				content: "Administrator permission is required.",
				flags: InteractionFlags.Ephemeral,
			});
		}
		const subcommand = interaction.options.getSubcommand(false);
		if (subcommand === "view") return handleView(interaction);
		if (subcommand === "set") return handleChange(interaction, false);
		if (subcommand === "clear") return handleChange(interaction, true);
		return interaction.reply({ content: "Unknown subcommand.", flags: InteractionFlags.Ephemeral });
	},
};
