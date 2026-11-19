import { MiniDatabase } from "@minesa-org/mini-interaction";
import { requestCached } from "./requestScope.js";

/**
 * A MiniDatabase whose MongoDB connection belongs to the current request, since a Worker
 * cannot reuse a socket opened by another request. Created lazily on first use.
 */
export function requestScopedMiniDatabase(): MiniDatabase {
	const cache = requestCached(
		() => MiniDatabase.fromEnv(),
		(database) => (database as unknown as { mongoClient?: { close(): Promise<void> } }).mongoClient?.close(),
	);
	return new Proxy({} as MiniDatabase, {
		get(overrides, property) {
			if (Object.hasOwn(overrides, property)) return (overrides as any)[property];
			const database = cache.get() as unknown as Record<PropertyKey, unknown>;
			const value = database[property];
			return typeof value === "function" ? value.bind(database) : value;
		},
	});
}
