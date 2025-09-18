// netlify/functions/discover.mjs
// Discovers Top-5 domestic league match URLs for a date window via FotMob public JSON.
// Returns same candidate match list for every player; /check will filter per player.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const BASE = process.env.FOTMOB_MATCHES_BASE || "https://www.fotmob.com/api/matches?date=";
const EXTRA = process.env.FOTMOB_TZ || "&timezone=UTC";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS = {
  accept: "application/json",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yyyymmdd = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
};
function* dateRangeUTC(from, to) {
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  for (; cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) yield new Date(cur);
}
async function fetchJSON(url, retry = 3) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200) || ""}`);
      return JSON.parse(txt);
    } catch (e) {
      last = e;
      await sleep(300 + 400 * i);
    }
  }
  throw last || new Error("fetch failed");
}

// Pull per-day lists; keep only Top-5 leagues
async function getTop5SeasonMatches({ fromUTC, toUTC, concurrency = 4 }) {
  const ids = new Set();
  const dates = Array.from(dateRangeUTC(fromUTC, toUTC));
  let index = 0;
  async function worker() {
    while (index < dates.length) {
      const d = dates[index++];
      const key = yyyymmdd(d);
      const url = `${BASE}${key}${EXTRA}`;
      try {
        const data = await fetchJSON(url);
        for (const lg of data?.leagues ?? []) {
          const leagueId = Number(lg?.primaryId);
          if (!TOP5_LEAGUE_IDS.has(leagueId)) continue;
          for (const m of lg?.matches ?? []) {
            const id = String(m?.id ?? "").trim();
            if (id) ids.add(id);
          }
        }
      } catch {
        // ignore per-day failure
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, dates.length) }, worker));
  return Array.from(ids).map((id) => `https://www.fotmob.com/match/${id}`);
}

function parsePlayer(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // /players/<id>/<slug>
    const pid = Number(parts[1]);
    const slug = decodeURIComponent(parts[2] || "").replace(/-/g, " ").trim();
    return { player_id: Number.isFinite(pid) ? pid : null, player_name: slug || null };
  } catch {
    return { player_id: null, player_name: null };
  }
}

export async function handler(event) {
  try {
    // POST JSON or GET query
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON body" }) }; }
    } else {
      payload = {
        urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean),
        maxMatches: Number(event.queryStringParameters?.maxMatches || 0),
        from: event.queryStringParameters?.from,
        to: event.queryStringParameters?.to,
      };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    if (!urls.length) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    // Season window defaults
    const fromStr = payload.from || process.env.SEASON_FROM_YYYYMMDD || "20250701";
    const now = new Date();
    const defaultTo = yyyymmdd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    const toStr = payload.to || process.env.SEASON_TO_YYYYMMDD || defaultTo;

    const fromUTC = new Date(Date.UTC(+fromStr.slice(0, 4), +fromStr.slice(4, 6) - 1, +fromStr.slice(6, 8)));
    const toUTC   = new Date(Date.UTC(+toStr.slice(0, 4), +toStr.slice(4, 6) - 1, +toStr.slice(6, 8)));

    const allMatchUrls = await getTop5SeasonMatches({ fromUTC, toUTC, concurrency: 4 });
    const cap = Number(payload.maxMatches) || 0;
    const perPlayer = cap > 0 ? allMatchUrls.slice(0, cap) : allMatchUrls;

    const players = urls.map((player_url) => {
      const parsed = parsePlayer(player_url);
      return {
        player_url,
        player_id: parsed.player_id,
        player_name: (payload.player_name_override || parsed.player_name || "").trim(),
        match_urls: perPlayer,
        debug: {
          total_candidates: allMatchUrls.length,
          returned: perPlayer.length,
          window_from: fromStr,
          window_to: toStr
        }
      };
    });

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        players,
        meta: {
          unique_matches: allMatchUrls.length,
          returned_per_player: perPlayer.length,
          season_window: { from: fromStr, to: toStr },
          leagues_kept: ["PL(47)", "LaLiga(87)", "Bundesliga(54)", "Serie A(55)", "Ligue 1(53)"]
        }
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
