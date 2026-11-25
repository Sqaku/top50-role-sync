// Top-rank Discord role sync for Mine for Diamonds.
// One run = read the game's global leaderboards from Roblox Open Cloud, take each player's BEST rank on any
// reward board (Cash / Rebirths / Gems / Time, the same boards as the in-game Top 50 reward), map it to one
// tier role (#TOP 1 / #TOP 5 / #TOP 25 / #TOP 50), look the player's Discord account up through RoVer, then
// give every linked member exactly their tier role and take the other tier roles away. Plain REST, no
// gateway, so it runs fine as a short scheduled job.
//
// Env (secrets): DISCORD_TOKEN, ROBLOX_API_KEY, ROVER_KEY
// Env (config):  GUILD_ID (default 64 CCU Games), UNIVERSE_ID (default 10776126654), DRY_RUN=1

const env = process.env;
const UNIVERSE_ID = env.UNIVERSE_ID || "10776126654"; // live game (10778194646 is the tester place)
const DRY_RUN = env.DRY_RUN === "1";
const GUILD_ID = env.GUILD_ID || "1534863884438208632"; // 64 CCU Games
for (const k of ["DISCORD_TOKEN", "ROBLOX_API_KEY", "ROVER_KEY"]) {
  if (!env[k]) throw new Error(`Missing env ${k}`);
}

// Tiers, best first. A role is found by the exact "#TOP <n>" in its name (so "#TOP 5" never matches
// "#TOP 50"); emoji and colour are whatever the role has in Discord.
const TIERS = [1, 5, 25, 50];
const TOP_N = TIERS[TIERS.length - 1];

// Mirrors ServerScriptService.Services.LeaderboardService: staff never rank (EXCLUDED + Modules.Admins).
const EXCLUDED = new Set([1141781773, 2252609335, 287525045, 70355390, 28960880, 1334742580]);

// Boards that count toward the Top 50 reward ("Rarest" is NoReward in the game).
// Cash is a Big board: LB_Cash_v2 is log-packed past 2^52, and the frozen LB_Cash_v1 is merged under it.
const BOARDS = [
  { key: "Cash", store: "LB_Cash_v2", big: true, legacy: "LB_Cash_v1" },
  { key: "Rebirths", store: "LB_Rebirths_v1" },
  { key: "Gems", store: "LB_Gems_v1" },
  { key: "Time", store: "LB_Time_v1" },
];
const BIG_FLOOR = 2 ** 52;
const BIG_STEP = 2 ** 40;
const unpackBig = (v) => (v < BIG_FLOOR ? v : 2 ** (52 + (v - BIG_FLOOR) / BIG_STEP));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, opts = {}, tries = 4) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, opts);
    if (res.status === 429 && i < tries) {
      const body = await res.json().catch(() => ({}));
      const wait = Number(res.headers.get("retry-after")) || body.retry_after || 2;
      await sleep(Math.ceil(wait * 1000) + 250);
      continue;
    }
    return res;
  }
}

