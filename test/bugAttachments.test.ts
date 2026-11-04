import assert from "node:assert/strict";
import {
	archiveAttachments,
	downloadAttachment,
	MAX_ATTACHMENT_BYTES,
	repositoryFileUrl,
	reportFolder,
	safeFilename,
} from "../src/utils/bugAttachments.js";
import { buildIssueBody } from "../src/utils/githubIssues.js";

/* ------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------ */

assert.equal(safeFilename("lv_0_20261029193311.mp4", "x"), "lv_0_20261029193311.mp4");
// No path traversal or nested folders out of a player-supplied name.
assert.equal(safeFilename("../../etc/passwd", "x"), "etc_passwd");
assert.equal(safeFilename("my clip (1).mp4", "x"), "my_clip_1_.mp4");
assert.equal(safeFilename("...", "fallback.bin"), "fallback.bin");

assert.equal(
	reportFolder("542461975683399711", Date.UTC(2026, 9, 29, 18, 0, 0)),
	`reports/2026-10-29/542461975683399711-${Date.UTC(2026, 9, 29, 18, 0, 0)}`,
);

const location = { owner: "o", repo: "r", branch: "bug-report-attachments", path: "reports/d/a b.mp4" };
assert.equal(repositoryFileUrl(location), "https://github.com/o/r/blob/bug-report-attachments/reports/d/a%20b.mp4");
assert.equal(
	repositoryFileUrl({ ...location, raw: true }),
	"https://github.com/o/r/blob/bug-report-attachments/reports/d/a%20b.mp4?raw=true",
);

/* ------------------------------------------------------------------
 * GitHub stub
 * ------------------------------------------------------------------ */

const realFetch = globalThis.fetch;
const CDN_VIDEO = "https://cdn.discordapp.com/ephemeral-attachments/1/2/clip.mp4?ex=1&is=2&hm=3";
const CDN_IMAGE = "https://cdn.discordapp.com/ephemeral-attachments/1/3/shot.png?ex=1&is=2&hm=3";
const CDN_HUGE = "https://cdn.discordapp.com/ephemeral-attachments/1/4/huge.mp4?ex=1&is=2&hm=3";

type Call = { method: string; url: string; body: any };

function stub(options: { branchExists: boolean; blobStatus?: number; raceOnce?: boolean }) {
	const calls: Call[] = [];
	let raced = false;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, url, body });

		if (url === CDN_VIDEO) return new Response(Buffer.from("video-bytes"));
		if (url === CDN_IMAGE) return new Response(Buffer.from("png-bytes"));
		if (url === CDN_HUGE) {
			return new Response(Buffer.alloc(16), {
				headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) },
			});
		}
		if (url.endsWith("/git/blobs")) {
			if (options.blobStatus) {
				return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
					status: options.blobStatus,
				});
			}
			return new Response(JSON.stringify({ sha: `blob-${calls.length}` }), { status: 201 });
		}
		if (url.includes("/git/ref/heads/")) {
			if (!options.branchExists) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ object: { sha: "head-sha" } }));
		}
		if (url.includes("/git/commits/head-sha")) return new Response(JSON.stringify({ tree: { sha: "base-tree" } }));
		if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "tree-sha" }), { status: 201 });
		if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "commit-sha" }), { status: 201 });
		if (url.includes("/git/refs")) {
			if (options.raceOnce && !raced) {
				raced = true;
				return new Response(JSON.stringify({ message: "Update is not a fast forward" }), { status: 422 });
			}
			return new Response(JSON.stringify({}), { status: method === "POST" ? 201 : 200 });
		}
		throw new Error(`unexpected ${method} ${url}`);
	}) as typeof fetch;
	return calls;
}

const uploads = [
	{ url: CDN_VIDEO, filename: "clip.mp4", isImage: false },
	{ url: CDN_IMAGE, filename: "shot.png", isImage: true },
];

