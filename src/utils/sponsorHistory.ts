/**
 * Donation history behind a player's Royal Sigils: every GitHub Sponsors payment (monthly and
 * one-time) and every Patreon charge, plus when a sponsorship started, was cancelled or came back.
 * $1 paid is 100 Royal Sigils, so the totals here are in cents and one cent is one sigil.
 */

export type SponsorSource = "github" | "patreon";

export type SponsorEventKind =
	| "subscribed"
	| "resubscribed"
	| "cancelled"
	| "tier-change"
	| "one-time"
	| "payment"
	| "refund";

export type SponsorEvent = {
	atMs: number;
	source: SponsorSource;
	kind: SponsorEventKind;
	/** What the event paid (negative for a refund); 0 for an event that moved no money. */
	cents: number;
	tierName?: string | null;
};

export type SponsorHistory = {
	events: SponsorEvent[];
	totalCents: number;
	active: boolean;
	fetchedAtMs: number;
};

/* ------------------------------------------------------------------
 * GitHub Sponsors
 * ------------------------------------------------------------------ */

export type GithubSponsorActivity = {
	action: string;
	timestamp: string;
	sponsorLogin: string;
	tier: { monthlyPriceInCents: number; isOneTime: boolean; name: string | null } | null;
};

/** Monthly charges on the start day and every month after it, up to (not including) `endMs`. */
function monthlyCharges(startMs: number, endMs: number, cents: number, tierName: string | null): SponsorEvent[] {
	const charges: SponsorEvent[] = [];
	const start = new Date(startMs);
	for (let month = 0; month < 1200; month += 1) {
		const at = Date.UTC(
			start.getUTCFullYear(),
			start.getUTCMonth() + month,
			Math.min(start.getUTCDate(), daysInMonth(start.getUTCFullYear(), start.getUTCMonth() + month)),
			start.getUTCHours(),
			start.getUTCMinutes(),
		);
		if (at >= endMs) break;
		charges.push({ atMs: at, source: "github", kind: "payment", cents, tierName });
	}
	return charges;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Rebuilds a sponsor's payments from their GitHub Sponsors activity. GitHub has no payment
 * ledger, so a monthly sponsorship is charged on its start day and every month after it until
 * it is cancelled; a tier change re-prices the charges from that day on. A one-time sponsorship
 * is one payment.
 */
export function githubEventsFromActivities(
	activities: GithubSponsorActivity[],
	nowMs: number,
): SponsorEvent[] {
	const sorted = [...activities]
		.map((activity) => ({ ...activity, atMs: Date.parse(activity.timestamp) }))
		.filter((activity) => Number.isFinite(activity.atMs))
		.sort((a, b) => a.atMs - b.atMs);

	const events: SponsorEvent[] = [];
	let running: { startMs: number; cents: number; tierName: string | null } | null = null;
	let everSubscribed = false;

	const close = (endMs: number) => {
		if (!running) return;
		events.push(...monthlyCharges(running.startMs, endMs, running.cents, running.tierName));
		running = null;
	};

	for (const activity of sorted) {
		const tier = activity.tier;
		const tierName = tier?.name ?? null;
		const cents = Math.max(0, Math.round(tier?.monthlyPriceInCents ?? 0));
		switch (activity.action) {
			case "NEW_SPONSORSHIP":
				if (tier?.isOneTime) {
					events.push({ atMs: activity.atMs, source: "github", kind: "one-time", cents, tierName });
					break;
				}
				close(activity.atMs);
				events.push({
					atMs: activity.atMs,
					source: "github",
					kind: everSubscribed ? "resubscribed" : "subscribed",
					cents: 0,
					tierName,
				});
				everSubscribed = true;
				running = { startMs: activity.atMs, cents, tierName };
				break;
			case "CANCELLED_SPONSORSHIP":
				if (tier?.isOneTime) break;
				close(activity.atMs);
				events.push({ atMs: activity.atMs, source: "github", kind: "cancelled", cents: 0, tierName });
				break;
			case "TIER_CHANGE":
				if (!running || tier?.isOneTime) break;
				events.push({ atMs: activity.atMs, source: "github", kind: "tier-change", cents: 0, tierName });
				{
					const previous: { startMs: number; cents: number; tierName: string | null } = running;
					// The month already paid keeps its price; the next charge uses the new tier.
					const nextCharge = monthlyCharges(previous.startMs, Number.MAX_SAFE_INTEGER, 0, null)
						.find((charge) => charge.atMs > activity.atMs)?.atMs;
					if (nextCharge === undefined) break;
					close(nextCharge);
					running = { startMs: nextCharge, cents, tierName };
				}
				break;
			case "REFUND":
				events.push({ atMs: activity.atMs, source: "github", kind: "refund", cents: -cents, tierName });
				break;
		}
	}
	close(nowMs + 1);
	return events.filter((event) => event.atMs <= nowMs);
}

/* ------------------------------------------------------------------
 * Patreon
 * ------------------------------------------------------------------ */

export type PatreonPledgeEvent = {
	type: string;
	date: string;
	amountCents: number;
	paymentStatus: string | null;
	tierTitle: string | null;
};

export function patreonEventsFromPledges(pledges: PatreonPledgeEvent[]): SponsorEvent[] {
	const sorted = [...pledges]
		.map((pledge) => ({ ...pledge, atMs: Date.parse(pledge.date) }))
		.filter((pledge) => Number.isFinite(pledge.atMs))
		.sort((a, b) => a.atMs - b.atMs);
	const events: SponsorEvent[] = [];
	let everSubscribed = false;
	for (const pledge of sorted) {
		const base = { atMs: pledge.atMs, source: "patreon" as const, tierName: pledge.tierTitle };
		const cents = Math.max(0, Math.round(pledge.amountCents));
		switch (pledge.type) {
			case "pledge_start":
				events.push({ ...base, kind: everSubscribed ? "resubscribed" : "subscribed", cents: 0 });
				everSubscribed = true;
				break;
			case "pledge_delete":
				events.push({ ...base, kind: "cancelled", cents: 0 });
				break;
			case "pledge_upgrade":
			case "pledge_downgrade":
				events.push({ ...base, kind: "tier-change", cents: 0 });
				break;
			case "subscription":
				if (pledge.paymentStatus?.toLowerCase() === "paid") {
					events.push({ ...base, kind: "payment", cents });
				}
				break;
		}
	}
	return events;
}

/* ------------------------------------------------------------------
 * Combining and formatting
 * ------------------------------------------------------------------ */

export function buildSponsorHistory(events: SponsorEvent[], nowMs: number): SponsorHistory {
	const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
	const totalCents = Math.max(0, sorted.reduce((sum, event) => sum + event.cents, 0));
	const active = (["github", "patreon"] as const).some((source) => {
		const last = sorted.filter((event) => event.source === source && event.kind !== "payment" && event.kind !== "refund" && event.kind !== "one-time").at(-1);
		return last !== undefined && last.kind !== "cancelled";
	});
	return { events: sorted, totalCents, active, fetchedAtMs: nowMs };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SOURCE_LABEL: Record<SponsorSource, string> = { github: "GitHub", patreon: "Patreon" };

function dollars(cents: number): string {
	return `$${(Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function sigils(cents: number): string {
	return `${Math.abs(cents).toLocaleString("en-US")} Royal Sigils`;
}

function eventLine(event: SponsorEvent): string {
	const source = SOURCE_LABEL[event.source];
	const tier = event.tierName ? ` (${event.tierName})` : "";
	const day = new Date(event.atMs).getUTCDate();
	switch (event.kind) {
		case "subscribed":
			return `- ${day}: subscribed on ${source}${tier}`;
		case "resubscribed":
			return `- ${day}: subscribed again on ${source}${tier}`;
		case "cancelled":
			return `- ${day}: cancelled on ${source}`;
		case "tier-change":
			return `- ${day}: changed tier on ${source}${tier}`;
		case "one-time":
			return `- ${day}: one-time ${dollars(event.cents)} on ${source} · +${sigils(event.cents)}`;
		case "payment":
			return `- ${day}: monthly ${dollars(event.cents)} on ${source} · +${sigils(event.cents)}`;
		case "refund":
			return `- ${day}: refund ${dollars(event.cents)} on ${source} · −${sigils(event.cents)}`;
	}
}

/** The history grouped by month, newest first, as markdown lines. `maxMonths` keeps it inside a message. */
export function formatSponsorHistory(history: SponsorHistory, maxMonths = 12): string[] {
	if (history.events.length === 0) return ["No donations found."];
	const months = new Map<string, SponsorEvent[]>();
	for (const event of history.events) {
		const date = new Date(event.atMs);
		const key = `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
		months.set(key, [...(months.get(key) ?? []), event]);
	}
	const entries = [...months.entries()].reverse();
	const lines: string[] = [];
	for (const [month, events] of entries.slice(0, maxMonths)) {
		lines.push(`**${month}**`, ...events.map(eventLine));
	}
	if (entries.length > maxMonths) lines.push(`-# ${entries.length - maxMonths} older months not shown`);
	return lines;
}

/* ------------------------------------------------------------------
 * Fetching
 * ------------------------------------------------------------------ */

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

function githubTargets(): string[] {
	const raw = process.env.GITHUB_SPONSOR_TARGETS?.trim();
	return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : ["theminesastudios"];
}

let githubCache: { atMs: number; activities: GithubSponsorActivity[] } | null = null;

/** Every sponsor activity of the sponsored accounts, newest page first. Needs a token of the sponsored account. */
async function fetchAllGithubActivities(): Promise<GithubSponsorActivity[]> {
	if (githubCache && Date.now() - githubCache.atMs < CACHE_TTL_MS) return githubCache.activities;
	const token = process.env.GITHUB_TOKEN?.trim();
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const query = `
		query SponsorActivities($login: String!, $cursor: String) {
			repositoryOwner(login: $login) {
				... on Sponsorable {
					sponsorsActivities(first: 100, after: $cursor, period: ALL, includePrivate: true) {
						pageInfo { hasNextPage endCursor }
						nodes {
							action
							timestamp
							sponsor { ... on User { login } ... on Organization { login } }
							sponsorsTier { monthlyPriceInCents isOneTime name }
						}
					}
				}
			}
		}
	`;
	const activities: GithubSponsorActivity[] = [];
	for (const login of githubTargets()) {
		let cursor: string | null = null;
		for (let page = 0; page < 50; page += 1) {
			const response = await fetch(GITHUB_GRAPHQL_URL, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				body: JSON.stringify({ query, variables: { login, cursor } }),
			});
			if (!response.ok) throw new Error(`GitHub sponsor activity request failed (${response.status})`);
			const payload = (await response.json()) as {
				data?: {
					repositoryOwner?: {
						sponsorsActivities?: {
							pageInfo: { hasNextPage: boolean; endCursor: string | null };
							nodes: Array<{
								action: string;
								timestamp: string;
								sponsor: { login?: string } | null;
								sponsorsTier: { monthlyPriceInCents: number; isOneTime: boolean; name: string | null } | null;
							}>;
						};
					} | null;
				};
				errors?: Array<{ message: string }>;
			};
			if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join(", "));
			const connection = payload.data?.repositoryOwner?.sponsorsActivities;
			for (const node of connection?.nodes ?? []) {
				if (!node.sponsor?.login) continue;
				activities.push({
					action: node.action,
					timestamp: node.timestamp,
					sponsorLogin: node.sponsor.login.toLowerCase(),
					tier: node.sponsorsTier,
				});
			}
			if (!connection?.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
			cursor = connection.pageInfo.endCursor;
		}
	}
	githubCache = { atMs: Date.now(), activities };
	return activities;
}

