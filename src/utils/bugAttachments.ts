import { errorMessage, logWarn } from "./logger.js";
import type { ReportAttachment } from "./githubIssues.js";

/**
 * Copies a bug report's uploads out of Discord and into the tracker repository.
 *
 * A file uploaded through a modal lives at a Discord **ephemeral-attachments**
 * URL whose signature (`?ex=&is=&hm=`) lapses within about a day. GitHub's image
 * proxy only ever caches images, and only once someone opens the issue — a video
 * is a plain link that nothing caches, so by the time staff click it the file is
 * gone ("This content is no longer available"). Linking Discord was never going
 * to keep a video.
 *
 * The issues API has no attachment field, so the bytes go into the repository
 * itself instead, on a dedicated branch that holds nothing else
 * (`bug-report-attachments` by default). Everything — the branch, the files and
 * the links — sits behind the private repository's own permissions, so only
 * people who can read the issue can open the file.
 *
 * All files of one report land in a single commit made through the git data API
 * (blobs → tree → commit → ref), so two reports filed at once cannot race each
 * other the way two Contents API PUTs to the same branch would.
 */

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_URL = "https://api.github.com";

/** Per-file cap. Keeps a report inside the function's time and memory budget. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const DEFAULT_BRANCH = "bug-report-attachments";

const DOWNLOAD_TIMEOUT_MS = 15_000;
/** A 10 MB file is ~13.4 MB once base64-encoded; give the upload room. */
const BLOB_UPLOAD_TIMEOUT_MS = 25_000;
const GIT_REQUEST_TIMEOUT_MS = 8_000;

export function getAttachmentBranch(): string {
	return process.env.BUG_REPORT_ATTACHMENT_BRANCH?.trim() || DEFAULT_BRANCH;
}

/**
 * A filename safe to use as one path segment: no slashes, no `..`, nothing a URL
 * would need to escape. The extension is kept so GitHub still knows the type.
 */
export function safeFilename(raw: string, fallback: string): string {
	const cleaned = raw
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^[._]+/, "")
		.replace(/_+/g, "_")
		.slice(-100);
	return cleaned || fallback;
}

/** `reports/2026-10-29/<discordId>-<ms>` — one folder per report, sortable by day. */
export function reportFolder(discordId: string, nowMs: number): string {
	const day = new Date(nowMs).toISOString().slice(0, 10);
	const id = discordId.replace(/[^0-9A-Za-z]/g, "") || "unknown";
	return `reports/${day}/${id}-${nowMs}`;
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The blob page, which shows staff the file (and a download button) after GitHub's
 * normal sign-in check. `?raw=true` makes the same URL serve the bytes, which is
 * what an inline `![image](…)` needs.
 */
export function repositoryFileUrl(input: {
	owner: string;
	repo: string;
	branch: string;
	path: string;
	raw?: boolean;
}): string {
	const base = `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/blob/${encodePath(input.branch)}/${encodePath(input.path)}`;
	return input.raw ? `${base}?raw=true` : base;
}

/* ------------------------------------------------------------------
 * Download
 * ------------------------------------------------------------------ */

type DownloadResult =
	| { ok: true; bytes: Buffer }
	| { ok: false; tooLarge: boolean; detail: string };

/**
 * Reads the file, refusing anything over the cap. The declared size is checked
 * first, but the stream is counted too: neither Discord's `size` nor a
 * `Content-Length` header is something to trust with memory.
 */
export async function downloadAttachment(url: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<DownloadResult> {
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	} catch (error) {
		return { ok: false, tooLarge: false, detail: errorMessage(error) };
	}
	if (!response.ok || !response.body) {
		return { ok: false, tooLarge: false, detail: `Discord CDN answered ${response.status}` };
	}

	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body.cancel().catch(() => {});
		return { ok: false, tooLarge: true, detail: `${declared} bytes` };
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return { ok: false, tooLarge: true, detail: `over ${maxBytes} bytes` };
			}
			chunks.push(value);
		}
	} catch (error) {
		return { ok: false, tooLarge: false, detail: errorMessage(error) };
	}
	return { ok: true, bytes: Buffer.concat(chunks) };
}

/* ------------------------------------------------------------------
 * Git data API
 * ------------------------------------------------------------------ */

class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function gitRequest<T>(
	token: string,
	method: string,
	url: string,
	body?: unknown,
	timeoutMs = GIT_REQUEST_TIMEOUT_MS,
): Promise<T> {
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	if (!response.ok) {
		let detail = text;
		try {
			detail = (JSON.parse(text) as { message?: string }).message ?? text;
		} catch {
			// Not JSON; keep the raw text.
		}
		throw new GitHubError(response.status, `${method} ${url.replace(GITHUB_API_URL, "")} → ${response.status}: ${detail}`);
	}
	return (text ? JSON.parse(text) : {}) as T;
}

type StagedFile = { path: string; bytes: Buffer };

/**
 * Commits the files to the attachment branch in one commit, creating the branch
 * (as an orphan, so it carries none of the repository's code) the first time.
 * A ref update that loses a race with another report is retried on the new head.
 */