// Top entries of one ordered data store, best first, staff removed. Throws on any failure so a bad
// read never strips roles from people who are still ranked.
async function readStore(name, depth, decode = (v) => v) {
  const list = [];
  let pageToken = "";
  while (list.length < depth) {
    const url =
      `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE_ID}/ordered-data-stores/${name}` +
      `/scopes/global/entries?maxPageSize=100&orderBy=${encodeURIComponent("value desc")}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await http(url, { headers: { "x-api-key": env.ROBLOX_API_KEY } });
    if (!res.ok) throw new Error(`Open Cloud ${name}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const e of body.orderedDataStoreEntries || []) {
      const userId = Number(e.id);
      if (Number.isFinite(userId) && !EXCLUDED.has(userId)) list.push({ userId, value: decode(Number(e.value)) });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return list;
}

async function topOf(board) {
  // read deeper than TOP_N: excluded staff and the legacy merge can shift ranks
  const depth = TOP_N + 20;
  let list = await readStore(board.store, depth, board.big ? unpackBig : undefined);
  if (board.legacy) {
    const seen = new Set(list.map((e) => e.userId));
    const old = await readStore(board.legacy, depth);
    list = list.concat(old.filter((e) => !seen.has(e.userId))).sort((a, b) => b.value - a.value);
  }
  return list.slice(0, TOP_N).map((e) => e.userId);
}

// RoVer (the server's verification bot): Roblox user -> linked Discord accounts in this guild.
async function discordIdsFor(robloxId) {
  const res = await http(
    `https://registry.rover.link/api/guilds/${GUILD_ID}/roblox-to-discord/${robloxId}`,
    { headers: { Authorization: `Bearer ${env.ROVER_KEY}` } },
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`RoVer ${robloxId}: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.discordUsers || []).map((d) => d.user?.id).filter(Boolean);
}

const discord = (path, method = "GET") =>
  http(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "X-Audit-Log-Reason": "Top leaderboard role sync" },
  });

// tier -> { id, name }. Throws unless every tier has exactly one role, so a renamed role never causes
// mass removals.
async function resolveRoles() {
  const res = await discord(`/guilds/${GUILD_ID}/roles`);
  if (!res.ok) throw new Error(`Discord roles: ${res.status} ${await res.text()}`);
  const roles = await res.json();
  const byTier = new Map();
  for (const tier of TIERS) {
    const hits = roles.filter((r) => new RegExp(`#TOP ${tier}(?!\\d)`).test(r.name));
    if (hits.length !== 1) throw new Error(`Expected 1 role named "#TOP ${tier}", found ${hits.length}`);
    byTier.set(tier, { id: hits[0].id, name: hits[0].name });
    console.log(`Role for top ${tier}: ${hits[0].name} (${hits[0].id})`);
  }
  return byTier;
}

const names = new Map(); // Discord id -> "username (server nickname)", for the log

// Every member: their name for the log and which tier roles they hold now.
async function members(roleIds) {
  const held = new Map(); // Discord id -> Set of tier role ids
  let after = "0";
  for (;;) {
    const res = await discord(`/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
    if (!res.ok) throw new Error(`Discord members: ${res.status} ${await res.text()}`);
    const page = await res.json();
    for (const m of page) {
      names.set(m.user.id, m.nick ? `${m.user.username} (${m.nick})` : m.user.username);
      held.set(m.user.id, new Set(m.roles.filter((r) => roleIds.has(r))));
    }
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return held;
}

async function main() {
  const roles = await resolveRoles();
  const roleIds = new Set([...roles.values()].map((r) => r.id));

  // best (lowest) rank of each Roblox player across the boards
  const best = new Map();
  for (const board of BOARDS) {
    const ids = await topOf(board);
    console.log(`${board.key}: ${ids.length} ranked`);
    ids.forEach((id, i) => best.set(id, Math.min(best.get(id) ?? Infinity, i + 1)));
  }
  console.log(`Top ${TOP_N} on any board: ${best.size} Roblox players`);

  // Discord member -> the tier they earned (best across all their linked Roblox accounts)
  const tierOf = new Map();
  let unlinked = 0;
  for (const [robloxId, rank] of best) {
    const ids = await discordIdsFor(robloxId);
    if (ids.length === 0) unlinked++;
    const tier = TIERS.find((t) => rank <= t);
    for (const id of ids) tierOf.set(id, Math.min(tierOf.get(id) ?? Infinity, tier));
    await sleep(2100); // RoVer allows 5 requests per 10 s per server
  }
  console.log(`Linked Discord accounts: ${tierOf.size} (${unlinked} players not verified with RoVer)`);

  const held = await members(roleIds);
  const changes = []; // { id, method, tier }
  for (const [id, have] of held) {
    const tier = tierOf.get(id);
    const wantRole = tier ? roles.get(tier).id : null;
    if (wantRole && !have.has(wantRole)) changes.push({ id, method: "PUT", tier });
    for (const t of TIERS) {
      const roleId = roles.get(t).id;
      if (have.has(roleId) && roleId !== wantRole) changes.push({ id, method: "DELETE", tier: t });
    }
  }

  const label = (id) => names.get(id) || id;
  console.log(`Changes: ${changes.length}${DRY_RUN ? " (dry run, nothing changed)" : ""}`);
  for (const tier of TIERS) {
    const add = changes.filter((c) => c.method === "PUT" && c.tier === tier).map((c) => label(c.id));
    const del = changes.filter((c) => c.method === "DELETE" && c.tier === tier).map((c) => label(c.id));
    if (add.length) console.log(`  + ${roles.get(tier).name}: ${add.join(", ")}`);
    if (del.length) console.log(`  - ${roles.get(tier).name}: ${del.join(", ")}`);
  }
  if (DRY_RUN) return;

  let failed = 0;
  for (const c of changes) {
    const res = await discord(`/guilds/${GUILD_ID}/members/${c.id}/roles/${roles.get(c.tier).id}`, c.method);
    if (!res.ok) {
      failed++;
      console.error(`${c.method} ${label(c.id)} ${roles.get(c.tier).name}: ${res.status} ${await res.text()}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
