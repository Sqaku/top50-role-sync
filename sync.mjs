// Top 50 Discord role sync for Mine for Diamonds.
// One run = read the game's global leaderboards from Roblox Open Cloud, work out who is Top 50 on ANY
// reward board (Cash / Rebirths / Gems / Time, the same rule as the in-game Top 50 reward), look each
// player's Discord account up through RoVer, then add the role to everyone in and remove it from
// everyone who dropped out. Plain REST, no gateway, so it runs fine as a short scheduled job.
//
// Env (secrets): DISCORD_TOKEN, ROBLOX_API_KEY, ROVER_KEY
// Env (config):  GUILD_ID (default 64 CCU Games), ROLE_ID or ROLE_NAME (default "#TOP 50"), UNIVERSE_ID (default 10776126654), TOP_N (default 50), DRY_RUN=1

const env = process.env;
const UNIVERSE_ID = env.UNIVERSE_ID || "10776126654"; // live game (10778194646 is the tester place)
const TOP_N = Number(env.TOP_N || 50);
const DRY_RUN = env.DRY_RUN === "1";
const GUILD_ID = env.GUILD_ID || "1534863884438208632"; // 64 CCU Games
const ROLE_NAME = env.ROLE_NAME || "#TOP 50"; // matched inside the role name, so the emoji prefix is fine
let ROLE_ID = env.ROLE_ID || "";
for (const k of ["DISCORD_TOKEN", "ROBLOX_API_KEY", "ROVER_KEY"]) {
  if (!env[k]) throw new Error(`Missing env ${k}`);
}

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
// read never strips roles from people who are still in the Top 50.
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
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "X-Audit-Log-Reason": "Top 50 leaderboard sync" },
  });

const names = new Map(); // Discord id -> "username (server nickname)", for the log

async function membersWithRole() {
  const have = new Set();
  const all = new Set();
  let after = "0";
  for (;;) {
    const res = await discord(`/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
    if (!res.ok) throw new Error(`Discord members: ${res.status} ${await res.text()}`);
    const page = await res.json();
    for (const m of page) {
      all.add(m.user.id);
      names.set(m.user.id, m.nick ? `${m.user.username} (${m.nick})` : m.user.username);
      if (m.roles.includes(ROLE_ID)) have.add(m.user.id);
    }
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return { have, all };
}

async function resolveRole() {
  if (ROLE_ID) return;
  const res = await discord(`/guilds/${GUILD_ID}/roles`);
  if (!res.ok) throw new Error(`Discord roles: ${res.status} ${await res.text()}`);
  const hits = (await res.json()).filter((r) => r.name.includes(ROLE_NAME));
  if (hits.length !== 1) throw new Error(`Expected 1 role containing "${ROLE_NAME}", found ${hits.length}; set ROLE_ID`);
  ROLE_ID = hits[0].id;
  console.log(`Role: ${hits[0].name} (${ROLE_ID})`);
}

async function main() {
  await resolveRole();
  const top = new Set();
  for (const board of BOARDS) {
    const ids = await topOf(board);
    console.log(`${board.key}: ${ids.length} ranked`);
    ids.forEach((id) => top.add(id));
  }
  console.log(`Top ${TOP_N} on any board: ${top.size} Roblox players`);

  const want = new Set();
  let unlinked = 0;
  for (const robloxId of top) {
    const ids = await discordIdsFor(robloxId);
    if (ids.length === 0) unlinked++;
    ids.forEach((id) => want.add(id));
    await sleep(2100); // RoVer allows 5 requests per 10 s per server
  }
  console.log(`Linked Discord accounts: ${want.size} (${unlinked} players not verified with RoVer)`);

  const { have, all } = await membersWithRole();
  const toAdd = [...want].filter((id) => all.has(id) && !have.has(id));
  const toRemove = [...have].filter((id) => !want.has(id));
  console.log(`Add: ${toAdd.length}, remove: ${toRemove.length}${DRY_RUN ? " (dry run, nothing changed)" : ""}`);
  const label = (id) => names.get(id) || id;
  if (toAdd.length) console.log(`  + ${toAdd.map(label).join(", ")}`);
  if (toRemove.length) console.log(`  - ${toRemove.map(label).join(", ")}`);
  if (DRY_RUN) return;

  let failed = 0;
  for (const [ids, method] of [[toAdd, "PUT"], [toRemove, "DELETE"]]) {
    for (const id of ids) {
      const res = await discord(`/guilds/${GUILD_ID}/members/${id}/roles/${ROLE_ID}`, method);
      if (!res.ok) {
        failed++;
        console.error(`${method} ${id}: ${res.status} ${await res.text()}`);
      }
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
