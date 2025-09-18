// netlify/functions/discover.mjs
// Discovers Top-5 domestic league match URLs in a date window by calling FotMob's public JSON.
// Returns same candidate matches for every player; /check filters per player.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const BASE = process.env.FOTMOB_MATCHES_BASE || "https://www.fotmob.com/api/matches?date=";
const TZ_PARAM = process.env.FOTMOB_TZ || "&timezone=UTC";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const COMMON_HEADERS = {
  accept: "application/json",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function yyyymmdd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function* dateRangeUTC(from, to) {
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  for (; cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) yield new Date(cur);
}

async function fetchJSON(url, retry = 3) {
  let lastErr = null;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: COMMON_HEADERS });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200) || ""}`);
      try {
        return JSON.parse(txt);
      } catch (e) {
        throw new Error(`Non-JSON response (${txt?.slice(0,120) || "empty"})`);
      }
    } catch (e) {
      lastErr = e;
      await sleep(300 + 400 * i);
    }
  }
  throw lastErr || new Error("Unknown fetch error");
}

// Pull per-day lists; keep only Top-5 leagues
async function getTop5SeasonMatches({ fromUTC, toUTC, concurrency = 6 }) {
  const ids = new Set();
  const infos = new Map();
  const dates = Array.from(dateRangeUTC(fromUTC, toUTC));
  let index = 0;
  const fails = [];

  async function worker() {
    while (index < dates.length) {
      const i = index++;
      const d = dates[i];
      const key = yyyymmdd(d);
      const url = `${BASE}${key}${TZ_PARAM}`;
      try {
        const data = await fetchJSON(url);
        for (const lg of data?.leagues ?? []) {
          const leagueId = Number(lg?.primaryId);
          if (!TOP5_LEAGUE_IDS.has(leagueId)) continue;
          for (const m of lg?.matches ?? []) {
            const id = String(m?.id ?? "").trim();
            if (!id) continue;
            if (!ids.has(id)) {
              ids.add(id);
              infos.set(id, {
                id,
                leagueId,
                leagueName: lg?.name,
                dateUTC: key,
                title: m?.name || `${m?.home?.name ?? ""} vs ${m?.away?.name ?? ""}`.trim(),
              });
            }
          }
        }
      } catch (e) {
        // capture a small sample of failures for debug
        if (fails.length < 6) fails.push({ date: key, error: String(e).slice(0, 220) });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, dates.length) }, worker);
  await Promise.all(workers);
  return { ids, infos, fails };
}

function extractSlugName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const slug = decodeURIComponent(parts.at(-1) || "");
    return slug.replace(/-/g, " ").trim() || null;
  } catch {
    return null;
  }
}

export async function handler(event) {
  try {
    // Accept POST (JSON) or GET (query) for quick tests
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
        from: event.queryStringParameters?.from,
        to: event.queryStringParameters?.to,
      };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    if (!urls.length) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    // Season window (UTC). Default: from 2025-08-01 to TODAY (UTC).
    const fromStr = payload.from || process.env.SEASON_FROM_YYYYMMDD || "20250801";
    const todayUTC = new Date();
    const defaultTo = yyyymmdd(new Date(Date.UTC(todayUTC.getUTCFullYear(), todayUTC.getUTCMonth(), todayUTC.getUTCDate())));
    const toStr = payload.to || process.env.SEASON_TO_YYYYMMDD || defaultTo;

    const fromUTC = new Date(Date.UTC(+fromStr.slice(0, 4), +fromStr.slice(4, 6) - 1, +fromStr.slice(6, 8)));
    const toUTC   = new Date(Date.UTC(+toStr.slice(0, 4), +toStr.slice(4, 6) - 1, +toStr.slice(6, 8)));

    // Fetch once for window
    const { ids, infos, fails } = await getTop5SeasonMatches({ fromUTC, toUTC, concurrency: 6 });
    const allMatchUrls = Array.from(ids).map((id) => `https://www.fotmob.com/match/${id}`);

    const cap = Number(payload.maxMatches) || 0;
    const perPlayer = cap > 0 ? allMatchUrls.slice(0, cap) : allMatchUrls;

    const players = urls.map((player_url) => ({
      player_url,
      player_name: payload.player_name_override || extractSlugName(player_url),
      match_urls: perPlayer,
      debug: {
        total_candidates: allMatchUrls.length,
        returned: perPlayer.length,
        window_from: fromStr,
        window_to: toStr,
        leagues: Array.from(new Set(Array.from(infos.values()).map((v) => v.leagueId))),
        failed_days_count: fails.length,
        failed_days_sample: fails, // small sample of errors
      },
    }));

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
          leagues_kept: ["PL(47)", "LaLiga(87)", "Bundesliga(54)", "Serie A(55)", "Ligue 1(53)"],
        },
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
