// netlify/functions/discover.mjs
// Fast HTML-only discover (no Playwright, no FotMob JSON).
// 1) GET player page HTML → extract team_id & team_slug
// 2) Parse __NEXT_DATA__ on the player page for any matchIds
// 3) Try a few team pages (fixtures/matches/overview/base):
//    - scrape anchors (/match/<digits> and /matches/<slug>/<token>)
//    - parse __NEXT_DATA__ there too and harvest "matchId" values
// 4) Return deduped match_urls (capped by maxMatches) + rich debug

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const HDRS_HTML = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  "referer": "https://www.fotmob.com/",
};

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, retry = 2) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_HTML, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!txt) throw new Error("empty HTML");
      return txt;
    } catch (e) {
      last = e;
      await SLEEP(250 + 350 * i);
    }
  }
  throw last || new Error("fetch failed");
}

function parsePlayer(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean); // ["players","1467236","lamine-yamal"]
    const pid = Number(parts[1]);
    const slug = decodeURIComponent(parts[2] || "").replace(/-/g, " ").trim();
    return { player_id: Number.isFinite(pid) ? pid : null, player_name: slug || null };
  } catch {
    return { player_id: null, player_name: null };
  }
}

// --- __NEXT_DATA__ helpers ---
function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}
function collectMatchIdsFromNextData(nextStrOrObj) {
  const ids = new Set();
  // 1) cheap regex over the raw string to catch "matchId":1234567 and /match/1234567
  const raw = typeof nextStrOrObj === "string" ? nextStrOrObj : JSON.stringify(nextStrOrObj || {});
  for (const mm of raw.matchAll(/"matchId"\s*:\s*(\d{5,10})/gi)) ids.add(mm[1]);
  for (const mm of raw.matchAll(/\/match\/(\d{5,10})/gi)) ids.add(mm[1]);

  // 2) object-walk to be safe if structure is nested without those exact strings
  const obj = typeof nextStrOrObj === "string" ? safeParseJSON(nextStrOrObj) : (nextStrOrObj || null);
  if (obj && typeof obj === "object") {
    const q = [obj];
    while (q.length) {
      const node = q.pop();
      if (!node || typeof node !== "object") continue;
      // canonical key
      if (node.matchId && Number.isFinite(Number(node.matchId))) {
        const sid = String(node.matchId);
        if (/^\d{5,10}$/.test(sid)) ids.add(sid);
      }
      // sometimes "id" in match-like nodes
      if (node.id && Number.isFinite(Number(node.id))) {
        const sid = String(node.id);
        // only accept plausible match id lengths
        if (/^\d{6,10}$/.test(sid) && (node.homeTeam || node.awayTeam || node.home || node.away)) {
          ids.add(sid);
        }
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (!v) continue;
        if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") q.push(it);
        else if (typeof v === "object") q.push(v);
      }
    }
  }

  return Array.from(ids);
}

