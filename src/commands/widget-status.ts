import { CommandBuilder } from "@minesa-org/mini-interaction";
import type {
	AutocompleteContext,
	CommandInteraction,
} from "@minesa-org/mini-interaction";
import { getPlayerProfile, searchPlayers } from "../utils/gameWallet.js";
import { getGameAccountByDiscordId } from "../utils/gameAccount.js";
import { isAdministrator, interactionDiscordId } from "../utils/discordInteractions.js";
import {
	APPLICATION_IDENTITIES_WRITE_SCOPE,
	checkGameStatsAccess,
	getApplicationIdentityProfile,
	listApplicationIdentities,
	resolveWidgetScopeEnabled,
	type ApplicationIdentity,
	type ApplicationIdentityProfile,
} from "../utils/gameStatsProfile.js";
import { syncGameStatsForDiscordId, type GameStatsSyncResult } from "../utils/gameStatsSync.js";

/**
 * Operator tool: answers "why is this player's Game Stats widget empty, and why will the profile
 * not save?" from the gates Discord puts in front of it, instead of guessing.
 *
 * Every gate is checked and reported separately, because they look identical from the player's
 * side and are fixed in completely different places:
 *
 * 1. Discord has to approve the *application* for game stats (per app, not per player).
 * 2. The game server's `WIDGET_SCOPE_ENABLED` switch has to be on, or no link ever asks for
 *    `application_identities.write` and the bot can never write a widget.
 * 3. The player has to have authorized that scope, which is what creates the identity record.
 * 4. The bot has to have written data to that record — or the widget only shows the portal's
 *    sample/fallback data.
 *
 * Each check is isolated: one unreachable dependency reports itself and the rest still answer.
 */

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function oneLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The one fix each application-level state needs. They all look the same to the player and are
 * fixed in completely different places, so naming the wrong one sends the operator to the wrong
 * console — which is worse than saying "could not check". Returns null when nothing is blocking.
 */
function accessFix(state: string): string | null {
	switch (state) {
		case "authorized":
			return null;
		case "not-enabled":
			return "Discord does not expose the game-stats routes for this application at all: enable the Social SDK and claim the game in the Discord Developer Portal (game stats are approved per application).";
		case "not-authorized":
			return "Discord answered 403: the routes exist but the application is not authorized for game stats. Turn game stats on for the application in the Discord Developer Portal.";
		case "bad-credentials":
			return "Discord rejected the application credentials (401): check `DISCORD_BOT_TOKEN` in the bot deployment.";
		default:
			return "The application's game-stats access could not be checked; retry, and check the bot deployment's credentials and network.";
	}
}

/** The gate that stops the widget right now, in the order the operator has to clear it. */
export function nextSteps(input: {
	accessState: string;
	widgetScopeEnabled: boolean;
	player?: { payloadFields: number; storedFields: number | null };
}): string[] {
	const access = accessFix(input.accessState);
	if (access) return [access];

	const steps: string[] = [];
	if (!input.widgetScopeEnabled) {
		steps.push(
			"Set `WIDGET_SCOPE_ENABLED=1` on the game server and restart it, or every link keeps asking for account scopes only."
		);
	}
	steps.push(
		"Have the player run `/authorize connection:widget` — that link is what grants `" +
			APPLICATION_IDENTITIES_WRITE_SCOPE +
			"` and publishes their profile immediately."
	);
	if (
		input.widgetScopeEnabled &&
		input.player &&
		input.player.payloadFields > 0 &&
		input.player.storedFields === 0
	) {
		steps.push(
			"Discord has no data for them yet — once they hold the scope, run the sync (`POST /api/game-stats/sync` with their `discordId`)."
		);
	}
	steps.push(
		"Publish the widget in the portal (Widget Top, Widget Bottom and Add Widget Preview configured) — a draft can only be added by developer-team members."
	);
	steps.push(
		"Then the player adds it: profile → **Add Widget** → **Dungeon Blitz** → **Add to profile**, and saves."
	);
	return steps;
}

