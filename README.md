# Dungeon Blitz Discord Bot

This Discord bot designed for the Dungeon Blitz: R—The Minesa Studios Discord server. It handles integrations with GitHub and game stuffs.

## Commands

- `/account create` sends an owner-bound Discord OAuth link. A MongoDB-backed game account and complete empty save document are created only after Discord returns a verified email; the player then sets the initial password through the message button and modal.
- `/account reset-password` opens an owner-scoped modal and replaces the linked game account's password hash.
- `/account view` privately shows the linked account's Discord email, game user ID, and password setup state.
- `/authorize [connection]` sends owner-bound Discord OAuth links that connect a player's Discord account to the game's Discord surfaces: the Game Stats widget on their profile, the Social SDK's friends and rich presence, and its lobbies and chat. `connection` picks one; without it the reply offers a link for each, plus an "everything" link that authorizes them together. Links expire after 10 minutes and only the player who invoked the command can complete them.
- `/sponsor-info github_username` lets administrators inspect the visible GitHub sponsorship tier, status, and estimated total.
- `/add-credits player dollars [note]` lets administrators add shop credit to a linked player, converting donated dollars 1:1 into spendable credit. It stacks on top of the player's GitHub-reported donation total, is audited on the player's profile, and can be spent in `/packs` like sponsor credit.
- `/idols player operation amount` lets administrators atomically add or subtract Mammoth Idols. Player autocomplete displays the character's current Idols, Gold, and Dragon Keys.
- `/profile player` lets administrators inspect a linked Discord/GitHub profile and the player's current wallet values across the current game saves and legacy wallet stores.
- `/packs` opens the sponsor pack shop. It writes each pack's rewards straight into the chosen character's save: credit is deducted (or the one-time Sponsor Pack claim recorded) before the rewards roll, and a purchase whose rewards cannot be written is refunded automatically.
- `/pack-rewards player [character] [reset-credit]` removes the mounts and legendary dyes the shop wrote into a player's save, and with `reset-credit` also clears their pack purchase history so a pack can be bought again. Rewards are written to the stored save, so run it while the target character is out of game — the game server owns the save of a character that is online.
- `/widget-status [player]` (administrator only) reports what is standing between a player and a working Game Stats profile widget: the application's game-stats access, the game server's scope switch, the connections the player authorized, the record Discord actually stores, and the payload the sync would send (built in dry-run mode, so it writes nothing).
- `/add-credits`, `/pack-rewards`, `/widget-status` and `/maintenance` are administrator commands; they require the invoking member to hold Discord Administrator permissions.

The `/maintenance` and `/idols` commands require matching `DISCORD_MAINTENANCE_API_SECRET` values in the bot and game-server environments. The game server defaults to `http://35.185.71.109`; override it with `GAME_SERVER_BASE_URL` in the bot deployment when the game moves.

If `/maintenance` or `/idols` replies with `503 "Discord admin API is not configured"`, the **game server** has no admin secret configured: add `ADMIN_API_SECRET` (or `DISCORD_MAINTENANCE_API_SECRET`) to the game server's `src/server/.env` with the same value as the bot's `DISCORD_MAINTENANCE_API_SECRET`, then restart it (`pm2 restart dungeon-mp`). Conversely, if the bot is missing `DISCORD_MAINTENANCE_API_SECRET`, the commands fail before any request is sent; set it in the bot deployment environment and redeploy.

## Game wallet database

The wallet commands use `MONGODB_URI` by default. The current game schema is read from the `saves` collection, where each account document contains a `characters[]` array. Legacy flat `minidb` and `wallets` documents remain supported for compatibility. Production deployments are sourced from the repository's `main` branch. A separate game database can be selected with:

- `GAME_MONGODB_URI`
- `GAME_MONGODB_DB_NAME`
- `MONGODB_SAVES_COLLECTION` (default `saves`)
- `GAME_WALLET_COLLECTION` (legacy flat wallet collection)

## Game account database

`/account create` writes the complete account and save records to the game MongoDB database after Discord OAuth verifies the invoking user's email. It uses `GAME_MONGODB_URI` (falling back to `MONGODB_URI`) and `GAME_MONGODB_DB_NAME` (falling back to `MONGODB_DB_NAME`, then `minidb`). The legacy sponsor database variable `MONGO_DB_NAME` is deliberately not used for game accounts. Optional collection overrides are:

