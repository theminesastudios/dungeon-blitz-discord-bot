import { MiniDatabase } from "@minesa-org/mini-interaction";

const DEFAULT_TARGETS = ["theminesastudios"];
const MANUAL_PAST_SPONSORS = [
	"joxzael",
	"sapha59-ai",
	"monderucdere",
	"renGoku-wq",
	"lawly14",
	"kebap999",
	"darkneesglow",
	"neodevils",
	"butimar408",
	"nillion0",
	"ewaai21",
	"etyboo",
	"nevastuica8",
	"mecnunnemo-pixel",
	"andrepda51-wq",
	"tw1xxye",
	"prince-159",
	"hitkill600",
	"y3olo",
	"Emkata-rgb"
];
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const DEFAULT_SPONSOR_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_SPONSOR_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeLogin(login: string) {
	return login.trim().toLowerCase();
}

type SponsorsResponse = {
	data?: {
		viewer?: {
			login: string;
		};
		repositoryOwner?: SponsorsOwner;
	};
	errors?: Array<{ message: string }>;
};

type SponsorsOwner = {
	__typename?: "User" | "Organization" | string;
	userSponsorships?: SponsorsConnection;
	organizationSponsorships?: SponsorsConnection;
} | null;

type SponsorsConnection = {
	pageInfo: {
		hasNextPage: boolean;
		endCursor: string | null;
	};
	nodes: Array<{
		isActive: boolean;
		sponsorEntity: {
			login: string;
		} | null;
	}>;
} | null;

type DiscordConnection = {
	type?: string;
	name?: string;
	verified?: boolean;
};

type RepositoryCommit = {
	author?: {
		login?: string;
	} | null;
	committer?: {
		login?: string;
	} | null;
	commit?: {
		message?: string;
		author?: {
			email?: string;
		};
		committer?: {
			email?: string;
		};
	};
};

type CommitSearchResponse = {
	items?: RepositoryCommit[];
};

type HtmlSponsorDirectory = {
	sponsors: string[];
	totalCount: number | null;
	publicCount: number;
	pastSponsors: string[];
	pastTotalCount: number | null;
	pastPublicCount: number;
};

type SponsorDirectory = {
	sponsors: Set<string>;
	viewerLogin: string | null;
	totalCount: number | null;
	publicCount: number | null;
	pastSponsors: Set<string>;
	pastTotalCount: number | null;
	pastPublicCount: number | null;
};

type SponsorDirectoryCacheEntry = {
	value: SponsorDirectory;
	expiresAt: number;
};

type PersistedSponsorDirectory = {
	targetLogin: string;
	includePrivate: boolean;
	viewerLogin: string | null;
	sponsors: string[];
	fetchedAt: number;
	totalCount: number | null;
	publicCount: number | null;
	pastSponsors: string[];
	pastTotalCount: number | null;
	pastPublicCount: number | null;
};

export type StoredSponsorSnapshot = {
	targetLogin: string;
	includePrivate: boolean;
	viewerLogin: string | null;
	sponsors: string[];
	fetchedAt: number;
	isFresh: boolean;
	totalCount: number | null;
	publicCount: number | null;
	pastSponsors: string[];
	pastTotalCount: number | null;
	pastPublicCount: number | null;
};

class GitHubRateLimitError extends Error {
	retryAt: number;

	constructor(message: string, retryAt: number) {
		super(message);
		this.name = "GitHubRateLimitError";
		this.retryAt = retryAt;
	}
}

const sponsorDirectoryCache = new Map<string, SponsorDirectoryCacheEntry>();
const sponsorDirectoryInflight = new Map<string, Promise<SponsorDirectory>>();
const sponsorResultCache = new Map<
	string,
	{
		value: { isSponsor: boolean; matchedTarget: string | null };
		expiresAt: number;
	}
>();

let sponsorRateLimitCooldownUntil = 0;
let sponsorSnapshotDb: MiniDatabase | null | undefined;