async function commitFiles(input: {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	files: StagedFile[];
	message: string;
}): Promise<void> {
	const repoUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
	const refPath = `heads/${input.branch}`;

	const blobs = await Promise.all(
		input.files.map(async (file) => {
			const blob = await gitRequest<{ sha: string }>(
				input.token,
				"POST",
				`${repoUrl}/git/blobs`,
				{ content: file.bytes.toString("base64"), encoding: "base64" },
				BLOB_UPLOAD_TIMEOUT_MS,
			);
			return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
		}),
	);

	for (let attempt = 0; attempt < 2; attempt++) {
		let parentSha: string | null = null;
		let baseTree: string | undefined;
		try {
			const ref = await gitRequest<{ object: { sha: string } }>(
				input.token,
				"GET",
				`${repoUrl}/git/ref/${encodePath(refPath)}`,
			);
			parentSha = ref.object.sha;
			const commit = await gitRequest<{ tree: { sha: string } }>(
				input.token,
				"GET",
				`${repoUrl}/git/commits/${parentSha}`,
			);
			baseTree = commit.tree.sha;
		} catch (error) {
			if (!(error instanceof GitHubError && error.status === 404)) throw error;
			// First report ever: the branch does not exist yet.
		}

		const tree = await gitRequest<{ sha: string }>(input.token, "POST", `${repoUrl}/git/trees`, {
			...(baseTree ? { base_tree: baseTree } : {}),
			tree: blobs,
		});
		const commit = await gitRequest<{ sha: string }>(input.token, "POST", `${repoUrl}/git/commits`, {
			message: input.message,
			tree: tree.sha,
			parents: parentSha ? [parentSha] : [],
		});

		try {
			if (parentSha) {
				await gitRequest(input.token, "PATCH", `${repoUrl}/git/refs/${encodePath(refPath)}`, {
					sha: commit.sha,
					force: false,
				});
			} else {
				await gitRequest(input.token, "POST", `${repoUrl}/git/refs`, {
					ref: `refs/${refPath}`,
					sha: commit.sha,
				});
			}
			return;
		} catch (error) {
			// 422: not a fast-forward, or the branch was just created by someone else.
			const raced = error instanceof GitHubError && error.status === 422;
			if (!raced || attempt === 1) throw error;
		}
	}
}

/* ------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------ */

export type ArchiveOutcome = {
	attachments: ReportAttachment[];
	/** Filenames the player should be told were not kept. */
	tooLarge: string[];
	failed: string[];
};

/**
 * Replaces each attachment's Discord URL with a permanent link into the tracker
 * repository. Anything that cannot be archived keeps its Discord link (better a
 * link that works for a day than none) and is marked so the issue says so.
 * Never throws: a broken upload must not stop the report itself being filed.
 */
export async function archiveAttachments(input: {
	attachments: ReportAttachment[];
	token: string;
	owner: string;
	repo: string;
	discordId: string;
	nowMs?: number;
}): Promise<ArchiveOutcome> {
	const outcome: ArchiveOutcome = { attachments: [], tooLarge: [], failed: [] };
	if (input.attachments.length === 0) return outcome;


	const branch = getAttachmentBranch();
	const folder = reportFolder(input.discordId, input.nowMs ?? Date.now());

	const downloads = await Promise.all(
		input.attachments.map(async (attachment, index) => {
			if (typeof attachment.size === "number" && attachment.size > MAX_ATTACHMENT_BYTES) {
				return { attachment, index, result: { ok: false, tooLarge: true, detail: `${attachment.size} bytes` } as DownloadResult };
			}
			return { attachment, index, result: await downloadAttachment(attachment.url) };
		}),
	);

	// Indexed by position, so the issue lists files in the order the player picked them.
	const results: ReportAttachment[] = [...input.attachments];
	const finish = (): ArchiveOutcome => ({ ...outcome, attachments: results });
	const staged: Array<{ index: number; attachment: ReportAttachment; path: string; bytes: Buffer }> = [];
	const usedNames = new Set<string>();
	for (const { attachment, index, result } of downloads) {
		if (!result.ok) {
			if (result.tooLarge) outcome.tooLarge.push(attachment.filename);
			else {
				outcome.failed.push(attachment.filename);
				logWarn("bugAttachments", "Could not download attachment", {
					filename: attachment.filename,
					detail: result.detail,
				});
			}
			results[index] = { ...attachment, archived: false, tooLarge: result.tooLarge };
			continue;
		}
		let name = safeFilename(attachment.filename, `attachment-${index + 1}`);
		if (usedNames.has(name)) name = `${index + 1}-${name}`;
		usedNames.add(name);
		staged.push({ index, attachment, path: `${folder}/${name}`, bytes: result.bytes });
	}

	if (staged.length === 0) return finish();

	try {
		await commitFiles({
			token: input.token,
			owner: input.owner,
			repo: input.repo,
			branch,
			files: staged.map(({ path, bytes }) => ({ path, bytes })),
			message: `Bug report attachments from ${input.discordId || "unknown"}`,
		});
	} catch (error) {
		// Most likely the GitHub App lacks Contents: write. Fall back to Discord links.
		logWarn("bugAttachments", "Could not archive attachments; linking Discord instead", {
			repo: `${input.owner}/${input.repo}`,
			branch,
			error: errorMessage(error),
		});
		for (const { index, attachment } of staged) {
			outcome.failed.push(attachment.filename);
			results[index] = { ...attachment, archived: false };
		}
		return finish();
	}

	for (const { index, attachment, path, bytes } of staged) {
		const location = { owner: input.owner, repo: input.repo, branch, path };
		results[index] = {
			...attachment,
			url: repositoryFileUrl({ ...location, raw: attachment.isImage }),
			size: bytes.byteLength,
			archived: true,
		};
	}
	return finish();
}
