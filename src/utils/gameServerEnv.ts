/**
 * The game server's `.env` routes, as seen from the bot (`/env`).
 *
 * The game server owns every rule: which keys are secrets (never sent here, never settable),
 * which ones the restart's shell or node act on (not settable), what a value may contain, and
 * whether the running server still differs from the file. The bot only shows the answer, so a
 * secret cannot leak through Discord because it never reaches the bot.
 *
 * A change is written to `src/server/.env` at once but applies at the next restart; every
 * answer says whether one is owed.
 */
import {
	fetchGameServerAdmin,
	requestGameServerAdmin,
} from "./gameMaintenance.js";

/** `same`, `differs` (the next restart changes it) or `unset` (neither the file nor the server has it). */
export type EnvRunningState = "same" | "differs" | "unset";

export type EnvEntry = {
	key: string;
	inFile: boolean;
	/** Null for a secret, and for a key the file does not have. */
	value: string | null;
	secret: boolean;
	editable: boolean;
	reason?: string;
	running: EnvRunningState;
	/** What the server runs with, when it differs and is not a secret. */
	runningValue?: string | null;
};

export type GameServerEnv = {
	path: string;
	exists: boolean;
	deployBranch: string;
	restartPending: boolean;
	entries: EnvEntry[];
};

export type EnvChange = {
	key: string;
	action: "set" | "clear";
	previous: string | null;
	previousHidden: boolean;
	value: string;
	changed: boolean;
	added: boolean;
	removedDuplicates: number;
	restartRequired: boolean;
	running: EnvRunningState;
	known: boolean;
	deployBranch: string;
};

const ENV_ROUTE = "/api/admin/server/env";

export function fetchGameServerEnv(key?: string): Promise<GameServerEnv> {
	return fetchGameServerAdmin<GameServerEnv>(
		key ? `${ENV_ROUTE}?key=${encodeURIComponent(key)}` : ENV_ROUTE,
		key ? `the game server's ${key}` : "the game server's .env",
	);
}

export function changeGameServerEnv(options: {
	key: string;
	value?: string;
	clear?: boolean;
	requestedBy?: string;
}): Promise<{ ok: true } & EnvChange> {
	return requestGameServerAdmin<{ ok: true } & EnvChange>(
		ENV_ROUTE,
		{
			key: options.key,
			...(options.clear ? { clear: true } : { value: options.value ?? "" }),
			...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
		},
		`the change to ${options.key}`,
	);
}