- `MONGODB_ACCOUNTS_COLLECTION` (default `accounts`)
- `MONGODB_SAVES_COLLECTION` (default `saves`)
- `MONGODB_COUNTERS_COLLECTION` (default `counters`)

Account OAuth state is HMAC-signed with `ACCOUNT_OAUTH_STATE_SECRET`, or with `DISCORD_CLIENT_SECRET` when a dedicated state secret is not configured. Links expire after 10 minutes and can only be completed by the Discord user who invoked `/account create`. `/authorize` links are signed the same way (`OAUTH_STATE_SECRET` first, then the same fallbacks) and carry which connection they authorize, so one callback route serves both flows while keeping them apart.

## Game health monitoring

The bot exposes an independent health check for the game host at `/api/game-health`. It resolves the game hostname, fetches a site page over **both HTTP and HTTPS**, inspects the TLS certificate on :443, and probes both game sockets (843 policy server, 8080 game protocol) **from Vercel's network** — a vantage point that catches DNS and routing outages that look perfectly healthy from the server itself. The 2026-09 outage, where the `dungeonblitzr` A record went missing during a DNS migration and nobody noticed for hours, is what this guards against; the HTTPS/TLS checks cover the 2026-09-20 addition of Caddy on 443 — a dead Caddy, a closed 443, or an unrenewed certificate all alert.

Verdicts:

- **down** — DNS does not resolve/point at the expected IP, or the HTTP page fails. Everything else being up cannot make this less than down.
- **degraded** — the HTTPS page fails, the TLS certificate is expired or fails verification, or either game socket is dead. Some or all players cannot get in even though the deployment answers.
- **healthy** — everything answers. A certificate inside the expiry warn window still reads healthy but sends a one-time ⚠️ warning (and a ✅ confirmation when it is renewed), because Caddy normally renews automatically and the alert exists to catch that silently stopping.

A summary JSON is returned to any caller; alerting is only evaluated for authenticated requests:

