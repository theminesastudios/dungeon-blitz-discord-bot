# Dungeon Blitz Discord Bot

This Discord bot designed for the Dungeon Blitz: R—The Minesa Studios Discord server. It handles integrations with GitHub and game stuffs.

## Commands

- `/create-account` sends an owner-bound Discord OAuth link. A MongoDB-backed game account and complete empty save document are created only after Discord returns a verified email; the player then sets the initial password through the message button and modal. `/account create` remains available as an alias.
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

`/create-account` writes the complete account and save records to the game MongoDB database after Discord OAuth verifies the invoking user's email. It uses `GAME_MONGODB_URI` (falling back to `MONGODB_URI`) and `GAME_MONGODB_DB_NAME` (falling back to `MONGODB_DB_NAME`, then `minidb`). The legacy sponsor database variable `MONGO_DB_NAME` is deliberately not used for game accounts. Optional collection overrides are:

- `MONGODB_ACCOUNTS_COLLECTION` (default `accounts`)
- `MONGODB_SAVES_COLLECTION` (default `saves`)
- `MONGODB_COUNTERS_COLLECTION` (default `counters`)

Account OAuth state is HMAC-signed with `ACCOUNT_OAUTH_STATE_SECRET`, or with `DISCORD_CLIENT_SECRET` when a dedicated state secret is not configured. Links expire after 10 minutes and can only be completed by the Discord user who invoked `/create-account`.
