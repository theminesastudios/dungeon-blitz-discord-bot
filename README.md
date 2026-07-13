# Dungeon Blitz Discord Bot

This Discord bot designed for the Dungeon Blitz: R—The Minesa Studios Discord server. It handles integrations with GitHub and game stuffs.

## Commands

- `/sponsor-info github_username` lets administrators inspect the visible GitHub sponsorship tier, status, and estimated total.
- `/idols player operation amount` lets administrators atomically add or subtract Mammoth Idols. Player autocomplete displays the character's current Idols, Gold, and Dragon Keys.
- `/profile player` lets administrators inspect a linked Discord/GitHub profile and the player's current wallet values across both game wallet stores.

## Game wallet database

The wallet command uses `MONGODB_URI` by default and recognizes the game server's `MONGODB_DB_NAME` / `MONGODB_WALLET_COLLECTION` variables and the deployment's legacy `MONGO_DB_NAME` / `MONGO_COLLECTION_NAME` variables. A separate game database can be selected with:

- `GAME_MONGODB_URI`
- `GAME_MONGODB_DB_NAME`
- `GAME_WALLET_COLLECTION`