- On a down/degraded verdict it sends one alert, repeats hourly (`GAME_HEALTH_REMINDER_MINUTES`), and sends one recovery message when the host is healthy again. Alert state is deduped in MongoDB (`game_health_state` collection).
- The game server pings the endpoint every 5 minutes (`HEALTH_PING_URL`/`HEALTH_PING_SECRET` in the game server's `.env`), and a Vercel cron hits it daily as a VM-independent fallback. Requests authenticated with `HEALTH_CHECK_SECRET` (or `CRON_SECRET`, which Vercel cron presents) arm alerting.

To receive the alerts, set exactly one of these in the bot deployment:

- `GAME_HEALTH_WEBHOOK_URL` — a Discord webhook URL; or
- `GAME_HEALTH_ALERT_DISCORD_ID` — your Discord user ID (the bot DMs you; requires `DISCORD_BOT_TOKEN`, already set).

Optional: `GAME_HEALTH_EXPECTED_IP` overrides the expected VM address (default `35.241.250.170`, the reserved IP attached to `dungeon-blitz-eu`), and `GAME_HEALTH_REMINDER_MINUTES` caps the reminder cadence.

And set the same secret value as the game server's `HEALTH_PING_SECRET` in the bot's `HEALTH_CHECK_SECRET`.

## Discord Game Stats Widget

Linked players can show their Dungeon Blitz character on their Discord profile. Discord renders the widget from a profile record this bot writes through the [Application Identity Profile API](https://docs.discord.com/developers/resources/application-identity-profile) — Discord never reads the game server, so the bot has to push each player's data.

The identity is: Discord user id = the account's `discordId`, provider-issued user id = the account's game `user_id`. That is a 1:1 mapping of what `/account create` already stores, so no extra linking step is needed.

### Why some widget fields stay empty

The game persists a character's name, class, level and currencies, but **not** lifetime wins, kills, deaths, games or playtime — a run's deaths live only inside that run (`DungeonRunStats`), and the save keeps only per-character wallet values. The sync therefore maps the fields that have real data and leaves `total_wins`, `total_games`, `total_kills`, `total_assists`, `total_deaths`, `playtime_hours` and `rank_name` unset rather than filling them with invented numbers. Track those counters in the save (or a stats collection) and the sync can start sending them.

### Dynamic field keys

Configure the widget's **User Data** fields to these keys; renaming one in the portal without renaming it in `GAME_STATS_DYNAMIC_FIELDS` (`src/utils/gameStatsSync.ts`) silently stops rendering it.

| Field key | Value |
| --- | --- |
| `featured_played_character` | The player's highest-level character name |
| `featured_played_character_image` | That character's portrait, from `<GAME_SERVER_BASE_URL>/portraits/<name>.png` (omit when no base URL is configured) |
| `character_class` | Featured character's class |
| `master_class` | Featured character's discipline (`Flameseer`, `Soulthief`, …), from the save's numeric `MasterClass`; omitted while none is chosen, so give the field a fallback |
| `character_level` | Featured character's level |
| `highest_level` | Highest level on the account |
| `gold`, `mammoth_idols`, `dragon_keys`, `dragon_ore`, `silver_sigils` | Featured character's wallet |
| `character_count` | Characters on the save |
| `season` | Optional, from `GAME_STATS_SEASON` |

### Portal setup

1. [Claim the game](https://docs.discord.com/developers/platform/claim-your-game), then open **Games → Widget** in the Developer Portal.
2. Choose a layout for **Widget Top**, **Widget Bottom** and **Add Widget Preview** (all three are required before publishing).
3. In each layout's **Content** tab, set the stat fields to **User Data** with the keys above. Number fields accept the numeric keys; the portrait field must be a media field pointing at `featured_played_character_image`.
4. Optional: enable a field's **Fallback** (for example `rank_name` → `"Unranked"`) so the widget still renders for players without data.
5. Upload any images you reference on the **Assets** page and set them to **Public** — non-public assets render as skeleton placeholders.
6. Use the **Sample Data** tab to preview, then **Publish** when all three surfaces are configured.

Unpublished widgets can still be tested by your developer team, so the endpoint below is worth running before you publish.

### Scope and re-linking

Widget writes need a player who authorized the application with `application_identities.write`. It is requested only while the widget scope is switched on, and that switch lives in **one place**: `WIDGET_SCOPE_ENABLED` on the game server. Both Discord flows read it — the game server for its own login/link URL, and this bot for `/account create` and the verification page, read from `/api/auth/discord/config` — so they cannot drift into asking for different scopes.

It is off by default because Discord approves game stats per application, an unapproved application is refused the scope with `invalid_scope`, and that refusal fails the **entire** authorization — so asking unconditionally stopped `/account create` and the in-game Discord login from working at all, with nothing a player could do about it.

The bot reads the switch fail-closed: an unreachable game server means account scopes only, which can only ever under-ask. The answer is cached for five minutes. Once Discord approves the application, set `WIDGET_SCOPE_ENABLED=1` on the game server and restart it, then have players re-link to pick the scope up.

`/authorize` is the re-link that does not recreate anything: it hands out an owner-bound link asking for one connection's scopes (the widget's own link asks for `application_identities.write`, and only while the switch is on), so a player who linked before the widget existed can grant it with one click. The scopes for the other connections are the Social SDK's — `sdk.social_layer_presence` for friends and rich presence, `sdk.social_layer` for lobbies and chat — and Discord documents them as already covering `application_identities.write`, which is why a player who authorizes either one is also reported as widget-authorized. The result page names the connections Discord actually granted, records them on the account, and publishes the widget profile immediately; it also spells out the step only the player can take, adding the widget to their profile: **profile → Add Widget → Dungeon Blitz → Add to profile**.

### When the widget is empty, or the profile will not save

Discord puts four independent gates in front of a widget, and from the player's side they all
look the same. `/widget-status [player]` checks all four and names the one that is closed:

| Gate | Cleared where |
| --- | --- |
| The application is approved for game stats | Developer Portal: Social SDK enabled, game claimed |
| `WIDGET_SCOPE_ENABLED` is on | the game server's environment, then restart it |
| The player granted `application_identities.write` | the player runs `/authorize connection:widget` |
| The bot has written profile data | `/authorize` publishes on link; later refreshes come from `/api/game-stats/sync` |

While the switch is off, every `/authorize` link asks for account scopes only, so no player can
hold the write scope: Discord has no game stats for anyone, and the widget renders the portal's
**Sample Data** (or its field fallbacks) instead of real values.

Two further Discord-side requirements matter when a profile refuses to save:

1. **The widget has to be published.** Choose a layout for **Widget Top**, **Widget Bottom** and
   **Add Widget Preview**, fill in their required fields and press **Publish**. A draft widget can
   only be added by members of your developer team, with Developer Mode on.
2. **The account has to be linked first.** A player can only add a game widget to a profile once
   their account is linked with `application_identities.write` — the same gate as the `/authorize`
   link above.

The widget portrait comes from the game server's `/portraits/<name>.png`. Discord requires media
URLs to be reachable from the public internet, so a character whose portrait has not been
published yet renders the portal's fallback asset instead.

While the switch is off no player holds the write scope, so widget writes are refused with `403`. That `403` now means "this **application** is not authorized for game stats" — Discord approves that per application, not per player — rather than "this player must re-link with `/account create`". The sync reports those players as `needs-authorization`.

Both linking flows still publish the profile immediately after a successful link, so a player's widget fills in without waiting for a scheduled sync once the scope is granted.

### When Discord refuses the scope (`invalid_scope`)

`application_identities.write` is **not** in Discord's public scope list: game stats are approved per application, and an app that has not been approved is refused with `error=invalid_scope` on the OAuth redirect. The same gate hides the Application Identity routes — Discord answers the generic route-not-found body (`{"message":"404: Not Found","code":0}`) where the documented permissions failure is a `403`.

`checkGameStatsAccess()` in `src/utils/gameStatsProfile.ts` tells those apart, and `/account create` uses it: when Discord answers `invalid_scope`, the callback probes the application's access before rendering the failure page, logs the finding, and names the portal fix instead of handing the player a code they cannot act on.

| State | Discord answered | Meaning |
| --- | --- | --- |
| `authorized` | `200` | the application may read and write game stats |
| `not-authorized` | `403` | game stats must be enabled for the application |
| `not-enabled` | `404`, generic body | the application has no game-stats access at all |
| `bad-credentials` | `401` | `DISCORD_BOT_TOKEN` was rejected |
| `unknown` | anything else, or unreachable | reported, never thrown |

Clearing `not-enabled` is a Developer Portal step (agree to the Social SDK Terms, claim the game), not an environment variable. It no longer blocks account creation — the scope is not requested — but nothing can be written to a widget until Discord approves the application.

### Environment

- `DISCORD_APPLICATION_ID` (or `DISCORD_CLIENT_ID`) and `DISCORD_BOT_TOKEN` — required; the bot token needs no extra permission for this API.
- `GAME_SERVER_BASE_URL` — the game server's public base URL (`http://dungeonblitzr.theminesa.studio`). Without it, no portrait URL is sent and the image field falls back.
- `GAME_STATS_SYNC_SECRET` — shared secret for the sync endpoint. `CRON_SECRET` is accepted as a fallback, which is the variable Vercel Cron sends automatically.
- `GAME_STATS_SEASON` — optional, sent as `season` for every player.

### Running the sync

`POST /api/game-stats/sync` (GET works too, so a scheduler can call it) refreshes widget profiles for linked players. Each call is bounded and reports what it did:

```bash
# One player, dry run: prints the payload without writing anything.
curl -s -X POST https://<deployment>/api/game-stats/sync \
  -H "Authorization: Bearer $GAME_STATS_SYNC_SECRET" \
  -H "content-type: application/json" \
  -d '{"discordId":"1447954255452311695","dryRun":true}'

# A batch: up to `limit` players within `deadlineMs`, so it fits the 10s function limit.
curl -s -X POST https://<deployment>/api/game-stats/sync \
  -H "Authorization: Bearer $GAME_STATS_SYNC_SECRET" \
  -d '{"limit":25,"deadlineMs":8000}'
```

Responses are JSON: a single-player call returns that player's `result` (`created`, `updated`, `dry-run`, `no-linked-account`, `no-characters`, `needs-authorization` or `error`), while a batch returns `attempted`, `stopReason` (`complete`, `limit` or `deadline`) and a per-player `results` list. `stopReason: "deadline"` means "call me again", not failure. A missing secret answers `503` rather than `401`, matching the game server's admin endpoints.

Call it from a scheduler when profiles should stay current, for example Vercel Cron in `vercel.json` (Hobby plans only allow one run per day; Pro allows tighter schedules):

```json
{ "crons": [{ "path": "/api/game-stats/sync?limit=100", "schedule": "*/15 * * * *" }] }
```

The sync also records its outcome on the account document as `gameStats.syncedAt`, `gameStats.state`, `gameStats.providerIssuedUserId` and `gameStats.error`, so "who is up to date" is answerable from MongoDB.

A `400` mentioning `Provider user ID ... does not match existing identity record` means Discord already has a different provider id for that player. `listApplicationIdentities` and `deleteApplicationIdentity` in `src/utils/gameStatsProfile.ts` are the documented way to inspect and clear the stale identity (the last linking identity cannot be deleted).
