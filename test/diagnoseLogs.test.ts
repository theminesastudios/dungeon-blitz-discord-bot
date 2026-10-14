import assert from "node:assert/strict";
import {
	MAX_INLINE_CHARS,
	editOriginalWithFile,
	fetchServerLogs,
	renderLogsMessage,
	renderLogsText,
	type ServerLogs,
} from "../src/utils/gameServerLogs.js";
import { allowedDiagnoseUsers, diagnoseCommand } from "../src/commands/diagnose.js";

// `/diagnose logs`: the call it makes (a GET with the shared secret and the filter in the
// query), how an answer is laid out within Discord's 2,000 characters, the file it attaches
// when that is not enough, and who may use it.

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.GAME_SERVER_BASE_URL;
const originalSecret = process.env.DISCORD_MAINTENANCE_API_SECRET;
const originalAllowed = process.env.DIAGNOSE_USER_IDS;

function logs(lines: string[], extra: Partial<ServerLogs> = {}): ServerLogs {
	return {
		ok: true,
		pm2App: "dungeon-mp",
		filter: "Login",
		lines: 100,
		files: [
			{ stream: "error", file: "dungeon-mp-error.log", exists: true, sizeBytes: 10, scannedBytes: 10, lines, truncated: false },
			{ stream: "out", file: "dungeon-mp-out.log", exists: true, sizeBytes: 0, scannedBytes: 0, lines: [], truncated: false },
		],
		...extra,
	};
}

try {
	// The request.
	process.env.GAME_SERVER_BASE_URL = "https://game.example.com";
	process.env.DISCORD_MAINTENANCE_API_SECRET = "test-secret";
	let seenUrl = "";
	let seenAuth = "";
	globalThis.fetch = (async (input: unknown, init: any) => {
		seenUrl = String(input);
		seenAuth = String(init?.headers?.Authorization ?? "");
		return new Response(JSON.stringify(logs(["[Router] Error in handler for 0x14: boom"])), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const answer = await fetchServerLogs({ filter: "Login fail", lines: 50, stream: "error" });
	const url = new URL(seenUrl);
	assert.equal(url.pathname, "/api/admin/server/logs");
	assert.equal(url.searchParams.get("filter"), "Login fail");
	assert.equal(url.searchParams.get("lines"), "50");
	assert.equal(url.searchParams.get("stream"), "error");
	assert.equal(seenAuth, "Bearer test-secret");
	assert.equal(answer.files[0].lines.length, 1);

	// Short: everything inline, in code blocks a log line cannot close.
	const short = renderLogsMessage(logs(["a ``` b", "second"]));
	assert.equal(short.fitsInline, true);
	assert.ok(short.content.includes("**error log** — 2 line(s)"));
	assert.ok(short.content.includes("**output log** — no matching lines"));
	assert.equal(short.content.split("```").length - 1, 2, "only the block's own fences");

	// Long: the newest lines inline within the limit, the rest pointed at the file.
	const many = Array.from({ length: 300 }, (_, i) => `[Login] line ${i} ${"x".repeat(40)}`);
	const long = renderLogsMessage(logs(many));
	assert.equal(long.fitsInline, false);
	assert.ok(long.content.length <= MAX_INLINE_CHARS);
	assert.ok(long.content.includes("line 299"), "the newest line is shown");
	assert.ok(!long.content.includes("line 0 "), "the oldest is left to the file");
	assert.ok(long.content.includes("earlier line(s) in the attached file"));
	const text = renderLogsText(logs(many));
	assert.ok(text.includes("line 0 ") && text.includes("line 299"));

	// The attachment: one multipart PATCH of the original reply.
	let patched: { url: string; method: string; body: unknown } | null = null;
	globalThis.fetch = (async (input: unknown, init: any) => {
		patched = { url: String(input), method: String(init?.method), body: init?.body };
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	await editOriginalWithFile({ applicationId: "123", token: "tok", content: "hi", fileName: "dungeon-mp-logs.txt", fileText: "all" });
	assert.ok(patched);
	assert.equal(patched!.url, "https://discord.com/api/v10/webhooks/123/tok/messages/@original");
	assert.equal(patched!.method, "PATCH");
	assert.ok(patched!.body instanceof FormData);
	const form = patched!.body as FormData;
	assert.ok(form.get("files[0]") instanceof Blob);
	assert.equal(JSON.parse(String(form.get("payload_json"))).attachments[0].filename, "dungeon-mp-logs.txt");

	// Who may use it.
	delete process.env.DIAGNOSE_USER_IDS;
	assert.deepEqual([...allowedDiagnoseUsers()], ["285118390031351809"]);
	process.env.DIAGNOSE_USER_IDS = "111111111111111111, 222222222222222222";
	assert.deepEqual([...allowedDiagnoseUsers()], ["111111111111111111", "222222222222222222"]);
	delete process.env.DIAGNOSE_USER_IDS;

	let replied: any = null;
	let deferred = false;
	const stranger = {
		member: { user: { id: "999999999999999999" } },
		options: { getSubcommand: () => "logs", getString: () => null, getNumber: () => null },
		reply: async (data: unknown) => { replied = data; return data; },
		deferReply: () => { deferred = true; },
	};
	await diagnoseCommand.handler(stranger as never);
	assert.equal(deferred, false, "nothing is fetched for anyone else");
	assert.match(String(replied?.content), /not available/);

	// The command's shape.
	const json = diagnoseCommand.data.toJSON() as any;
	assert.equal(json.name, "diagnose");
	assert.equal(json.options[0].name, "logs");
	assert.deepEqual(json.options[0].options.map((o: any) => o.name), ["filter", "lines", "stream"]);

	console.log("diagnose logs test passed");
} finally {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.GAME_SERVER_BASE_URL; else process.env.GAME_SERVER_BASE_URL = originalBaseUrl;
	if (originalSecret === undefined) delete process.env.DISCORD_MAINTENANCE_API_SECRET; else process.env.DISCORD_MAINTENANCE_API_SECRET = originalSecret;
	if (originalAllowed === undefined) delete process.env.DIAGNOSE_USER_IDS; else process.env.DIAGNOSE_USER_IDS = originalAllowed;
}
