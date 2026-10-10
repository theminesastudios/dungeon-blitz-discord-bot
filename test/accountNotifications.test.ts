import assert from "node:assert/strict";
import {
	buildNotificationsPanel,
	NOTIFICATIONS_TOGGLE_ID,
} from "../src/commands/account.js";

function button(panel: ReturnType<typeof buildNotificationsPanel>) {
	const row = JSON.parse(JSON.stringify(panel.components[0])) as {
		components: Array<{ custom_id: string; label: string }>;
	};
	return row.components[0];
}

const on = buildNotificationsPanel(true);
assert.match(on.embeds[0].description, /Status: \*\*On\*\*/);
assert.equal(button(on).label, "Turn off");
assert.equal(button(on).custom_id, NOTIFICATIONS_TOGGLE_ID);

const off = buildNotificationsPanel(false);
assert.match(off.embeds[0].description, /Status: \*\*Off\*\*/);
assert.equal(button(off).label, "Turn on");
assert.equal(button(off).custom_id, NOTIFICATIONS_TOGGLE_ID);

console.log("accountNotifications.test: ok");
