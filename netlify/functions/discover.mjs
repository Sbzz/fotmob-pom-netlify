// netlify/functions/discover.mjs
// Finds Top-5 domestic league match URLs for the 2025–26 season window.
// Returns the same candidate match list for each player (the /check function will filter by player name).

// ---- CONFIG ----
const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const FOTMOB_MATCHES = "https://www.fotmob.com/api/matches?date=";

// ---- UTILS ----
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
  for (; cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    yield new Date(cur);
  }
}

async function fetchJSON(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retry) throw e;
      await sleep(300 + 300 * i);
    }
  }
}

// Concurrently fetch per-day match lists; keep only Top-5 leagues
async function getTop5SeasonMatches({ fromUTC, toUTC, concurrency = 6 }) {
  const ids = new Set();
  const infos = new Map();
  const dates = Array.from(dateRangeUTC(fromUTC, toUTC));
  let index = 0;

  async function worker() {
    while (index < dates.length) {
      const i = index++;
      const d = dates[i];
      const key = yyyymmdd(d);
      try {
        const data = await fetchJSON(FOTMOB_MATCHES + key);
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
                title:
                  m?.name ||
                  `${m?.home?.name ?? ""} vs ${m?.away?.name ?? ""}`.trim(),
              });
            }
          }
        }
      } catch {
        // ignore per-day failures; continue
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, dates.length) }, worker);
  await Promise.all(workers);
  return { ids, infos };
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

// ---- NETLIFY HANDLER ----
export async function handler(event) {
  try {
    // Accept POST JSON (preferred) or GET query string for quick tests
    let payload = {};
    if (event.httpMethod === "POST") {
      try {
        payload = JSON.parse(event.body || "{}");
      } catch {
        return {
          statusCode: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "Invalid JSON body" }),
        };
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
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Provide { urls: [...] }" }),
      };
    }

    // Season window (UTC). Default: from 2025-08-01 to today.
    const fromStr = payload.from || process.env.SEASON_FROM_YYYYMMDD || "20250801";
    const todayUTC = new Date();
    const defaultTo = yyyymmdd(
      new Date(
        Date.UTC(
          todayUTC.getUTCFullYear(),
          todayUTC.getUTCMonth(),
          todayUTC.getUTCDate()
        )
      )
    );
    const toStr = payload.to || process.env.SEASON_TO_YYYYMMDD || defaultTo;

    const fromUTC = new Date(
      Date.UTC(+fromStr.slice(0, 4), +fromStr.slice(4, 6) - 1, +fromStr.slice(6, 8))
    );
    const toUTC = new Date(
      Date.UTC(+toStr.slice(0, 4), +toStr.slice(4, 6) - 1, +toStr.slice(6, 8))
    );

    // Pull Top-5 league matches once for the window
    const { ids, infos } = await getTop5SeasonMatches({
      fromUTC,
      toUTC,
      concurrency: 6,
    });

    const allMatchUrls = Array.from(ids).map(
      (id) => `https://www.fotmob.com/match/${id}`
    );

    // Respect maxMatches (cap per player) if provided
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
        leagues: Array.from(
          new Set(Array.from(infos.values()).map((v) => v.leagueId))
        ),
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
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: String(e) }),
    };
  }
}