export async function fetchGithubSponsorEvents(githubUsername: string, nowMs = Date.now()): Promise<SponsorEvent[]> {
	const login = githubUsername.trim().toLowerCase();
	const activities = (await fetchAllGithubActivities()).filter((activity) => activity.sponsorLogin === login);
	return githubEventsFromActivities(activities, nowMs);
}

type PatreonMember = { discordId: string | null; pledges: PatreonPledgeEvent[] };
let patreonCache: { atMs: number; members: PatreonMember[] } | null = null;

export function isPatreonConfigured(): boolean {
	return Boolean(process.env.PATREON_ACCESS_TOKEN?.trim() && process.env.PATREON_CAMPAIGN_ID?.trim());
}

/** Every member of the campaign with their Discord id (from Patreon's Discord connection) and pledge history. */
async function fetchPatreonMembers(): Promise<PatreonMember[]> {
	if (patreonCache && Date.now() - patreonCache.atMs < CACHE_TTL_MS) return patreonCache.members;
	const token = process.env.PATREON_ACCESS_TOKEN!.trim();
	const campaign = process.env.PATREON_CAMPAIGN_ID!.trim();
	const params = new URLSearchParams({
		include: "user,pledge_history",
		"fields[member]": "patron_status",
		"fields[user]": "social_connections",
		"fields[pledge-event]": "amount_cents,date,payment_status,tier_title,type",
		"page[count]": "500",
	});
	let url: string | null = `https://www.patreon.com/api/oauth2/v2/campaigns/${encodeURIComponent(campaign)}/members?${params}`;
	const members: PatreonMember[] = [];
	for (let page = 0; url && page < 50; page += 1) {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`Patreon members request failed (${response.status})`);
		type Ref = { id: string; type: string };
		const payload = (await response.json()) as {
			data: Array<{ relationships?: { user?: { data?: Ref | null }; pledge_history?: { data?: Ref[] } } }>;
			included?: Array<{ id: string; type: string; attributes?: Record<string, unknown> }>;
			links?: { next?: string };
		};
		const included = new Map((payload.included ?? []).map((item) => [`${item.type}:${item.id}`, item.attributes ?? {}]));
		for (const member of payload.data ?? []) {
			const userRef = member.relationships?.user?.data;
			const user = userRef ? included.get(`user:${userRef.id}`) : undefined;
			const connections = user?.social_connections as { discord?: { user_id?: string } | null } | undefined;
			const pledges = (member.relationships?.pledge_history?.data ?? []).map((ref) => {
				const attributes = included.get(`pledge-event:${ref.id}`) ?? {};
				return {
					type: String(attributes.type ?? ""),
					date: String(attributes.date ?? ""),
					amountCents: Number(attributes.amount_cents ?? 0),
					paymentStatus: attributes.payment_status ? String(attributes.payment_status) : null,
					tierTitle: attributes.tier_title ? String(attributes.tier_title) : null,
				};
			});
			members.push({ discordId: connections?.discord?.user_id ?? null, pledges });
		}
		url = payload.links?.next ?? null;
	}
	patreonCache = { atMs: Date.now(), members };
	return members;
}

export async function fetchPatreonEvents(discordId: string): Promise<SponsorEvent[]> {
	if (!isPatreonConfigured()) return [];
	const member = (await fetchPatreonMembers()).find((entry) => entry.discordId === discordId.trim());
	return member ? patreonEventsFromPledges(member.pledges) : [];
}

/**
 * The player's combined history. A source that cannot be reached right now is left out and
 * reported in `errors`, so the caller can fall back to the history it stored last time.
 */
export async function loadSponsorHistory(input: {
	discordId: string;
	githubUsername: string | null;
	nowMs?: number;
}): Promise<{ history: SponsorHistory; errors: string[] }> {
	const nowMs = input.nowMs ?? Date.now();
	const errors: string[] = [];
	const [github, patreon] = await Promise.all([
		input.githubUsername
			? fetchGithubSponsorEvents(input.githubUsername, nowMs).catch((error) => {
					errors.push(`GitHub: ${error instanceof Error ? error.message : String(error)}`);
					return [];
				})
			: Promise.resolve([]),
		fetchPatreonEvents(input.discordId).catch((error) => {
			errors.push(`Patreon: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}),
	]);
	return { history: buildSponsorHistory([...github, ...patreon], nowMs), errors };
}
