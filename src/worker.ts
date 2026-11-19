import verifyPage from "../pages/verify.html";
import connectedPage from "../pages/connected.html";
import failedPage from "../pages/failed.html";
import { registerHtmlPages } from "./utils/htmlPages.js";
import { runInRequestScope, waitUntil } from "./utils/requestScope.js";
import { runNodeHandler, type NodeStyleHandler } from "./utils/nodeHttpAdapter.js";

registerHtmlPages({
	"pages/verify.html": verifyPage,
	"pages/connected.html": connectedPage,
	"pages/failed.html": failedPage,
});

type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };
type ScheduledController = { cron: string; scheduledTime: number };
type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };

type Loader = () => Promise<{ default: NodeStyleHandler }>;

const index: Loader = () => import("../api/index.js");

const routes: Record<string, Loader> = {
	"/": index,
	"/api/index": index,
	"/api/interactions": () => import("../api/interactions.js"),
	"/api/discord-linked-roles/connect": () => import("../api/discord-linked-roles/connect.js"),
	"/api/discord-oauth-callback": () => import("../api/discord-oauth-callback.js"),
	"/api/discord/link/callback": () => import("../api/discord/link/callback.js"),
	"/api/github-sponsors": () => import("../api/github-sponsors.js"),
	"/api/game-stats/sync": () => import("../api/game-stats/sync.js"),
	"/api/game-health": () => import("../api/game-health.js"),
	"/api/server-maintenance": () => import("../api/server-maintenance.js"),
	"/api/game-log": () => import("../api/game-log.js"),
};

/** Cron expression → the endpoint it calls, as vercel.json had it. */
const crons: Record<string, string> = {
	"0 12 * * *": "/api/game-health",
	"0 3 * * *": "/api/server-maintenance",
};

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;

	// Pack banners keep their old /assets/... URLs; the asset directory itself is served at the root.
	if (pathname.startsWith("/assets/")) {
		const assetUrl = new URL(pathname.slice("/assets".length), url);
		return env.ASSETS.fetch(new Request(assetUrl, request));
	}

	const load = routes[pathname];
	if (!load) return new Response("Not Found", { status: 404 });

	const { result, finished } = runInRequestScope(
		(promise) => ctx.waitUntil(promise),
		async () => {
			const { default: handler } = await load();
			const { response, completion } = await runNodeHandler(handler, request);
			waitUntil(completion);
			return response;
		},
	);
	ctx.waitUntil(finished);
	return result;
}

export default {
	fetch: handle,

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const path = crons[controller.cron];
		if (!path) {
			console.warn(`[worker] no route for cron "${controller.cron}"`);
			return;
		}
		const secret = process.env.CRON_SECRET?.trim() || process.env.HEALTH_CHECK_SECRET?.trim() || "";
		if (!secret) console.warn(`[worker] cron ${path}: CRON_SECRET is not set, the endpoint runs unauthenticated`);
		const request = new Request(`https://cron.internal${path}`, {
			headers: secret ? { authorization: `Bearer ${secret}` } : {},
		});
		const response = await handle(request, env, ctx);
		console.log(`[worker] cron ${path} → ${response.status}`);
	},
};
