# Top 50 Discord role sync (Mine for Diamonds)

Every 15 minutes a free GitHub Actions job reads the game's global leaderboards (Cash, Rebirths, Gems,
Time) from Roblox Open Cloud, finds everyone in the Top 50 on ANY of them (staff excluded, same as the
game), looks up their Discord through RoVer, and adds/removes the Top 50 role. No server to keep on.

Players must be verified with RoVer in the server, or the bot can't know who they are.

## Setup (secrets are yours to paste, never share them in chat)

1. **Discord bot** — discord.com/developers → New Application → Bot. Turn ON *Server Members Intent*.
   Copy the token. Invite it with the `Manage Roles` permission:
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=268435456`
   In Server Settings → Roles, drag the bot's role **above** the Top 50 role.
2. **Roblox Open Cloud key** — create.roblox.com → Open Cloud → API Keys → Create.
   Access: *ordered-data-stores* → universe Mine for Diamonds (10776126654) → **Read** only (`universe.ordered-data-store.scope.entry:read`).
3. **RoVer key** — rover.link dashboard → your server → API → create a key.
4. **GitHub repo** (private) with these files. Settings → Secrets and variables → Actions:
   - Secrets: `DISCORD_TOKEN`, `ROBLOX_API_KEY`, `ROVER_KEY`
   - Variables: `GUILD_ID` (server id), `ROLE_ID` (the Top 50 role id)
5. Actions tab → *Top 50 role sync* → Run workflow with **Dry run** ticked. Check the log, then let the
   schedule take over (scheduled runs change roles for real).

Local run: copy `.env.example` to `.env`, fill it, `node --env-file=.env sync.mjs`.
