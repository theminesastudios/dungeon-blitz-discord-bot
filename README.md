# Dungeon Blitz Discord Bot

This Discord bot designed for the Dungeon Blitz: R—The Minesa Studios Discord server. It handles integrations with GitHub and game stuffs.

## Commands

- `/create-account` sends an owner-bound Discord OAuth link. A MongoDB-backed game account and complete empty save document are created only after Discord returns a verified email; the player then sets the initial password through the message button and modal. `/account create` remains available as an alias.
- `/account reset-password` opens an owner-scoped modal and replaces the linked game account's password hash.
- `/account view` privately shows the linked account's Discord email, game user ID, and password setup state.
- `/sponsor-info github_username` lets administrators inspect the visible GitHub sponsorship tier, status, and estimated total.
- `/idols player operation amount` lets administrators atomically add or subtract Mammoth Idols. Player autocomplete displays the character's current Idols, Gold, and Dragon Keys.
- `/profile player` lets administrators inspect a linked Discord/GitHub profile and the player's current wallet values across both game wallet stores.

## Game wallet database

The wallet command uses `MONGODB_URI` by default and recognizes the game server's `MONGODB_DB_NAME` / `MONGODB_WALLET_COLLECTION` variables and the deployment's legacy `MONGO_DB_NAME` / `MONGO_COLLECTION_NAME` variables. A separate game database can be selected with:

- `GAME_MONGODB_URI`
- `GAME_MONGODB_DB_NAME`
- `GAME_WALLET_COLLECTION`

## Game account database

`/create-account` writes the complete account and save records to the game MongoDB database after Discord OAuth verifies the invoking user's email. It uses `GAME_MONGODB_URI` (falling back to `MONGODB_URI`) and `GAME_MONGODB_DB_NAME` (falling back to `MONGODB_DB_NAME`, then `minidb`). The legacy sponsor database variable `MONGO_DB_NAME` is deliberately not used for game accounts. Optional collection overrides are:

- `MONGODB_ACCOUNTS_COLLECTION` (default `accounts`)
- `MONGODB_SAVES_COLLECTION` (default `saves`)
- `MONGODB_COUNTERS_COLLECTION` (default `counters`)

Account OAuth state is HMAC-signed with `ACCOUNT_OAUTH_STATE_SECRET`, or with `DISCORD_CLIENT_SECRET` when a dedicated state secret is not configured. Links expire after 10 minutes and can only be completed by the Discord user who invoked `/create-account`.
