// netlify/functions/discover.mjs
// Lightweight discover: no Playwright, no FotMob JSON.
// 1) GET player page HTML -> find /teams/<id>/<slug>
// 2) GET team fixtures HTML -> scrape match anchors (/match/<id> and /matches/...)
// 3) Return match_urls (capped) + debug

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const HDRS_HTML = {
  "accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

function findTeamFromPlayerHtml(html) {
  // Look for /teams/<id>/<slug> (avoid /overview in the slug if possible)
  const all = Array.from(html.matchAll(/href="\/teams\/(\d+)\/([^"\/<]+)(?:\/[^"]*)?"/gi)).map(m => ({ id: m[1], slug: m[2] }));
  if (!all.length) return { team_id: null, team_slug: null };

  // Prefer a slug that is not "overview"
  let pick = all.find(x => x.slug && x.slug.toLowerCase() !== "overview");
  if (!pick) pick = all[0];

  const team_id = Number(pick.id);
  const team_slug = (pick.slug || "team").toLowerCase();
  return { team_id: Number.isFinite(team_id) ? team_id : null, team_slug };
}

function scrapeMatchLinksFromFixturesHtml(html) {
  // Collect both formats
  const set = new Set();

  // /match/<digits>
  for (const m of html.matchAll(/href="(\/match\/\d{5,10}(?:\/[^"]*)?)"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }
  // /matches/<slug>/<token>
  for (const m of html.matchAll(/href="(\/matches\/[^"?#]+)"/gi)) {
    set.add("https://www.fotmob.com" + m[1]);
  }

  // Also scan any embedded JSON for matchId
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
    used_fixtures_url: null,
    anchors_found: 0,
    errors: [],
  };

  if (!player_id) {
    debug.errors.push("Could not parse player_id from URL");
    return { player_url, player_id: null, player_name, match_urls: [], debug };
  }

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

  const fixturesUrl = `https://www.fotmob.com/teams/${team_id}/fixtures/${encodeURIComponent(team_slug)}`;
  debug.used_fixtures_url = fixturesUrl;

  let fixturesHtml = "";
  try {
    fixturesHtml = await fetchText(fixturesUrl);
  } catch (e) {
    debug.errors.push("fixtures_html: " + String(e));
    return { player_url, player_id, player_name, match_urls: [], debug };
  }

  const links = scrapeMatchLinksFromFixturesHtml(fixturesHtml);
  debug.anchors_found = links.length;

  const match_urls = Number(cap) > 0 ? links.slice(0, Number(cap)) : links;
  return { player_url, player_id, player_name, match_urls, debug };
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try {
        payload = JSON.parse(event.body || "{}");
      } catch {
        return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
    } else {
      payload = {
        urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean),
        maxMatches: Number(event.queryStringParameters?.maxMatches || 0),
      };
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
        players.push({
          player_url,
          player_id: null,
          player_name: null,
          match_urls: [],
          debug: { errors: [String(e)] },
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, players }),
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
