# Top 50 Discord role sync (Mine for Diamonds)

Every 30 minutes a free GitHub Actions job reads the game's global leaderboards (Cash, Rebirths, Gems,
Time) from Roblox Open Cloud, finds everyone in the Top 50 on ANY of them (staff excluded, same as the
game), looks up their Discord through RoVer, and adds/removes the `🏆#TOP 50` role in 64 CCU Games.
No server to keep on.

Players must be verified with RoVer in the server (and allow the server to see their link), or the bot
can't know who they are.

## Setup
- Discord app: Top 50 Sync (1575095767721447525), Server Members Intent on, its role sits above `#TOP 50`.
- Roblox Open Cloud key: ordered-data-stores read, Mine for Diamonds (universe 10776126654) only.
- RoVer server key: rover.link → 64 CCU Games → Developer API.
- Repo secrets (Settings → Secrets and variables → Actions): `DISCORD_TOKEN`, `ROBLOX_API_KEY`, `ROVER_KEY`.
- Repo variable `LIVE` = `1` turns real role changes on for scheduled runs. Without it every run is a dry run.
- Optional variables: `GUILD_ID` (default 64 CCU Games), `ROLE_ID` / `ROLE_NAME` (default finds "#TOP 50"),
  `UNIVERSE_ID`, `TOP_N` (default 50).

Manual run: Actions → *Top 50 role sync* → Run workflow (Dry run ticked = log only).

Local run: copy `.env.example` to `.env`, fill it, `node --env-file=.env sync.mjs`.