/** The account half of the report, gathered from the database and Discord. */
export type WidgetPlayerInput = {
	userId: number;
	discordId: string;
	connections: readonly string[];
	widgetState: string | null;
	/** The payload the sync would send, built with `dryRun` so nothing is written. */
	dryRun: Attempt<GameStatsSyncResult>;
	/** The identities Discord holds for this player. */
	identities: Attempt<ApplicationIdentity[]>;
	/** What Discord has stored for this player's save, if it can be read at all. */
	stored: Attempt<ApplicationIdentityProfile>;
};

function profileFieldCount(profile: ApplicationIdentityProfile | undefined): number {
	return (
		(profile?.data?.dynamic?.length ?? 0) + Object.keys(profile?.data?.primary ?? {}).length
	);
}

/**
 * Formats the player half. Pure on purpose: the useful part of this command is what it says
 * about a player's Discord state, and that has to be verifiable without a database or a bot
 * token to hand.
 */
export function playerReportLines(input: WidgetPlayerInput): {
	lines: string[];
	payloadFields: number;
	storedFields: number | null;
} {
	const lines: string[] = [
		`**Player** — game user **${input.userId}** · discord **${input.discordId}**`,
		`-# connections authorized: ${input.connections.length > 0 ? input.connections.join(", ") : "none yet"} · last widget sync: ${input.widgetState ?? "never"}`,
	];

	let payloadFields = 0;
	if (input.dryRun.ok) {
		const payload = input.dryRun.value.payload;
		payloadFields = profileFieldCount({ username: payload?.username, data: payload?.data });
		lines.push(
			`-# payload we would send: **${payloadFields}** field(s)${payload?.username ? ` · username **${oneLine(payload.username)}**` : ""} · outcome \`${input.dryRun.value.outcome}\``
		);
	} else {
		lines.push(`-# payload could not be built: ${oneLine(input.dryRun.error)}`);
	}

	if (input.identities.ok) {
		lines.push(
			`-# Discord identities: ${input.identities.value.length > 0 ? input.identities.value.map((entry) => `${entry.provider_type}/${entry.provider_issued_user_id}`).join(", ") : "none — nothing has been linked yet"}`
		);
	} else {
		lines.push(`-# Discord identities: ${oneLine(input.identities.error)}`);
	}

	let storedFields: number | null = null;
	if (input.stored.ok) {
		storedFields = profileFieldCount(input.stored.value);
		lines.push(
			storedFields > 0
				? `-# stored profile: **${storedFields}** field(s) · username \`${oneLine(input.stored.value.username) || "unset"}\``
				: "-# stored profile: **empty** — Discord has no game stats for this player, so the widget only shows the portal's sample/fallback data."
		);
	} else {
		lines.push(`-# stored profile: ${oneLine(input.stored.error)}`);
	}

	return { lines, payloadFields, storedFields };
}

