// netlify/functions/discover.mjs
// Discover matches for a FotMob player page (HTML + NEXT_DATA).
// Updated: safeJson helper + retry safeguard.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const HDRS_HTML = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  "referer": "https://www.fotmob.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeJson(res) {
  const txt = await res.text();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

async function fetchText(url, retry = 1) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_HTML, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!txt) throw new Error("empty HTML");
      return txt;
    } catch (e) {
      last = e;
      await sleep(250 + 350 * i);
    }
  }
  throw last || new Error("fetch failed");
}

function parsePlayer(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const pid = Number(parts[1]);
    const slug = decodeURIComponent(parts[2] || "").replace(/-/g, " ").trim();
    return { player_id: Number.isFinite(pid) ? pid : null, player_name: slug || null };
  } catch {
    return { player_id: null, player_name: null };
  }
}

function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/i);
  return m ? m[1] : null;
}
function safeParseJSON(str) { try { return JSON.parse(str); } catch { return null; } }

function collectMatchIdsFromNextData(nextStrOrObj) {
  const ids = new Set();
  const raw = typeof nextStrOrObj === "string" ? nextStrOrObj : JSON.stringify(nextStrOrObj || {});
  for (const mm of raw.matchAll(/\"matchId\"\\s*:\\s*(\\d{5,10})/gi)) ids.add(mm[1]);
  for (const mm of raw.matchAll(/\\/match\\/(\\d{5,10})/gi)) ids.add(mm[1]);

  const obj = typeof nextStrOrObj === "string" ? safeParseJSON(nextStrOrObj) : (nextStrOrObj || null);
  if (obj && typeof obj === "object") {
    const q = [obj];
    while (q.length) {
      const node = q.pop();
      if (!node || typeof node !== "object") continue;
      if (node.matchId && Number.isFinite(Number(node.matchId))) {
        ids.add(String(node.matchId));
      }
      if (node.id && Number.isFinite(Number(node.id))) {
        const sid = String(node.id);
        if (/^\\d{6,10}$/.test(sid) && (node.homeTeam || node.awayTeam)) ids.add(sid);
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") q.push(v);
        if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") q.push(it);
      }
    }
  }
  return Array.from(ids);
}

function scrapeMatchLinks(html) {
  const set = new Set();
  for (const m of html.matchAll(/href=\"(\\/match\\/\\d{5,10}(?:\\/[^"]*)?)\"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  for (const m of html.matchAll(/href=\"(\\/matches\\/[^\"?#]+)\"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  for (const m of html.matchAll(/\"matchId\"\\s*:\\s*(\\d{5,10})/gi)) {
    set.add("https://www.fotmob.com/match/" + m[1]);
  }
  return Array.from(set);
}

function findTeamFromPlayerHtml(html) {
  const hrefs = Array.from(html.matchAll(/href=\"\\/teams\\/([^\"]+)\"/gi)).map(m => m[1]);
  const BAD = new Set(["overview","fixtures","matches","squad","stats","statistics","transfers","news","table","season","results"]);
  for (const h of hrefs) {
    const path = h.split("?")[0].replace(/^\\/+|\\/+$/g, "");
    const segs = path.split("/");
    const id = Number(segs[0]);
    if (!Number.isFinite(id)) continue;
    let slug = null;
    for (let i = segs.length - 1; i >= 1; i--) {
      const s = (segs[i] || "").toLowerCase();
      if (!s || BAD.has(s)) continue;
      if (/^\\d+$/.test(s)) continue;
      slug = s;
      break;
    }
    if (slug) return { team_id: id, team_slug: slug };
  }
  return { team_id: null, team_slug: null };
}

async function discoverForPlayer(player_url, cap) {
  const { player_id, player_name } = parsePlayer(player_url);
  const debug = { errors: [], player_id, player_name };

  if (!player_id) {
    debug.errors.push("Invalid player_id");
    return { player_url, player_id: null, player_name, match_urls: [], debug };
  }

  let playerHtml = "";
  try { playerHtml = await fetchText(player_url); }
  catch (e) {
    debug.errors.push("player_html: " + String(e));
    return { player_url, player_id, player_name, match_urls: [], debug };
  }

  const pdStr = extractNextDataString(playerHtml);
  const urlSet = new Set();
  if (pdStr) for (const id of collectMatchIdsFromNextData(pdStr)) urlSet.add(`https://www.fotmob.com/match/${id}`);

  const { team_id, team_slug } = findTeamFromPlayerHtml(playerHtml);
  debug.team_id = team_id; debug.team_slug = team_slug;

  if (!team_id || !team_slug) {
    return { player_url, player_id, player_name, match_urls: Array.from(urlSet), debug };
  }

  const candidates = [
    `https://www.fotmob.com/teams/${team_id}/fixtures/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/matches/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/overview/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/${encodeURIComponent(team_slug)}`
  ];

  for (const url of candidates) {
    try {
      const html = await fetchText(url);
      for (const u of scrapeMatchLinks(html)) urlSet.add(u);
      const ndStr = extractNextDataString(html);
      if (ndStr) for (const id of collectMatchIdsFromNextData(ndStr)) urlSet.add(`https://www.fotmob.com/match/${id}`);
      if (urlSet.size >= (cap > 0 ? cap : 200)) break;
    } catch (e) {
      debug.errors.push(`fetch ${url}: ${String(e)}`);
    }
  }

  const match_urls = Number(cap) > 0 ? Array.from(urlSet).slice(0, cap) : Array.from(urlSet);
  return { player_url, player_id, player_name, match_urls, debug };
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }
    } else {
      payload = { urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean), maxMatches: Number(event.queryStringParameters?.maxMatches || 0) };
    }
    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    const cap = Number(payload.maxMatches) || 0;
    if (!urls.length) return { statusCode: 400, body: JSON.stringify({ error: "No URLs" }) };

    const players = [];
    for (const u of urls) players.push(await discoverForPlayer(u, cap));
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, players }) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
