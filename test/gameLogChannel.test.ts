import assert from "node:assert/strict";
import {
	DEFAULT_LOG_CHANNEL_ID,
	buildGameLogEmbed,
	cleanText,
	publishGameLog,
	resolveGameLogDeliverer,
	resolveLogChannelId,
	type GameLogDeliverer,
	type GameLogEmbed,
} from "../src/utils/gameLogChannel.js";

// The log channel carries the game server's own lifecycle: it started, it is
// stopping, or it is about to die of an exception. Two things matter and are
// pinned here — the message reads correctly in Discord, and a delivery failure
// can never take down the shutdown or the crash handler that is reporting.

const fixedNow = new Date("2026-09-20T10:00:00.000Z");

function collectingDeliverer(result: string | null = "discord-channel:test"): GameLogDeliverer & {
	embeds: GameLogEmbed[];
} {
	const embeds: GameLogEmbed[] = [];
	return {
		channel: result ?? "none",
		embeds,
		deliver: async (embed) => {
			embeds.push(embed);
			return result;
		},
	};
}

// --- embed shape -----------------------------------------------------------

const started = buildGameLogEmbed(
	{
		event: "started",
		host: "dungeonblitzr.theminesa.studio",
		fields: [
			{ name: "Version", value: "1.6.0", inline: true },
			{ name: "Ports", value: "80 / 843 / 8080", inline: true },
		],
	},
	fixedNow,
);
assert.equal(started.title, "🟢 Game server started");
assert.equal(started.color, 0x2ecc71, "a start is green");
assert.equal(started.timestamp, fixedNow.toISOString());
assert.equal(started.footer?.text, "dungeonblitzr.theminesa.studio");
assert.equal(started.fields?.length, 2);
assert.equal(started.fields?.[0]?.inline, true);
assert.equal(started.description, undefined, "no message means no empty description");

const crashed = buildGameLogEmbed(
	{ event: "crashed", message: "uncaughtException: Cannot read properties of null" },
	fixedNow,
);
assert.equal(crashed.title, "🛑 Game server crashed");
assert.equal(crashed.color, 0xe74c3c, "a crash is red");
assert.equal(crashed.description, "uncaughtException: Cannot read properties of null");

const stopping = buildGameLogEmbed({ event: "stopping", message: "SIGTERM" }, fixedNow);
assert.equal(stopping.title, "🟡 Game server shutting down");

const failedStart = buildGameLogEmbed({ event: "startup-failed", message: "Mongo refused" }, fixedNow);
assert.equal(failedStart.color, 0x992d22, "a failed start is a darker red than a crash");

// An event the bot has never heard of still produces a readable line instead of an
// empty embed: the server side may grow events before this side knows them.
const unknown = buildGameLogEmbed({ event: "world-saved", message: "flushed" }, fixedNow);
assert.match(unknown.title, /world-saved/);
assert.equal(unknown.color, 0x5865f2);

// A caller-supplied title wins over the built-in one.
const custom = buildGameLogEmbed({ event: "started", title: "🟢 Back after a restart" }, fixedNow);
assert.equal(custom.title, "🟢 Back after a restart");

// A timestamp the caller sends is honoured; nonsense falls back to now.
assert.equal(
	buildGameLogEmbed({ event: "started", at: "2026-09-20T09:00:00.000Z" }, fixedNow).timestamp,
	"2026-09-20T09:00:00.000Z",
);
assert.equal(buildGameLogEmbed({ event: "started", at: "not-a-date" }, fixedNow).timestamp, fixedNow.toISOString());

// --- sanitising ------------------------------------------------------------

assert.equal(cleanText("a\u0000b\u0007c", 100), "abc", "control characters are stripped");
assert.equal(cleanText("line1\n\n\n\n\nline2", 100), "line1\n\nline2", "blank-line runs collapse");
assert.equal(cleanText("  padded  ", 100), "padded");
assert.equal(cleanText("x".repeat(50), 10).length, 10, "hard cap, ellipsis included");

const longMessage = buildGameLogEmbed({ event: "crashed", message: "y".repeat(9_000) }, fixedNow);
assert.ok((longMessage.description?.length ?? 0) <= 4000, "an enormous stack cannot exceed Discord's limit");
assert.ok(longMessage.description?.endsWith("…"));

