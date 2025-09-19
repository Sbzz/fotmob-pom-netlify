// netlify/functions/discover.mjs
// Fast HTML scraper (no Playwright, no FotMob JSON).
// Steps:
// 1) GET player page HTML → find /teams/<id>/<slug> (robust: handles /overview/<slug>, /fixtures/<slug>, etc.)
// 2) Build a small set of candidate team pages and scrape match anchors:
//    • /teams/<id>/fixtures/<slug>
//    • /teams/<id>/matches/<slug>
//    • /teams/<id>/overview/<slug>
//    • /teams/<id>/<slug>
// 3) Collect both "/match/<digits>" and "/matches/<slug>/<token>" links (checker handles either format).

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

// Pull all /teams/... hrefs and compute a robust (id, slug)
// We pick the LAST meaningful segment after the id, skipping "overview|fixtures|matches|squad|stats|transfers|news|table|season".
function findTeamFromPlayerHtml(html) {
  const hrefs = Array.from(html.matchAll(/href="\/teams\/([^"]+)"/gi)).map(m => m[1]); // e.g. "8634/overview/barcelona"
  const BAD = new Set(["overview","fixtures","matches","squad","stats","statistics","transfers","news","table","season","results"]);
  for (const h of hrefs) {
    const path = h.split("?")[0].replace(/^\/+|\/+$/g, "");
    const segs = path.split("/"); // ["8634","overview","barcelona"] OR ["8634","barcelona"]
    const id = Number(segs[0]);
    if (!Number.isFinite(id)) continue;
    // choose last non-bad, non-numeric segment as slug
    let slug = null;
    for (let i = segs.length - 1; i >= 1; i--) {
      const s = segs[i].toLowerCase();
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

function scrapeMatchLinks(html) {
  const set = new Set();
  // /match/<digits>
  for (const m of html.matchAll(/href="(\/match\/\d{5,10}(?:\/[^"]*)?)"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  // /matches/<slug>/<token>
  for (const m of html.matchAll(/href="(\/matches\/[^"?#]+)"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  // embedded JSON with "matchId": 1234567
  for (const m of html.matchAll(/"matchId"\s*:\s*(\d{5,10})/gi)) {
    set.add("https://www.fotmob.com/match/" + m[1]);
  }
  return Array.from(set);
}

async function discoverForPlayer(player_url, cap) {
  const { player_id, player_name } = parsePlayer(player_url);
  const debug = {
    player_id,
    team_id: null,
    team_slug: null,
    tried_urls: [],
    anchors_found: 0,
    errors: [],
  };

  if (!player_id) {
    debug.errors.push("Could not parse player_id from URL");
    return { player_url, player_id: null, player_name, match_urls: [], debug };
  }

  // 1) Player page → find team
  let playerHtml = "";
  try {
    playerHtml = await fetchText(player_url);
  } catch (e) {
    debug.errors.push("player_html: " + String(e));
    return { player_url, player_id, player_name, match_urls: [], debug };
  }

  const { team_id, team_slug } = findTeamFromPlayerHtml(playerHtml);
  debug.team_id = team_id;
  debug.team_slug = team_slug;

  if (!team_id || !team_slug) {
    debug.errors.push("Could not find team link on player page");
    return { player_url, player_id, player_name, match_urls: [], debug };
  }

  // 2) Try a small set of team pages to maximize chances of finding anchors
  const candidates = [
    `https://www.fotmob.com/teams/${team_id}/fixtures/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/matches/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/overview/${encodeURIComponent(team_slug)}`,
    `https://www.fotmob.com/teams/${team_id}/${encodeURIComponent(team_slug)}`
  ];

  const linksSet = new Set();
  for (const url of candidates) {
    try {
      debug.tried_urls.push(url);
      const html = await fetchText(url);
      const links = scrapeMatchLinks(html);
      for (const u of links) linksSet.add(u);
      // If we already have a healthy number, stop early
      if (linksSet.size >= (cap > 0 ? cap : 200)) break;
    } catch (e) {
      debug.errors.push(`fetch ${url}: ${String(e)}`);
    }
  }

  const all = Array.from(linksSet);
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
