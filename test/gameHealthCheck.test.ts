import assert from "node:assert/strict";
import {
	checkGameHealth,
	maybeAlertOnGameHealth,
	summarizeGameHealth,
	type GameHealthStateRecord,
	type GameHealthStateStore,
} from "../src/utils/gameHealthCheck.js";

// The health check must catch the failure mode that actually happened: the game
// hostname silently stopped resolving. Probes are injected here — no network.

const fixedNow = new Date("2026-09-19T12:00:00.000Z");

function okProbes() {
	return {
		resolve4: async () => ["35.185.71.109"],
		fetchPage: async () => ({ status: 200 }),
		connectSocket: async (port: number) =>
			port === 843 ? { status: "ok" as const, answeredPolicy: true } : { status: "ok" as const },
	};
}

function memoryStore(initial?: GameHealthStateRecord): GameHealthStateStore & { records: Map<string, GameHealthStateRecord> } {
	const records = new Map<string, GameHealthStateRecord>();
	if (initial) records.set(initial._id, initial);
	return {
		records,
		async findOne(query) {
			return records.get(query._id) ?? null;
		},
		async upsert(record) {
			records.set(record._id, record);
		},
	};
}

function collectingDeliverer() {
	const sent: string[] = [];
	return {
		sent,
		deliverer: {
			channel: "test",
			deliver: async (text: string) => {
				sent.push(text);
				return "test";
			},
		},
	};
}

async function main() {
	// Healthy host: everything ok, no alert.
	const healthy = await checkGameHealth({ now: fixedNow, ...okProbes() });
	assert.equal(healthy.overall, "healthy");
	assert.equal(healthy.dns.status, "ok");
	assert.equal(healthy.page.status, "ok");
	assert.equal(healthy.socket843.answeredPolicy, true);
	assert.equal(healthy.socket8080.status, "ok");

	// THE outage: NXDOMAIN is "down" even though the server itself is fine.
	const nxdomain = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		resolve4: async () => [],
	});
	assert.equal(nxdomain.overall, "down");
	assert.equal(nxdomain.dns.status, "nxdomain");
	assert.match(summarizeGameHealth(nxdomain), /does not resolve/);

	// DNS poisoning / wrong record: a mismatch must also read as down.
	const mismatch = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		resolve4: async () => ["203.0.113.9"],
	});
	assert.equal(mismatch.overall, "down");
	assert.equal(mismatch.dns.status, "mismatch");

	// Sockets dead but site up: degraded, not down.
	const degraded = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		connectSocket: async () => ({ status: "refused", error: "ECONNREFUSED" }),
	});
	assert.equal(degraded.overall, "degraded");

	// First unhealthy check alerts; a follow-up inside the reminder window stays quiet.
	{
		const { sent, deliverer } = collectingDeliverer();
		const store = memoryStore();
		const report = await checkGameHealth({ now: fixedNow, ...okProbes(), resolve4: async () => [] });
		const first = await maybeAlertOnGameHealth(report, {
			store,
			deliver: deliverer,
			now: fixedNow,
		});
		assert.equal(first.sent, true);
		assert.equal(first.kind, "alert");
		assert.equal(sent.length, 1);

		const second = await maybeAlertOnGameHealth(report, {
			store,
			deliver: deliverer,
			now: new Date(fixedNow.getTime() + 10 * 60_000),
		});
		assert.equal(second.sent, false, "no reminder inside the quiet window");
		assert.equal(sent.length, 1);

		const reminder = await maybeAlertOnGameHealth(report, {
			store,
			deliver: deliverer,
			now: new Date(fixedNow.getTime() + 61 * 60_000),
		});
		assert.equal(reminder.kind, "reminder");
		assert.equal(reminder.sent, true);
		assert.equal(sent.length, 2);
		assert.match(sent[1]!, /Still down/);
	}

	// Recovery after an open alert: exactly one recovery message.
	{
		const { sent, deliverer } = collectingDeliverer();
		const store = memoryStore();
		const down = await checkGameHealth({ now: fixedNow, ...okProbes(), resolve4: async () => [] });
		await maybeAlertOnGameHealth(down, { store, deliver: deliverer, now: fixedNow });
		const recovered = await checkGameHealth({ now: fixedNow, ...okProbes() });
		const recovery = await maybeAlertOnGameHealth(recovered, {
			store,
			deliver: deliverer,
			now: new Date(fixedNow.getTime() + 5 * 60_000),
		});
		assert.equal(recovery.sent, true);
		assert.equal(recovery.kind, "recovery");
		assert.match(sent[1]!, /recovered/);
		const stored = store.records.get(recovered.hostname);
		assert.equal(stored?.alertOpen, false);
	}

	// Healthy with no open alert: silent.
	{
		const { sent, deliverer } = collectingDeliverer();
		const healthy = await checkGameHealth({ now: fixedNow, ...okProbes() });
		const result = await maybeAlertOnGameHealth(healthy, {
			store: memoryStore(),
			deliver: deliverer,
			now: fixedNow,
		});
		assert.equal(result.kind, null);
		assert.equal(sent.length, 0);
	}

	// No channel configured: the alert is not silently swallowed.
	{
		const store = memoryStore();
		const down = await checkGameHealth({ now: fixedNow, ...okProbes(), resolve4: async () => [] });
		const result = await maybeAlertOnGameHealth(down, {
			store,
			deliver: null,
			now: fixedNow,
		});
		assert.equal(result.sent, false);
		assert.match(result.error ?? "", /no alert channel configured/);
	}
}

main().then(
	() => console.log("game health check tests passed"),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
