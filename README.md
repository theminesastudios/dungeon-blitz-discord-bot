# Dungeon Blitz Discord Bot

This Discord bot designed for the Dungeon Blitz: R—The Minesa Studios Discord server. It handles integrations with GitHub and game stuffs.

## Commands

- `/account create` sends an owner-bound Discord OAuth link. A MongoDB-backed game account and complete empty save document are created only after Discord returns a verified email; the player then sets the initial password through the message button and modal.
- `/account reset-password` opens an owner-scoped modal and replaces the linked game account's password hash.
- `/account view` privately shows the linked account's Discord email, game user ID, and password setup state.
- `/sponsor-info github_username` lets administrators inspect the visible GitHub sponsorship tier, status, and estimated total.
- `/add-credits player dollars [note]` lets administrators add shop credit to a linked player, converting donated dollars 1:1 into spendable credit. It stacks on top of the player's GitHub-reported donation total, is audited on the player's profile, and can be spent in `/packs` like sponsor credit.
- `/idols player operation amount` lets administrators atomically add or subtract Mammoth Idols. Player autocomplete displays the character's current Idols, Gold, and Dragon Keys.
- `/profile player` lets administrators inspect a linked Discord/GitHub profile and the player's current wallet values across the current game saves and legacy wallet stores.
- `/add-credits` and `/maintenance` are administrator commands; they require the invoking member to hold Discord Administrator permissions.

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

Account OAuth state is HMAC-signed with `ACCOUNT_OAUTH_STATE_SECRET`, or with `DISCORD_CLIENT_SECRET` when a dedicated state secret is not configured. Links expire after 10 minutes and can only be completed by the Discord user who invoked `/account create`.

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

Writes need a player who authorized the application with `application_identities.write`. `/account create` now requests `identify email application_identities.write`, and the verification page requests `identify connections role_connections.write application_identities.write`.

Accounts linked **before** this change do not hold the write scope: they are still created and linked successfully (the callback logs a warning), but their widget stays empty until the player re-runs `/account create`. Those players are reported as `needs-authorization` by the sync — a `403` from Discord always means "this player must re-link with `/account create`", never "the token or application id is wrong".

Both linking flows also publish the profile immediately after a successful link, so a player's widget fills in without waiting for a scheduled sync.

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
