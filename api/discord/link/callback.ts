const DEFAULT_LOCAL_CALLBACK_URL = "http://localhost:8000/api/discord/link/callback";

function resolveCallbackBaseUrl(): string {
	const configured = String(
		process.env.DUNGEON_BLITZ_ACCOUNT_LINK_CALLBACK_URL ??
			process.env.DUNGEON_BLITZ_LOCAL_CALLBACK_URL ??
			""
	).trim();

	return configured || DEFAULT_LOCAL_CALLBACK_URL;
}

function appendQueryString(baseUrl: string, query: Record<string, unknown>): string {
	const target = new URL(baseUrl);
	for (const [key, value] of Object.entries(query)) {
		if (value == null) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				target.searchParams.append(key, String(item));
			}
			continue;
		}

		target.searchParams.set(key, String(value));
	}

	return target.toString();
}

export default function handler(req: any, res: any) {
	const redirectTo = appendQueryString(resolveCallbackBaseUrl(), req.query ?? {});
	res.setHeader("Cache-Control", "no-store");
	res.redirect(302, redirectTo);
}