const noisyFields = buildGameLogEmbed(
	{
		event: "crashed",
		fields: [
			{ name: " ", value: "dropped" },
			{ name: "empty", value: "   " },
			{ name: "Kept", value: "z".repeat(2_000) },
		],
	},
	fixedNow,
);
assert.equal(noisyFields.fields?.length, 1, "blank names and values are dropped");
assert.ok((noisyFields.fields?.[0]?.value.length ?? 0) <= 1024);

const cappedFields = buildGameLogEmbed(
	{ event: "crashed", fields: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: "v" })) },
	fixedNow,
);
assert.equal(cappedFields.fields?.length, 25, "Discord allows 25 fields");

const nullFields = buildGameLogEmbed({ event: "crashed", fields: [] as any }, fixedNow);
assert.equal(nullFields.fields, undefined, "no usable fields means no fields array");

// --- channel resolution ----------------------------------------------------

assert.equal(DEFAULT_LOG_CHANNEL_ID, "1551118889503432765");
assert.equal(resolveLogChannelId({} as NodeJS.ProcessEnv), DEFAULT_LOG_CHANNEL_ID);
assert.equal(
	resolveLogChannelId({ DISCORD_LOG_CHANNEL_ID: " 999 " } as NodeJS.ProcessEnv),
	"999",
	"an explicit channel id wins over the default",
);

const botDeliverer = resolveGameLogDeliverer({
	DISCORD_BOT_TOKEN: "token",
} as NodeJS.ProcessEnv);
assert.equal(
	botDeliverer?.channel,
	`discord-channel:${DEFAULT_LOG_CHANNEL_ID}`,
	"with only a bot token the built-in log channel is used",
);

// The live deployment has both a bot token and the alert webhook, and the bot is
// not allowed in the log channel — so the webhook has to win, or every message
// fails while a working transport sits unused.
const bothConfigured = resolveGameLogDeliverer({
	DISCORD_BOT_TOKEN: "token",
	GAME_HEALTH_WEBHOOK_URL: "https://discord.com/api/webhooks/1/2",
} as NodeJS.ProcessEnv);
assert.equal(bothConfigured?.channel, "discord-webhook", "the alert webhook outranks a token for the default channel");

// Naming the channel explicitly is the operator saying the bot may post there,
// so that wins over the webhook — but never over an explicit log webhook.
const explicitChannel = resolveGameLogDeliverer({
	DISCORD_BOT_TOKEN: "token",
	DISCORD_LOG_CHANNEL_ID: "4242",
	GAME_HEALTH_WEBHOOK_URL: "https://discord.com/api/webhooks/1/2",
} as NodeJS.ProcessEnv);
assert.equal(explicitChannel?.channel, "discord-channel:4242");

const explicitLogWebhook = resolveGameLogDeliverer({
	DISCORD_LOG_WEBHOOK_URL: "https://discord.com/api/webhooks/9/9",
	DISCORD_BOT_TOKEN: "token",
	DISCORD_LOG_CHANNEL_ID: "4242",
} as NodeJS.ProcessEnv);
assert.equal(explicitLogWebhook?.channel, "discord-webhook");

assert.equal(resolveGameLogDeliverer({} as NodeJS.ProcessEnv), null, "nothing configured means no deliverer");

// --- publishing ------------------------------------------------------------

const recorder = collectingDeliverer();
const sent = await publishGameLog({ event: "started", host: "h" }, { deliver: recorder, now: fixedNow });
assert.equal(sent.sent, true);
assert.equal(sent.channel, "discord-channel:test");
assert.equal(recorder.embeds.length, 1);
assert.equal(recorder.embeds[0]?.title, "🟢 Game server started");

// Discord refusing the message reports the failure instead of claiming success.
const refused = await publishGameLog({ event: "started" }, { deliver: collectingDeliverer(null), now: fixedNow });
assert.equal(refused.sent, false);
assert.equal(refused.error, "delivery failed");

// A throw from the transport is contained: publishGameLog never rejects.
const throwing: GameLogDeliverer = {
	channel: "explodes",
	deliver: async () => {
		throw new Error("socket hang up");
	},
};
const survived = await publishGameLog({ event: "crashed" }, { deliver: throwing, now: fixedNow });
assert.equal(survived.sent, false);
assert.equal(survived.error, "socket hang up");

// Nothing configured is a diagnosable no-op rather than a silent one.
const unconfigured = await publishGameLog({ event: "crashed" }, { deliver: null, now: fixedNow });
assert.equal(unconfigured.sent, false);
assert.match(String(unconfigured.error), /no log channel configured/);

console.log("[gameLogChannel] all assertions passed");