// --- Non-JS scraping (anchors + any "matchId" in inline JSON) ---
function scrapeMatchLinks(html) {
  const set = new Set();
  // Anchors to /match/<digits>
  for (const m of html.matchAll(/href="(\/match\/\d{5,10}(?:\/[^"]*)?)"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  // Anchors to /matches/<slug>/<token>
  for (const m of html.matchAll(/href="(\/matches\/[^"?#]+)"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  // Fallback: embedded "matchId": 1234567
  for (const m of html.matchAll(/"matchId"\s*:\s*(\d{5,10})/gi)) {
    set.add("https://www.fotmob.com/match/" + m[1]);
  }
  return Array.from(set);
}

// Pull all /teams/... hrefs and compute robust (team_id, team_slug)
// Pick the LAST meaningful segment after the numeric id, skipping "overview|fixtures|matches|squad|stats|statistics|transfers|news|table|season|results"
function findTeamFromPlayerHtml(html) {
  const hrefs = Array.from(html.matchAll(/href="\/teams\/([^"]+)"/gi)).map(m => m[1]); // e.g. "8634/overview/barcelona"
  const BAD = new Set(["overview","fixtures","matches","squad","stats","statistics","transfers","news","table","season","results"]);
  for (const h of hrefs) {
    const path = h.split("?")[0].replace(/^\/+|\/+$/g, "");
    const segs = path.split("/"); // ["8634","overview","barcelona"] OR ["8634","barcelona"]
    const id = Number(segs[0]);
    if (!Number.isFinite(id)) continue;
    let slug = null;
    for (let i = segs.length - 1; i >= 1; i--) {
      const s = (segs[i] || "").toLowerCase();
      if (!s || BAD.has(s)) continue;
      if (/^\d+$/.test(s)) continue;
      slug = s;
      break;
    }
    if (!slug) continue;
    return { team_id: id, team_slug: slug };
  }
  return { team_id: null, team_slug: null };
}

async function discoverForPlayer(player_url, cap) {
  const { player_id, player_name } = parsePlayer(player_url);
  const debug = {
    player_id,
    team_id: null,
    team_slug: null,
    tried_urls: [],
    anchors_found: 0,
    player_next_ids: 0,
    team_next_ids: 0,
    errors: [],
  };

  if (!player_id) {
    debug.errors.push("Could not parse player_id from URL");
    return { player_url, player_id: null, player_name, match_urls: [], debug };
  }

  // 1) Player HTML
  let playerHtml = "";
  try {
    playerHtml = await fetchText(player_url);
  } catch (e) {
    debug.errors.push("player_html: " + String(e));
    return { player_url, player_id, player_name, match_urls: [], debug };
  }

  // 1a) Extract any matchIds from player's __NEXT_DATA__
  const pdStr = extractNextDataString(playerHtml);
  if (pdStr) {
    const ids = collectMatchIdsFromNextData(pdStr);
    debug.player_next_ids = ids.length;
    // We'll add them later into the final set
  }

  // 1b) Find team
  const { team_id, team_slug } = findTeamFromPlayerHtml(playerHtml);
  debug.team_id = team_id;
  debug.team_slug = team_slug;

  // Build a final set of URLs
  const urlSet = new Set();
  // add any matchIds found on player page
  if (pdStr) {
    for (const id of collectMatchIdsFromNextData(pdStr)) {
      urlSet.add(`https://www.fotmob.com/match/${id}`);
    }
  }

  if (!team_id || !team_slug) {
    debug.errors.push("Could not find team link on player page");
    const all = Array.from(urlSet);
    debug.anchors_found = all.length;
    const match_urls = Number(cap) > 0 ? all.slice(0, Number(cap)) : all;
    return { player_url, player_id, player_name, match_urls, debug };
  }

  // 2) Team pages (fixtures/matches/overview/base)
  const candidates = [
    `https://www.fotmob.com/teams/${team_id}/fixtures/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/matches/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/overview/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/${encodeURIComponent(team_slug)}`
  ];

  for (const url of candidates) {
    debug.tried_urls.push(url);
    try {
      const html = await fetchText(url);

      // anchors + "matchId" in inline JSON
      const links = scrapeMatchLinks(html);
      for (const u of links) urlSet.add(u);

      // __NEXT_DATA__ on team page too
      const ndStr = extractNextDataString(html);
      if (ndStr) {
        const ids = collectMatchIdsFromNextData(ndStr);
        debug.team_next_ids += ids.length;
        for (const id of ids) urlSet.add(`https://www.fotmob.com/match/${id}`);
      }

      // Early exit if we already have plenty
      if (urlSet.size >= (cap > 0 ? cap : 250)) break;
    } catch (e) {
      debug.errors.push(`fetch ${url}: ${String(e)}`);
    }
  }

  const all = Array.from(urlSet);
  debug.anchors_found = all.length;

  const match_urls = Number(cap) > 0 ? all.slice(0, Number(cap)) : all;
  return { player_url, player_id, player_name, match_urls, debug };
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch {
        return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
    } else {
      payload = { urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean), maxMatches: Number(event.queryStringParameters?.maxMatches || 0) };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    const cap = Number(payload.maxMatches) || 0;

    if (!urls.length) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    const players = [];
    for (const player_url of urls) {
      try {
        players.push(await discoverForPlayer(player_url, cap));
      } catch (e) {
        players.push({ player_url, player_id: null, player_name: null, match_urls: [], debug: { errors: [String(e)] } });
      }
    }

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, players }) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