export const widgetStatusCommand = {
	data: new CommandBuilder()
		.setName("widget-status")
		.setDescription("Check what is blocking a player's Dungeon Blitz profile widget")
		.setDefaultMemberPermissions(8n)
		.setDMPermission(false)
		.addStringOption((option) =>
			option
				.setName("player")
				.setDescription("Inspect this player (leave empty for the application-level checks only)")
				.setAutocomplete(true)
				.setRequired(false)
		),
	handler: async (interaction: CommandInteraction) => {
		if (!isAdministrator(interaction)) {
			return interaction.reply({
				content: "Administrator permission is required.",
				flags: 64,
			});
		}

		const selector = interaction.options.getString("player", false)?.trim() ?? "";
		interaction.deferReply({ flags: 64 });

		const sections: string[] = [];

		// Resolve the player first: everything below is reported for them when asked, and the
		// application-level probes only need a well-formed snowflake, not a real player.
		let account: Awaited<ReturnType<typeof getGameAccountByDiscordId>> = null;
		let lookupError = "";
		if (selector) {
			try {
				const discordId = selector.startsWith("profile:")
					? selector.slice("profile:".length).trim()
					: ((await getPlayerProfile(selector))?.discordUserId ?? "");
				if (!discordId) {
					return interaction.editReply({
						content:
							"That player has no linked Discord profile, so their widget cannot be inspected.",
					});
				}
				account = await getGameAccountByDiscordId(discordId);
			} catch (error) {
				lookupError = error instanceof Error ? error.message : String(error);
			}
		}

		const probeId = account?.discordId || interactionDiscordId(interaction);

		// 1. Does Discord allow this application to read and write game stats at all?
		let accessState = "unknown";
		const access = await attempt(() => checkGameStatsAccess({ discordUserId: probeId }));
		if (access.ok) {
			accessState = access.value.state;
			sections.push(
				`**Discord application** — \`${access.value.state}\` (HTTP ${access.value.status ?? "—"})`,
				`-# ${oneLine(access.value.summary)}`
			);
		} else {
			sections.push(
				"**Discord application** — could not be checked",
				`-# ${oneLine(access.error)}`
			);
		}

		// 2. The one switch that decides whether a link can ask for the write scope.
		const widgetScopeEnabled = await resolveWidgetScopeEnabled();
		sections.push(
			`**Game server widget switch** — ${widgetScopeEnabled ? "on ✅" : "off ❌"}`,
			widgetScopeEnabled
				? "-# `/authorize` asks for `application_identities.write`, so players can grant the widget access."
				: "-# `/authorize` asks for account scopes only, so **no player can grant the widget access** and nothing can be written to a widget."
		);

		// 3/4. The player's own half: what Discord holds, and what we would send.
		let payloadFields = 0;
		let storedFields: number | null = null;
		if (selector && account) {
			const player = account;
			const report = playerReportLines({
				userId: player.userId,
				discordId: player.discordId,
				connections: player.connections,
				widgetState: player.widgetState,
				// Building the payload in dry-run mode also proves the save is readable at all.
				dryRun: await attempt(() =>
					syncGameStatsForDiscordId(player.discordId, { dryRun: true })
				),
				identities: await attempt(() =>
					listApplicationIdentities({ discordUserId: player.discordId })
				),
				stored: await attempt(() =>
					getApplicationIdentityProfile({
						discordUserId: player.discordId,
						providerIssuedUserId: player.userId,
					})
				),
			});
			payloadFields = report.payloadFields;
			storedFields = report.storedFields;
			sections.push(report.lines.join("\n"));
		} else if (selector && !account && !lookupError) {
			sections.push(
				`**Player** — no game account is linked for **${oneLine(selector)}**, so nothing can be written to their widget. Run **/account create** first.`
			);
		} else if (lookupError) {
			sections.push(`**Player lookup** — ${oneLine(lookupError)}`);
		}

		const steps = nextSteps({
			accessState,
			widgetScopeEnabled,
			player: selector && account ? { payloadFields, storedFields } : undefined,
		});
		sections.push(
			`**Do this next**\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`
		);

		return interaction.editReply({
			content: sections.join("\n\n").slice(0, 1900),
		});
	},
};

export async function handleWidgetStatusAutocomplete(autocomplete: AutocompleteContext) {
	const focused = autocomplete.getFocusedOption();
	if (!focused || focused.name !== "player") {
		autocomplete.respond([]);
		return;
	}

	try {
		// Writes are addressed by Discord id, so only linked profiles can be inspected.
		const players = (await searchPlayers(String(focused.value ?? ""))).filter((player) =>
			player.selector.startsWith("profile:")
		);
		autocomplete.respond(
			players.map((player) => ({
				name: player.label.slice(0, 100),
				value: player.selector,
			}))
		);
	} catch (error) {
		console.error("[widget-status] Autocomplete failed:", error);
		autocomplete.respond([]);
	}
}
