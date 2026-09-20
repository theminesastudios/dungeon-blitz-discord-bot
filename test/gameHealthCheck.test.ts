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
		resolve4: async () => ["35.241.250.170"],
		fetchPage: async () => ({ status: 200 }),
		fetchHttpsPage: async () => ({ status: 200 }),
		inspectTls: async () => ({
			status: "ok" as const,
			daysRemaining: 60,
			expiresAt: "2026-12-19T00:00:00.000Z",
			issuer: "Let's Encrypt",
		}),
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
	assert.equal(healthy.https.status, "ok");
	assert.equal(healthy.tls.status, "ok");
	assert.equal(healthy.tls.daysRemaining, 60);
	assert.match(summarizeGameHealth(healthy), /TLS cert: valid, 60 day/);
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

	// HTTPS dead (Caddy down, 443 closed) while HTTP still answers: degraded.
	// Players' browsers auto-upgrade to https first, so this is alert-worthy.
	const httpsDead = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		fetchHttpsPage: async () => {
			throw new Error("connect ETIMEDOUT");
		},
	});
	assert.equal(httpsDead.overall, "degraded");
	assert.equal(httpsDead.https.status, "error");
	assert.match(summarizeGameHealth(httpsDead), /HTTPS page: failed/);

	// TLS handshake fails (no listener on 443): degraded, classified as error.
	const tlsError = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		inspectTls: async () => ({ status: "error", error: "ECONNREFUSED" }),
	});
	assert.equal(tlsError.overall, "degraded");
	assert.equal(tlsError.tls.status, "error");

	// Expired certificate: degraded, explicitly called out as expired.
	const tlsExpired = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		inspectTls: async () => ({ status: "error", error: "certificate has expired" }),
	});
	assert.equal(tlsExpired.overall, "degraded");
	assert.equal(tlsExpired.tls.status, "expired");
	assert.match(summarizeGameHealth(tlsExpired), /TLS cert: EXPIRED/);

	// Warn window: certWarnDays controls the expiring/ok boundary.
	const outsideWindow = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		certWarnDays: 14,
	});
	assert.equal(outsideWindow.tls.status, "ok");
	const insideWindow = await checkGameHealth({
		now: fixedNow,
		...okProbes(),
		certWarnDays: 90,
	});
	assert.equal(insideWindow.tls.status, "expiring");
	assert.equal(insideWindow.overall, "healthy", "an expiring cert warns; it is not an outage");

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

	// Certificate expiry: one warning when the cert enters the warn window,
	// silence on repeats, exactly one confirmation when it is renewed.
	{
		const { sent, deliverer } = collectingDeliverer();
		const store = memoryStore();
		const expiringProbes = () => ({
			...okProbes(),
			inspectTls: async () => ({
				status: "ok" as const,
				daysRemaining: 9,
				expiresAt: "2026-09-29T00:00:00.000Z",
			}),
		});

		const expiring = await checkGameHealth({ now: fixedNow, ...expiringProbes() });
		assert.equal(expiring.overall, "healthy", "an expiring cert is a warning, not an outage");
		assert.equal(expiring.tls.status, "expiring");

		const first = await maybeAlertOnGameHealth(expiring, {
			store,
			deliver: deliverer,
			now: fixedNow,
		});
		assert.equal(first.sent, true);
		assert.equal(first.kind, "warning");
		assert.match(sent[0]!, /expires in 9 day/);

		// Still expiring on the next check: the warning does not repeat.
		const repeat = await maybeAlertOnGameHealth(
			await checkGameHealth({ now: fixedNow, ...expiringProbes() }),
			{ store, deliver: deliverer, now: new Date(fixedNow.getTime() + 30 * 60_000) },
		);
		assert.equal(repeat.sent, false);
		assert.equal(sent.length, 1);

		// Renewed: exactly one confirmation, then quiet again.
		const renewed = await maybeAlertOnGameHealth(
			await checkGameHealth({ now: fixedNow, ...okProbes() }),
			{ store, deliver: deliverer, now: new Date(fixedNow.getTime() + 60 * 60_000) },
		);
		assert.equal(renewed.sent, true);
		assert.equal(renewed.kind, "warning");
		assert.match(sent[1]!, /renewed/);

		const quiet = await maybeAlertOnGameHealth(
			await checkGameHealth({ now: fixedNow, ...okProbes() }),
			{ store, deliver: deliverer, now: new Date(fixedNow.getTime() + 90 * 60_000) },
		);
		assert.equal(quiet.sent, false);
		assert.equal(sent.length, 2);
	}

	// A degraded host whose cert happens to be expiring: no cert warning while
	// the outage alert machinery owns the conversation.
	{
		const { sent, deliverer } = collectingDeliverer();
		const store = memoryStore();
		const down = await checkGameHealth({
			now: fixedNow,
			...okProbes(),
			inspectTls: async () => ({
				status: "ok" as const,
				daysRemaining: 9,
				expiresAt: "2026-09-29T00:00:00.000Z",
			}),
			connectSocket: async () => ({ status: "refused", error: "ECONNREFUSED" }),
		});
		assert.equal(down.overall, "degraded");
		const result = await maybeAlertOnGameHealth(down, {
			store,
			deliver: deliverer,
			now: fixedNow,
		});
		assert.equal(result.kind, "alert");
		assert.equal(result.sent, true);
		assert.equal(sent.length, 1);
		const stored = store.records.get(down.hostname);
		assert.equal(stored?.certWarningOpen, false, "cert warning state stays closed during outages");
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
