/**
 * Runs the Vercel-style `(req, res)` handlers in api/ on a Fetch `Request`. The response
 * is returned as soon as the handler ends it; whatever the handler does afterwards keeps
 * running as background work of the request.
 */
export type NodeStyleHandler = (req: any, res: any) => unknown;

type Query = Record<string, string | string[]>;

function parseQuery(url: URL): Query {
	const query: Query = {};
	for (const [key, value] of url.searchParams) {
		const existing = query[key];
		if (existing === undefined) query[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else query[key] = [existing, value];
	}
	return query;
}

function parseBody(raw: Buffer, contentType: string): unknown {
	if (raw.length === 0) return undefined;
	const type = contentType.split(";")[0].trim().toLowerCase();
	const text = raw.toString("utf8");
	if (type === "application/json" || type.endsWith("+json")) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	if (type === "application/x-www-form-urlencoded") {
		return Object.fromEntries(new URLSearchParams(text));
	}
	if (type.startsWith("text/")) return text;
	return raw;
}

export async function createNodeRequest(request: Request) {
	const url = new URL(request.url);
	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const raw =
		request.method === "GET" || request.method === "HEAD"
			? Buffer.alloc(0)
			: Buffer.from(await request.arrayBuffer());
	return {
		method: request.method,
		url: `${url.pathname}${url.search}`,
		headers,
		query: parseQuery(url),
		body: parseBody(raw, headers["content-type"] ?? ""),
		rawBody: raw,
		async *[Symbol.asyncIterator]() {
			if (raw.length > 0) yield raw;
		},
	};
}

export function createNodeResponse() {
	let resolveResponse!: (response: Response) => void;
	const response = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	const headers = new Headers();
	const res = {
		statusCode: 200,
		headersSent: false,
		setHeader(name: string, value: unknown) {
			headers.delete(name);
			for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
			return res;
		},
		getHeader(name: string) {
			return headers.get(name) ?? undefined;
		},
		removeHeader(name: string) {
			headers.delete(name);
		},
		writeHead(statusCode: number, extra?: Record<string, unknown>) {
			res.statusCode = statusCode;
			for (const [name, value] of Object.entries(extra ?? {})) res.setHeader(name, value);
			return res;
		},
		status(statusCode: number) {
			res.statusCode = statusCode;
			return res;
		},
		json(payload: unknown) {
			if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
			return res.end(JSON.stringify(payload));
		},
		send(payload: unknown) {
			if (payload !== null && typeof payload === "object" && !Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
				return res.json(payload);
			}
			if (typeof payload === "string" && !headers.has("content-type")) {
				headers.set("content-type", "text/html; charset=utf-8");
			}
			return res.end(payload);
		},
		redirect(statusOrUrl: number | string, maybeUrl?: string) {
			const [statusCode, location] =
				typeof statusOrUrl === "number" ? [statusOrUrl, maybeUrl ?? "/"] : [302, statusOrUrl];
			res.statusCode = statusCode;
			headers.set("location", location);
			return res.end();
		},
		end(payload?: unknown) {
			if (res.headersSent) return res;
			res.headersSent = true;
			const body =
				payload === undefined || payload === null || res.statusCode === 204 || res.statusCode === 304
					? null
					: typeof payload === "string" || payload instanceof Uint8Array
						? payload
						: String(payload);
			resolveResponse(new Response(body as BodyInit | null, { status: res.statusCode, headers }));
			return res;
		},
	};
	return { res, response };
}

export async function runNodeHandler(
	handler: NodeStyleHandler,
	request: Request,
): Promise<{ response: Promise<Response>; completion: Promise<unknown> }> {
	const req = await createNodeRequest(request);
	const { res, response } = createNodeResponse();
	const completion = Promise.resolve()
		.then(() => handler(req, res))
		.then(
			() => {
				if (!res.headersSent) res.status(500).json({ error: "Handler returned without a response." });
			},
			(error) => {
				console.error("[worker] handler failed:", error);
				if (!res.headersSent) res.status(500).json({ error: "Internal Server Error" });
			},
		);
	return { response, completion };
}
