/**
 * The game server's deploy routes, as seen from the bot.
 *
 * `/server` in Discord is a shell over three calls the VM answers itself: what is running
 * (`/api/admin/server/state`), which branches it can pull (`/api/admin/server/branches`), and
 * a restart onto one of them (`/api/admin/server/restart`). The branch list in particular is
 * deliberately *not* a GitHub query: the VM answers with exactly the refs it can fetch with
 * the credentials it already deploys with, so the menu can never offer a branch the server
 * would fail to pull, and the bot needs no repository token to show it.
 *
 * The restart call answers as soon as the work is scheduled (202), not when the server is
 * back — the delay, the fetch and the pm2 restart happen inside a detached job on the VM.
 *
 * Transport, auth and rejection wording come from the shared admin helpers, so the branch
 * list is read with the same GET helper `/admin grant` uses for the game's content list and
 * a refusal reads the same whichever route produced it.
 */
import {
	fetchGameServerAdmin,
	requestGameServerAdmin,
} from "./gameMaintenance.js";

export type CloudBranch = {
	name: string;
	commit: string;
	shortCommit: string;
	current: boolean;
};

export type PendingRestart = {
	branch: string;
	commit: string | null;
	seconds: number;
	requestedAt: string;
	restartAt: string;
	recipients: number;
	requestedBy: string | null;
};

export type GameServerState = {
	repo: string;
	pm2App: string;
	deployBranch: string;
	checkoutBranch: string;
	commit: string;
	shortCommit: string;
	commitSubject: string;
	commitAt: string | null;
	buildCommit: string | null;
	dirty: boolean;
	hold: boolean;
	uptimeSeconds: number;
	onlinePlayers: number;
	pendingRestart: PendingRestart | null;
};

export type GameServerBranches = {
	repo: string;
	deployBranch: string;
	count: number;
	branches: CloudBranch[];
};

export type RestartResult = {
	branch: string;
	commit: string | null;
	seconds: number;
	requestedAt: string;
	restartAt: string;
	recipients: number;
	hold: boolean;
	dryRun: boolean;
};

/** `git ls-remote` reaches GitHub, so both reads get more room than a plain API call. */
const DEPLOY_READ_TIMEOUT_MS = 20_000;

export function fetchGameServerState(): Promise<GameServerState> {
	return fetchGameServerAdmin<GameServerState>(
		"/api/admin/server/state",
		"the game server's deploy state",
		DEPLOY_READ_TIMEOUT_MS,
	);
}

export function fetchGameServerBranches(): Promise<GameServerBranches> {
	return fetchGameServerAdmin<GameServerBranches>(
		"/api/admin/server/branches",
		"the game server's cloud branches",
		DEPLOY_READ_TIMEOUT_MS,
	);
}

export function restartGameServer(options: {
	branch?: string;
	seconds?: number;
	force?: boolean;
	dryRun?: boolean;
	requestedBy?: string;
}): Promise<{ ok: true } & RestartResult> {
	return requestGameServerAdmin<{ ok: true } & RestartResult>(
		"/api/admin/server/restart",
		{
			...(options.branch ? { branch: options.branch } : {}),
			...(options.seconds === undefined ? {} : { seconds: options.seconds }),
			...(options.force ? { force: true } : {}),
			...(options.dryRun ? { dryRun: true } : {}),
			...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
		},
		options.branch ? `the restart to ${options.branch}` : "the server restart",
	);
}

export function cancelGameServerRestart(): Promise<{ ok: true } & PendingRestart> {
	return requestGameServerAdmin<{ ok: true } & PendingRestart>(
		"/api/admin/server/restart/cancel",
		{},
		"the scheduled restart cancellation",
	);
}
