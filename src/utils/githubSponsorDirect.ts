const DEFAULT_TARGETS = ["theminesastudios"];
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

function normalizeLogin(login: string) {
	return login.trim().toLowerCase();
}

function getSponsorTargets() {
	const raw = process.env.GITHUB_SPONSOR_TARGETS?.trim();
	if (!raw) return DEFAULT_TARGETS;

	return raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function getGitHubToken() {
	if (
		process.env.GITHUB_SPONSOR_FORCE_PUBLIC?.trim().toLowerCase() === "true"
	) {
		return null;
	}

	return process.env.GITHUB_TOKEN?.trim() || null;
}

async function isAccountSponsoringTarget(
	githubUsername: string,
	targetLogin: string
) {
	const token = getGitHubToken();
	const query = `
		query DirectSponsorCheck($targetLogin: String!, $sponsorLogin: String!) {
			repositoryOwner(login: $targetLogin) {
				... on User {
					isSponsoredBy(accountLogin: $sponsorLogin)
				}
				... on Organization {
					isSponsoredBy(accountLogin: $sponsorLogin)
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
				targetLogin,
				sponsorLogin: githubUsername,
			},
		}),
	});

	if (!response.ok) {
		throw new Error(
			`GitHub direct sponsor check failed (${response.status}): ${await response.text()}`
		);
	}

	const payload = (await response.json()) as {
		data?: {
			repositoryOwner?: {
				isSponsoredBy?: boolean;
			} | null;
		};
		errors?: Array<{ message: string }>;
	};

	if (payload.errors?.length) {
		throw new Error(
			`GitHub direct sponsor check errors: ${payload.errors
				.map((error) => error.message)
				.join(", ")}`
		);
	}

	return payload.data?.repositoryOwner?.isSponsoredBy === true;
}

export async function getDirectSponsorMatch(githubUsername: string) {
	const normalizedUsername = normalizeLogin(githubUsername);

	for (const targetLogin of getSponsorTargets()) {
		try {
			const isSponsor = await isAccountSponsoringTarget(
				normalizedUsername,
				targetLogin
			);
			console.info(
				`[githubSponsorDirect] Exact sponsor check for "${normalizedUsername}" on "${targetLogin}": ${isSponsor}`
			);
			if (isSponsor) {
				return { isSponsor: true, matchedTarget: targetLogin };
			}
		} catch (error) {
			console.warn(
				`[githubSponsorDirect] Exact sponsor check failed for "${normalizedUsername}" on "${targetLogin}": ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	return { isSponsor: false, matchedTarget: null as string | null };
}