function getSponsorTargets(): string[] {
	const raw = process.env.GITHUB_SPONSOR_TARGETS?.trim();
	if (!raw) return DEFAULT_TARGETS;

	return raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function shouldForcePublicSponsors() {
	return process.env.GITHUB_SPONSOR_FORCE_PUBLIC?.trim().toLowerCase() === "true";
}

function getGitHubToken() {
	if (shouldForcePublicSponsors()) {
		return null;
	}

	return process.env.GITHUB_TOKEN?.trim() || null;
}

function isSponsorDebugEnabled() {
	return process.env.GITHUB_SPONSOR_DEBUG?.trim().toLowerCase() === "true";
}

function getSponsorCacheTtlMs() {
	const raw = Number(process.env.GITHUB_SPONSOR_CACHE_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SPONSOR_CACHE_TTL_MS;
}

function getSponsorRateLimitCooldownMs() {
	const raw = Number(process.env.GITHUB_SPONSOR_RATE_LIMIT_COOLDOWN_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function getSponsorRefreshIntervalMs() {
	const raw = Number(process.env.GITHUB_SPONSOR_REFRESH_INTERVAL_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_SPONSOR_REFRESH_INTERVAL_MS;
}

function getSponsorDirectoryCacheKey(targetLogin: string, includePrivate: boolean) {
	return `${normalizeLogin(targetLogin)}|${includePrivate ? "private" : "public"}`;
}

function getSponsorResultCacheKey(
	githubUsername: string,
	targets: string[],
	tokenMode: string
) {
	return `${normalizeLogin(githubUsername)}|${tokenMode}|${targets
		.map(normalizeLogin)
		.join(",")}`;
}

function getCachedResult<T extends { expiresAt: number; value: unknown }>(
	cache: Map<string, T>,
	key: string
) {
	const entry = cache.get(key);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(key);
		return null;
	}

	return entry.value as T["value"];
}

function setCachedResult<T>(
	cache: Map<
		string,
		{
			value: T;
			expiresAt: number;
		}
	>,
	key: string,
	value: T,
	ttlMs: number
) {
	cache.set(key, {
		value,
		expiresAt: Date.now() + ttlMs,
	});
}

function noteRateLimitCooldown(retryAt: number, context: string) {
	sponsorRateLimitCooldownUntil = Math.max(sponsorRateLimitCooldownUntil, retryAt);
	console.warn(
		`[githubSponsors] Rate limit cooldown active until ${new Date(sponsorRateLimitCooldownUntil).toISOString()} (${context}).`
	);
}

function getSponsorSnapshotDb() {
	if (sponsorSnapshotDb !== undefined) {
		return sponsorSnapshotDb;
	}

	try {
		sponsorSnapshotDb = MiniDatabase.fromEnv();
		return sponsorSnapshotDb;
	} catch (error) {
		console.warn(
			`[githubSponsors] Sponsor snapshot DB unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		sponsorSnapshotDb = null;
		return sponsorSnapshotDb;
	}
}

function getSponsorSnapshotKey(targetLogin: string, includePrivate: boolean) {
	return `system:github-sponsors:${getSponsorDirectoryCacheKey(
		targetLogin,
		includePrivate
	)}`;
}

function toPersistedSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean,
	directory: SponsorDirectory
): PersistedSponsorDirectory {
	return {
		targetLogin: normalizeLogin(targetLogin),
		includePrivate,
		viewerLogin: directory.viewerLogin,
		sponsors: Array.from(directory.sponsors),
		fetchedAt: Date.now(),
		totalCount: directory.totalCount,
		publicCount: directory.publicCount,
		pastSponsors: Array.from(directory.pastSponsors),
		pastTotalCount: directory.pastTotalCount,
		pastPublicCount: directory.pastPublicCount,
	};
}

function fromPersistedSponsorDirectory(
	value: unknown
): PersistedSponsorDirectory | null {
	if (!value || typeof value !== "object") return null;

	const record = value as Record<string, unknown>;
	const sponsors = Array.isArray(record.sponsors)
		? record.sponsors.filter((entry): entry is string => typeof entry === "string")
		: null;
	const fetchedAt =
		typeof record.fetchedAt === "number" ? record.fetchedAt : Number(record.fetchedAt);

	if (
		typeof record.targetLogin !== "string" ||
		typeof record.includePrivate !== "boolean" ||
		!sponsors ||
		!Number.isFinite(fetchedAt)
	) {
		return null;
	}

	return {
		targetLogin: normalizeLogin(record.targetLogin),
		includePrivate: record.includePrivate,
		viewerLogin:
			typeof record.viewerLogin === "string" ? record.viewerLogin : null,
		sponsors: sponsors.map(normalizeLogin),
		fetchedAt,
		totalCount:
			record.totalCount === null || typeof record.totalCount === "number"
				? (record.totalCount as number | null)
				: null,
		publicCount:
			record.publicCount === null || typeof record.publicCount === "number"
				? (record.publicCount as number | null)
				: null,
		pastSponsors: Array.isArray(record.pastSponsors)
			? record.pastSponsors
					.filter((entry): entry is string => typeof entry === "string")
					.map(normalizeLogin)
			: [],
		pastTotalCount:
			record.pastTotalCount === null ||
			typeof record.pastTotalCount === "number"
				? (record.pastTotalCount as number | null)
				: null,
		pastPublicCount:
			record.pastPublicCount === null ||
			typeof record.pastPublicCount === "number"
				? (record.pastPublicCount as number | null)
				: null,
	};
}

function isSponsorSnapshotFresh(snapshot: PersistedSponsorDirectory) {
	return Date.now() - snapshot.fetchedAt < getSponsorRefreshIntervalMs();
}

async function loadPersistedSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean
) {
	const snapshotDb = getSponsorSnapshotDb();
	if (!snapshotDb) return null;

	const key = getSponsorSnapshotKey(targetLogin, includePrivate);
	const persisted = fromPersistedSponsorDirectory(await snapshotDb.get(key));
	if (!persisted) {
		return null;
	}

	if (isSponsorDebugEnabled()) {
		console.info(
			`[githubSponsors] Loaded sponsor snapshot for "${targetLogin}" (includePrivate=${includePrivate}, fetchedAt=${new Date(persisted.fetchedAt).toISOString()}, sponsorCount=${persisted.sponsors.length}).`
		);
	}

	return persisted;
}

export async function getStoredSponsorSnapshots(): Promise<StoredSponsorSnapshot[]> {
	const targets = getSponsorTargets();
	const snapshots: StoredSponsorSnapshot[] = [];

	for (const targetLogin of targets) {
		for (const includePrivate of [true, false]) {
			const persisted = await loadPersistedSponsorDirectory(
				targetLogin,
				includePrivate
			);
			if (!persisted) {
				continue;
			}

			snapshots.push({
				targetLogin: persisted.targetLogin,
				includePrivate: persisted.includePrivate,
				viewerLogin: persisted.viewerLogin,
				sponsors: persisted.sponsors,
				fetchedAt: persisted.fetchedAt,
				isFresh: isSponsorSnapshotFresh(persisted),
				totalCount: persisted.totalCount,
				publicCount: persisted.publicCount,
				pastSponsors: Array.from(new Set([...persisted.pastSponsors, ...MANUAL_PAST_SPONSORS])),
				pastTotalCount: Math.max(persisted.pastTotalCount ?? 0, persisted.pastSponsors.length + MANUAL_PAST_SPONSORS.length),
				pastPublicCount: Math.max(persisted.pastPublicCount ?? 0, persisted.pastSponsors.length + MANUAL_PAST_SPONSORS.length),
			});
		}
	}

	return snapshots.sort((a, b) => b.fetchedAt - a.fetchedAt);
}

async function savePersistedSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean,
	directory: SponsorDirectory
) {
	const snapshotDb = getSponsorSnapshotDb();
	if (!snapshotDb) return;

	const key = getSponsorSnapshotKey(targetLogin, includePrivate);
	const persisted = toPersistedSponsorDirectory(
		targetLogin,
		includePrivate,
		directory
	);
	const saved = await snapshotDb.set(key, persisted);
	if (!saved) {
		console.warn(
			`[githubSponsors] Failed to persist sponsor snapshot for "${targetLogin}" (includePrivate=${includePrivate}).`
		);
	}
}

async function getHtmlFallbackSponsorDirectory(
	targetLogin: string,
	viewerLogin: string | null
) {
	const htmlDirectory = await fetchPublicSponsorDirectoryFromHtml(targetLogin);
	if (htmlDirectory.publicCount === 0) {
		return null;
	}

	console.info(
		`[githubSponsors] Falling back to public sponsor HTML for "${targetLogin}" (publicCount=${htmlDirectory.publicCount}, totalCount=${htmlDirectory.totalCount ?? "unknown"}).`
	);

	return {
		sponsors: new Set(htmlDirectory.sponsors),
		viewerLogin,
		totalCount: htmlDirectory.totalCount,
		publicCount: htmlDirectory.publicCount,
		pastSponsors: new Set(htmlDirectory.pastSponsors),
		pastTotalCount: htmlDirectory.pastTotalCount,
		pastPublicCount: htmlDirectory.pastPublicCount,
	} satisfies SponsorDirectory;
}

function assertRateLimitCooldownInactive() {
	if (sponsorRateLimitCooldownUntil > Date.now()) {
		throw new GitHubRateLimitError(
			`GitHub sponsor checks are cooling down until ${new Date(sponsorRateLimitCooldownUntil).toISOString()}.`,
			sponsorRateLimitCooldownUntil
		);
	}
}

function formatSponsorLogins(logins: string[], limit = 20) {
	if (logins.length === 0) return "(none)";
	if (logins.length <= limit) return logins.join(", ");

	return `${logins.slice(0, limit).join(", ")} ... (+${logins.length - limit} more)`;
}

function isGitHubNoreplyEmailForLogin(email: string, normalizedUsername: string) {
	const normalizedEmail = email.trim().toLowerCase();
	return (
		normalizedEmail === `${normalizedUsername}@users.noreply.github.com` ||
		normalizedEmail.endsWith(`+${normalizedUsername}@users.noreply.github.com`)
	);
}

function hasCoAuthorTrailerForLogin(
	message: string | undefined,
	normalizedUsername: string
) {
	if (!message) return false;

	const coAuthorTrailerPattern = /^co-authored-by:\s*.+?<([^>]+)>/gim;
	for (const match of message.matchAll(coAuthorTrailerPattern)) {
		const email = match[1];
		if (email && isGitHubNoreplyEmailForLogin(email, normalizedUsername)) {
			return true;
		}
	}

	return false;
}

function logSponsorPageResult(input: {
	targetLogin: string;
	pageNumber: number;
	includePrivate: boolean;
	viewerLogin: string | null;
	sponsors: string[];
	hasNextPage: boolean;
}) {
	if (!isSponsorDebugEnabled()) {
		return;
	}

	const { targetLogin, pageNumber, includePrivate, viewerLogin, sponsors, hasNextPage } =
		input;
	console.info(
		`[githubSponsors] Sponsors page ${pageNumber} for "${targetLogin}" (viewer=${viewerLogin ?? "unknown"}, includePrivate=${includePrivate}, count=${sponsors.length}, hasNextPage=${hasNextPage}): ${formatSponsorLogins(sponsors)}`
	);
}

function logStoredSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean,
	directory: SponsorDirectory
) {
	console.info(
		`[githubSponsors] Stored sponsor list for "${targetLogin}" (includePrivate=${includePrivate}, count=${directory.sponsors.size}): ${formatSponsorLogins(Array.from(directory.sponsors))}`
	);
}

function extractSponsorsSection(html: string, heading: "Current sponsors" | "Past sponsors") {
	const sectionMatch = html.match(
		new RegExp(
			`${heading}[\\s\\S]*?<div class="tmp-mt-3 tmp-pb-4" id="sponsors">([\\s\\S]*?)<\\/remote-pagination>`,
			"i"
		)
	);
	return sectionMatch?.[1] ?? null;
}

async function fetchPublicSponsorDirectoryFromHtml(
	targetLogin: string
): Promise<HtmlSponsorDirectory> {
	const response = await fetch(`https://github.com/sponsors/${targetLogin}`, {
		headers: {
			"User-Agent": "dungeon-blitz-discord-bot",
		},
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`GitHub Sponsors page request failed (${response.status}): ${text}`
		);
	}

	const html = await response.text();
	const totalCountMatch = html.match(
		/Current sponsors <span title="(\d+)"/i
	);
	const pastTotalCountMatch = html.match(
		/Past sponsors <span title="(\d+)"/i
	);
	const currentSection = extractSponsorsSection(html, "Current sponsors");
	const pastSection = extractSponsorsSection(html, "Past sponsors");
	if (!currentSection) {
		return {
			sponsors: [],
			totalCount: totalCountMatch ? Number(totalCountMatch[1]) : null,
			publicCount: 0,
			pastSponsors: [],
			pastTotalCount: pastTotalCountMatch ? Number(pastTotalCountMatch[1]) : null,
			pastPublicCount: 0,
		};
	}

	const loginMatches = Array.from(
		currentSection.matchAll(/href="\/([A-Za-z0-9-]+)"/g),
		(match) => normalizeLogin(match[1])
	);
	const pastLoginMatches = Array.from(
		(pastSection ?? "").matchAll(/href="\/([A-Za-z0-9-]+)"/g),
		(match) => normalizeLogin(match[1])
	);
	const uniqueSponsors = Array.from(new Set(loginMatches));
	const uniquePastSponsors = Array.from(new Set(pastLoginMatches));

	return {
		sponsors: uniqueSponsors,
		totalCount: totalCountMatch ? Number(totalCountMatch[1]) : null,
		publicCount: uniqueSponsors.length,
		pastSponsors: uniquePastSponsors,
		pastTotalCount: pastTotalCountMatch ? Number(pastTotalCountMatch[1]) : null,
		pastPublicCount: uniquePastSponsors.length,
	};
}

async function fetchSponsorPage(
	targetLogin: string,
	options?: {
		cursor?: string | null;
		includePrivate?: boolean;
	}
) {
	assertRateLimitCooldownInactive();

	const token = getGitHubToken();
	const includePrivate = options?.includePrivate ?? Boolean(token);
	const query = `
		query SponsorsByMaintainer(
			$login: String!
			$cursor: String
			$includePrivate: Boolean!
		) {
			viewer {
				login
			}
			repositoryOwner(login: $login) {
				__typename
				... on User {
					userSponsorships: sponsorshipsAsMaintainer(
						activeOnly: false
						includePrivate: $includePrivate
						first: 100
						after: $cursor
					) {
						pageInfo {
							hasNextPage
							endCursor
						}
						nodes {
							isActive
							sponsorEntity {
								... on User {
									login
								}
								... on Organization {
									login
								}
							}
						}
					}
				}
				... on Organization {
					organizationSponsorships: sponsorshipsAsMaintainer(
						activeOnly: false
						includePrivate: $includePrivate
						first: 100
						after: $cursor
					) {
						pageInfo {
							hasNextPage
							endCursor
						}
						nodes {
							isActive
							sponsorEntity {
								... on User {
									login
								}
								... on Organization {
									login
								}
							}
						}
					}
				}
			}
		}
	`;

	const response = await fetch(GITHUB_GRAPHQL_URL, {
		method: "POST",
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			variables: {
				login: targetLogin,
				cursor: options?.cursor ?? null,
				includePrivate,
			},
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		if (response.status === 403 && text.toLowerCase().includes("rate limit")) {
			const retryAfterHeader = response.headers.get("retry-after");
			const resetHeader = response.headers.get("x-ratelimit-reset");
			const retryAfterMs = retryAfterHeader
				? Number(retryAfterHeader) * 1000
				: null;
			const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : null;
			const retryAt = Math.max(
				Date.now() + getSponsorRateLimitCooldownMs(),
				retryAfterMs ? Date.now() + retryAfterMs : 0,
				resetAtMs ?? 0
			);
			throw new GitHubRateLimitError(
				`GitHub GraphQL request failed (${response.status}): ${text}`,
				retryAt
			);
		}
		throw new Error(
			`GitHub GraphQL request failed (${response.status}): ${text}`
		);
	}

	const payload = (await response.json()) as SponsorsResponse;
	if (payload.errors?.length) {
		throw new Error(
			`GitHub GraphQL errors: ${payload.errors
				.map((error) => error.message)
				.join(", ")}`
		);
	}

	const owner = payload.data?.repositoryOwner;
	const source = owner?.userSponsorships ?? owner?.organizationSponsorships;

	if (!source) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Sponsor query returned no sponsorshipsAsMaintainer for "${targetLogin}" (owner type: ${owner?.__typename ?? "unknown"}).`
			);
		}
		return {
			hasNextPage: false,
			endCursor: null as string | null,
			viewerLogin: payload.data?.viewer?.login ?? null,
			sponsors: [] as string[],
			pastSponsors: [] as string[],
		};
	}

	return {
		hasNextPage: source.pageInfo.hasNextPage,
		endCursor: source.pageInfo.endCursor,
		viewerLogin: payload.data?.viewer?.login ?? null,
		sponsors: source.nodes
			.filter((node) => node.isActive)
			.map((node) => node.sponsorEntity?.login?.toLowerCase())
			.filter((login): login is string => Boolean(login)),
		pastSponsors: source.nodes
			.filter((node) => !node.isActive)
			.map((node) => node.sponsorEntity?.login?.toLowerCase())
			.filter((login): login is string => Boolean(login)),
	};
}

async function getSponsorDirectory(
	targetLogin: string,
	forceRefresh: boolean = false
): Promise<SponsorDirectory> {
	const token = getGitHubToken();
	const includePrivate = Boolean(token);
	const cacheKey = getSponsorDirectoryCacheKey(targetLogin, includePrivate);
	
	if (!forceRefresh) {
		const cached = getCachedResult(sponsorDirectoryCache, cacheKey);
		if (cached) {
			if (isSponsorDebugEnabled()) {
				console.info(
					`[githubSponsors] Sponsor directory cache hit for "${targetLogin}" (includePrivate=${includePrivate}).`
				);
			}
			return cached;
		}
	}

	const inflight = sponsorDirectoryInflight.get(cacheKey);
	if (inflight) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Waiting for in-flight sponsor directory fetch for "${targetLogin}" (includePrivate=${includePrivate}).`
			);
		}
		return inflight;
	}

	const persisted = await loadPersistedSponsorDirectory(targetLogin, includePrivate);
	if (!forceRefresh && persisted && isSponsorSnapshotFresh(persisted)) {
		let directory = {
			sponsors: new Set(persisted.sponsors),
			viewerLogin: persisted.viewerLogin,
			totalCount: persisted.totalCount,
			publicCount: persisted.publicCount,
			pastSponsors: new Set(persisted.pastSponsors),
			pastTotalCount: persisted.pastTotalCount,
			pastPublicCount: persisted.pastPublicCount,
		};
		if (
			directory.sponsors.size === 0 ||
			directory.totalCount === null ||
			directory.publicCount === null ||
			directory.pastTotalCount === null ||
			directory.pastPublicCount === null
		) {
			try {
				const htmlFallback = await getHtmlFallbackSponsorDirectory(
					targetLogin,
					persisted.viewerLogin
				);
				if (htmlFallback) {
					directory = {
						sponsors:
							directory.sponsors.size > 0
								? directory.sponsors
								: htmlFallback.sponsors,
						viewerLogin: htmlFallback.viewerLogin,
						totalCount: htmlFallback.totalCount,
						publicCount: htmlFallback.publicCount,
						pastSponsors:
							directory.pastSponsors.size > 0
								? directory.pastSponsors
								: htmlFallback.pastSponsors,
						pastTotalCount: htmlFallback.pastTotalCount,
						pastPublicCount: htmlFallback.pastPublicCount,
					};
					await savePersistedSponsorDirectory(
						targetLogin,
						includePrivate,
						directory
					);
				}
			} catch (error) {
				console.warn(
					`[githubSponsors] Public sponsor HTML fallback failed for fresh snapshot "${targetLogin}": ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
		}
		setCachedResult(
			sponsorDirectoryCache,
			cacheKey,
			directory,
			getSponsorCacheTtlMs()
		);
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Using fresh weekly sponsor snapshot for "${targetLogin}" (includePrivate=${includePrivate}).`
			);
		}
		return directory;
	}

	const promise = (async () => {
		assertRateLimitCooldownInactive();
		const sponsors = new Set<string>();
		const pastSponsors = new Set<string>();
		let viewerLogin: string | null = null;
		let cursor: string | null = null;
		let pageNumber = 1;

		while (pageNumber <= 20) {
			const page = await fetchSponsorPage(targetLogin, {
				cursor,
				includePrivate,
			});
			viewerLogin = page.viewerLogin;
			logSponsorPageResult({
				targetLogin,
				pageNumber,
				includePrivate,
				viewerLogin: page.viewerLogin,
				sponsors: page.sponsors,
				hasNextPage: page.hasNextPage,
			});

			if (pageNumber === 1 && page.sponsors.length === 0 && token) {
				const publicPage = await fetchSponsorPage(targetLogin, {
					includePrivate: false,
				});
				logSponsorPageResult({
					targetLogin,
					pageNumber: 1,
					includePrivate: false,
					viewerLogin: publicPage.viewerLogin,
					sponsors: publicPage.sponsors,
					hasNextPage: publicPage.hasNextPage,
				});
			}

			for (const sponsor of page.sponsors) {
				sponsors.add(sponsor);
			}
			for (const pastSponsor of page.pastSponsors) {
				pastSponsors.add(pastSponsor);
			}

			if (!page.hasNextPage || !page.endCursor) {
				let directory: SponsorDirectory = {
					sponsors,
					viewerLogin,
					totalCount: sponsors.size,
					publicCount: sponsors.size,
					pastSponsors,
					pastTotalCount: pastSponsors.size,
					pastPublicCount: pastSponsors.size,
				};
				if (directory.sponsors.size === 0) {
					try {
						const htmlFallback = await getHtmlFallbackSponsorDirectory(
							targetLogin,
							viewerLogin
						);
						if (htmlFallback) {
							directory = htmlFallback;
						}
					} catch (error) {
						console.warn(
							`[githubSponsors] Public sponsor HTML fallback failed for "${targetLogin}": ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				}

				await savePersistedSponsorDirectory(
					targetLogin,
					includePrivate,
					directory
				);
				setCachedResult(
					sponsorDirectoryCache,
					cacheKey,
					directory,
					getSponsorCacheTtlMs()
				);
				return directory;
			}

			cursor = page.endCursor;
			pageNumber += 1;
		}

		console.warn(
			`[githubSponsors] Pagination limit reached while fetching sponsor directory for "${targetLogin}".`
		);
		let directory: SponsorDirectory = {
			sponsors,
			viewerLogin,
			totalCount: sponsors.size,
			publicCount: sponsors.size,
			pastSponsors,
			pastTotalCount: pastSponsors.size,
			pastPublicCount: pastSponsors.size,
		};
		if (directory.sponsors.size === 0) {
			try {
				const htmlFallback = await getHtmlFallbackSponsorDirectory(
					targetLogin,
					viewerLogin
				);
				if (htmlFallback) {
					directory = htmlFallback;
				}
			} catch (error) {
				console.warn(
					`[githubSponsors] Public sponsor HTML fallback failed for "${targetLogin}" after pagination cap: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
		}
		await savePersistedSponsorDirectory(targetLogin, includePrivate, directory);
		setCachedResult(
			sponsorDirectoryCache,
			cacheKey,
			directory,
			getSponsorCacheTtlMs()
		);
		return directory;
	})()
		.catch((error) => {
			if (error instanceof GitHubRateLimitError) {
				noteRateLimitCooldown(error.retryAt, `target="${targetLogin}"`);
			}
			if (persisted) {
				console.warn(
					`[githubSponsors] Falling back to stale sponsor snapshot for "${targetLogin}" fetched at ${new Date(persisted.fetchedAt).toISOString()}.`
				);
				const staleDirectory = {
					sponsors: new Set(persisted.sponsors),
					viewerLogin: persisted.viewerLogin,
					totalCount: persisted.totalCount,
					publicCount: persisted.publicCount,
					pastSponsors: new Set(persisted.pastSponsors),
					pastTotalCount: persisted.pastTotalCount,
					pastPublicCount: persisted.pastPublicCount,
				};
				setCachedResult(
					sponsorDirectoryCache,
					cacheKey,
					staleDirectory,
					getSponsorCacheTtlMs()
				);
				return staleDirectory;
			}
			throw error;
		})
		.finally(() => {
			sponsorDirectoryInflight.delete(cacheKey);
		});

	sponsorDirectoryInflight.set(cacheKey, promise);
	return promise;
}

async function isUserSponsoringTarget(
	githubUsername: string,
	targetLogin: string
): Promise<boolean> {
	const normalizedUsername = githubUsername.toLowerCase();

	if (MANUAL_PAST_SPONSORS.includes(normalizedUsername)) {
		console.info(`[githubSponsors] Matched manual past sponsor "${normalizedUsername}" for target "${targetLogin}".`);
		return true;
	}

	const includePrivate = Boolean(getGitHubToken());
	let directory = await getSponsorDirectory(targetLogin);
	let isSponsor =
		directory.sponsors.has(normalizedUsername) ||
		directory.pastSponsors.has(normalizedUsername);

	if (!isSponsor) {
		console.info(
			`[githubSponsors] Sponsor "${normalizedUsername}" not found in snapshot for "${targetLogin}". Force refreshing...`
		);
		directory = await getSponsorDirectory(targetLogin, true);
		isSponsor =
			directory.sponsors.has(normalizedUsername) ||
			directory.pastSponsors.has(normalizedUsername);
	}

	logStoredSponsorDirectory(targetLogin, includePrivate, directory);

	if (isSponsor) {
		console.info(
			`[githubSponsors] Matched sponsor "${normalizedUsername}" for target "${targetLogin}".`
		);
		return true;
	}

	console.info(
		`[githubSponsors] No sponsor match for "${normalizedUsername}" on target "${targetLogin}".`
	);
	return false;
}

export async function getDiscordGithubUsername(accessToken: string) {
	const response = await fetch("https://discord.com/api/v10/users/@me/connections", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		const text = await response.text();
		console.error(
			`[githubSponsors] Discord connections fetch failed (${response.status}): ${text}`
		);
		return null;
	}

	const connections = (await response.json()) as DiscordConnection[];
	const githubConnection = connections.find(
		(connection) =>
			connection.type === "github" &&
			typeof connection.name === "string" &&
			connection.name.length > 0
	);

	return githubConnection?.name ?? null;
}

export async function getSponsorMatch(githubUsername: string) {
	const token = getGitHubToken();
	if (!token) {
		console.warn(
			shouldForcePublicSponsors()
				? "[githubSponsors] GITHUB_SPONSOR_FORCE_PUBLIC=true; checking public sponsorships only."
				: "[githubSponsors] GITHUB_TOKEN is not set; checking public sponsorships only."
		);
	}

	if (isSponsorDebugEnabled()) {
		console.info(
			`[githubSponsors] Sponsor check mode: ${token ? "token-authenticated" : "public-only"}.`
		);
	}

	const targets = getSponsorTargets();
	const resultCacheKey = getSponsorResultCacheKey(
		githubUsername,
		targets,
		token ? "token" : "public"
	);
	const cached = getCachedResult(sponsorResultCache, resultCacheKey);
	if (cached) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Sponsor result cache hit for "${normalizeLogin(githubUsername)}".`
			);
		}
		return cached;
	}

	console.info(
		`[githubSponsors] Checking sponsor status for "${normalizeLogin(githubUsername)}" against targets: ${targets.join(", ")}`
	);

	for (const target of targets) {
		try {
			const isSponsor = await isUserSponsoringTarget(githubUsername, target);
			if (isSponsor) {
				const result = { isSponsor: true, matchedTarget: target };
				setCachedResult(
					sponsorResultCache,
					resultCacheKey,
					result,
					getSponsorCacheTtlMs()
				);
				return result;
			}
		} catch (error) {
			if (error instanceof GitHubRateLimitError) {
				console.warn(
					`[githubSponsors] Sponsor check paused by rate limit: ${error.message}`
				);
				break;
			}
			console.warn(
				`[githubSponsors] Sponsor check failed for target "${target}": ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	const result = { isSponsor: false, matchedTarget: null as string | null };
	setCachedResult(
		sponsorResultCache,
		resultCacheKey,
		result,
		getSponsorCacheTtlMs()
	);
	return result;
}

async function isUserContributorOfPrivateRepo(
	githubUsername: string
): Promise<boolean> {
	const token = process.env.GITHUB_TOKEN?.trim();
	if (!token) {
		console.warn(
			"[githubSponsors] GITHUB_TOKEN is not set; contributor check skipped (Contributor will be false)."
		);
		return false;
	}

	const owner =
		process.env.GITHUB_CONTRIBUTOR_REPO_OWNER?.trim() ?? "theminesastudios";
	const repo =
		process.env.GITHUB_CONTRIBUTOR_REPO_NAME?.trim() ??
		"dungeon-blitz-r";

	const normalizedUsername = normalizeLogin(githubUsername);
	const encodedOwner = encodeURIComponent(owner);
	const encodedRepo = encodeURIComponent(repo);

	const perPage = 100;
	let page = 1;

	while (page <= 10) {
		const url = `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/contributors?per_page=${perPage}&anon=0&page=${page}`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(
				`[githubSponsors] Contributor check failed (${response.status}): ${text}`
			);
			return false;
		}

		const contributors = (await response.json()) as Array<{
			login?: string;
		}>;

		if (!Array.isArray(contributors) || contributors.length === 0) {
			break;
		}

		if (
			contributors.some(
				(c) => c.login && normalizeLogin(c.login) === normalizedUsername
			)
		) {
			return true;
		}

		const link = response.headers.get("link") ?? "";
		if (!link.includes('rel="next"')) {
			break;
		}

		page += 1;
	}

	const commitSearchQuery = encodeURIComponent(
		`repo:${owner}/${repo} ${normalizedUsername}`
	);
	const commitSearchResponse = await fetch(
		`https://api.github.com/search/commits?q=${commitSearchQuery}&per_page=10`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
			},
		}
	);

	if (!commitSearchResponse.ok) {
		const text = await commitSearchResponse.text();
		console.error(
			`[githubSponsors] Commit co-author search failed (${commitSearchResponse.status}): ${text}`
		);
		return false;
	}

	const commitSearch = (await commitSearchResponse.json()) as CommitSearchResponse;
	if (
		commitSearch.items?.some((commit) =>
			hasCoAuthorTrailerForLogin(commit.commit?.message, normalizedUsername)
		)
	) {
		return true;
	}

	return false;
}

export async function getContributorMatch(githubUsername: string) {
	const isContributor = await isUserContributorOfPrivateRepo(githubUsername);
	return { isContributor };
}