/* ------------------------------------------------------------------
 * First report: the branch is created as an orphan
 * ------------------------------------------------------------------ */
{
	const calls = stub({ branchExists: false });
	const out = await archiveAttachments({
		attachments: uploads,
		token: "t",
		owner: "o",
		repo: "r",
		discordId: "42",
		nowMs: Date.UTC(2026, 9, 29),
	});
	assert.deepEqual(out.failed, []);
	assert.deepEqual(out.tooLarge, []);
	assert.equal(out.attachments.length, 2);
	assert.ok(out.attachments.every((a) => a.archived), "both files archived");
	// The video now points into the tracker, not at the expiring Discord link.
	assert.ok(out.attachments[0].url.startsWith("https://github.com/o/r/blob/bug-report-attachments/reports/2026-10-29/42-"));
	assert.ok(out.attachments[0].url.endsWith("/clip.mp4"), "video links the blob page");
	assert.ok(out.attachments[1].url.endsWith("/shot.png?raw=true"), "image links the raw bytes so it renders inline");
	assert.equal(out.attachments[0].size, "video-bytes".length);

	const blob = calls.find((c) => c.url.endsWith("/git/blobs"))!;
	assert.equal(blob.body.encoding, "base64");
	assert.equal(Buffer.from(blob.body.content, "base64").toString(), "video-bytes");

	const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!;
	assert.deepEqual(commit.body.parents, [], "a new branch is an orphan, carrying none of the repo's code");
	const tree = calls.find((c) => c.url.endsWith("/git/trees"))!;
	assert.equal(tree.body.base_tree, undefined);
	assert.equal(tree.body.tree.length, 2, "both files go in one commit");
	const ref = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/refs"))!;
	assert.equal(ref.body.ref, "refs/heads/bug-report-attachments");
	globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------
 * Later reports build on the branch head, and survive a race
 * ------------------------------------------------------------------ */
{
	const calls = stub({ branchExists: true, raceOnce: true });
	const out = await archiveAttachments({ attachments: uploads, token: "t", owner: "o", repo: "r", discordId: "42" });
	assert.ok(out.attachments.every((a) => a.archived), "a lost ref race is retried");
	const patches = calls.filter((c) => c.method === "PATCH");
	assert.equal(patches.length, 2, "the ref update is retried once");
	assert.equal(patches[1].body.force, false, "never force-pushes over another report");
	const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!;
	assert.deepEqual(commit.body.parents, ["head-sha"]);
	assert.equal(calls.filter((c) => c.url.endsWith("/git/blobs")).length, 2, "blobs are not re-uploaded on retry");
	globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------
 * Over the cap, and no permission
 * ------------------------------------------------------------------ */
{
	stub({ branchExists: true });
	const out = await archiveAttachments({
		attachments: [
			{ url: CDN_HUGE, filename: "huge.mp4", isImage: false },
			{ url: CDN_VIDEO, filename: "declared.mp4", isImage: false, size: MAX_ATTACHMENT_BYTES + 1 },
			uploads[0],
		],
		token: "t",
		owner: "o",
		repo: "r",
		discordId: "42",
	});
	assert.deepEqual(out.tooLarge, ["huge.mp4", "declared.mp4"]);
	assert.equal(out.attachments[0].archived, false);
	assert.equal(out.attachments[0].tooLarge, true);
	assert.equal(out.attachments[0].url, CDN_HUGE, "a refused file keeps its Discord link");
	assert.equal(out.attachments[2].archived, true, "the one under the cap is still kept, in order");
	globalThis.fetch = realFetch;
}
{
	// An app without Contents: write must not break the report: it falls back to Discord links.
	stub({ branchExists: true, blobStatus: 403 });
	const out = await archiveAttachments({ attachments: uploads, token: "t", owner: "o", repo: "r", discordId: "42" });
	assert.deepEqual(out.failed, ["clip.mp4", "shot.png"]);
	assert.ok(out.attachments.every((a) => a.archived === false));
	assert.equal(out.attachments[0].url, CDN_VIDEO);
	globalThis.fetch = realFetch;
}
{
	// The stream itself is counted: a lying (or missing) Content-Length cannot exhaust memory.
	globalThis.fetch = (async () => new Response(Buffer.alloc(64))) as typeof fetch;
	const result = await downloadAttachment("https://cdn.discordapp.com/x", 32);
	assert.equal(result.ok, false);
	assert.equal(!result.ok && result.tooLarge, true);
	globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------ */
{
	const body = buildIssueBody({
		reporterId: "1",
		reporterUsername: null,
		description: "d",
		steps: "",
		attachments: [
			{ url: "https://github.com/o/r/blob/b/reports/x/clip.mp4", filename: "clip.mp4", isImage: false, size: 4_404_019, archived: true },
			{ url: CDN_HUGE, filename: "huge.mp4", isImage: false, archived: false, tooLarge: true },
			{ url: CDN_IMAGE, filename: "shot.png", isImage: true, archived: false },
		],
	});
	assert.ok(body.includes("- [clip.mp4](<https://github.com/o/r/blob/b/reports/x/clip.mp4>) (4.2 MB)"), body);
	assert.ok(body.includes(`- [huge.mp4](<${CDN_HUGE}>) — over the 10 MB limit`), body);
	assert.ok(body.includes(`![shot.png](<${CDN_IMAGE}>)\n_shot.png: could not be saved`), body);
}
