import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request state for the Cloudflare Worker. Workers cannot reuse an I/O object (a
 * MongoDB socket) across requests, so database clients live in the request's scope and
 * are closed once the response and its background work are done. Outside a scope (tests,
 * scripts) everything falls back to one process-wide cache, as before.
 */
type Scope = {
	waitUntil: (promise: Promise<unknown>) => void;
	cache: Map<object, unknown>;
	pending: Set<Promise<unknown>>;
	cleanups: Array<() => Promise<unknown> | unknown>;
};

const storage = new AsyncLocalStorage<Scope>();
const globalCache = new Map<object, unknown>();

export function runInRequestScope<T>(
	waitUntil: (promise: Promise<unknown>) => void,
	run: () => Promise<T>,
): { result: Promise<T>; finished: Promise<void> } {
	const scope: Scope = { waitUntil, cache: new Map(), pending: new Set(), cleanups: [] };
	const result = storage.run(scope, run);
	track(scope, result);
	const finished = (async () => {
		while (scope.pending.size > 0) {
			await Promise.allSettled([...scope.pending]);
		}
		await Promise.allSettled(scope.cleanups.map((cleanup) => cleanup()));
	})();
	return { result, finished };
}

function track(scope: Scope, promise: Promise<unknown>): void {
	const settled = promise.then(
		() => undefined,
		() => undefined,
	);
	scope.pending.add(settled);
	void settled.then(() => scope.pending.delete(settled));
}

/** Keeps background work alive after the response has been sent. */
export function waitUntil(promise: Promise<unknown>): void {
	const scope = storage.getStore();
	if (!scope) {
		void Promise.resolve(promise).catch(() => {});
		return;
	}
	track(scope, promise);
	scope.waitUntil(promise.catch(() => {}));
}

/**
 * A value created once per request (once per process outside a request). A rejected
 * promise is dropped so the next call retries.
 */
export function requestCached<T>(
	create: () => T,
	dispose?: (value: Awaited<T>) => Promise<unknown> | unknown,
): { get(): T; clear(): void } {
	const key = {};
	const cacheFor = () => storage.getStore()?.cache ?? globalCache;
	return {
		get() {
			const cache = cacheFor();
			if (cache.has(key)) return cache.get(key) as T;
			const value = create();
			cache.set(key, value);
			if (value instanceof Promise) {
				value.catch(() => {
					if (cache.get(key) === value) cache.delete(key);
				});
			}
			const scope = storage.getStore();
			if (scope && dispose) {
				scope.cleanups.push(async () => dispose(await value));
			}
			return value;
		},
		clear() {
			cacheFor().delete(key);
		},
	};
}
