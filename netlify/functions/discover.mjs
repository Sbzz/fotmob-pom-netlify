// netlify/functions/discover.mjs
export const config = { path: "/.netlify/functions/discover" };

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const FOTMOB_MATCHES = "https://www.fotmob.com/api/matches?date=";

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

async function fetchJSON(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { "accept": "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retry) throw e;
      await sleep(300 + 300 * i);
    }
  }
}

async function getTop5SeasonMatches({ fromUTC, toUTC, concurrency = 6 }) {
  const ids = new Set();
  const infos = new Map();

  const dates = Array.from(dateRangeUTC(fromUTC, toUTC));
  let active = 0, idx = 0;

  return await new Promise((resolve, reject) => {
    const next = async () => {
      if (idx >= dates.length && active === 0) {
        return resolve({ ids, infos });
      }
      while (active < concurrency && idx < dates.length) {
        const d = dates[idx++];
        active++;
        (async () => {
          const key = yyyymmdd(d);
          try {
            const data = await fetchJSON(FOTMOB_MATCHES + key);
            // Structure: { leagues: [ { primaryId, name, matches: [ { id, pageUrl, ... } ] } ] }
            for (const lg of (data?.leagues ?? [])) {
              if (!TOP5_LEAGUE_IDS.has(Number(lg?.primaryId))) continue;
              for (const m of (lg?.matches ?? [])) {
                const id = String(m?.id ?? "").trim();
                if (!id) continue;
                if (!ids.has(id)) {
                  ids.add(id);
                  infos.set(id, {
                    id,
                    leagueId: Number(lg.primaryId),
                    leagueName: lg.name,
                    dateUTC: key,
                    title: m?.name || `${m?.home?.name ?? ""} vs ${m?.away?.name ?? ""}`.trim(),
                  });
                }
              }
            }
          } catch (_) {
            // swallow per-day errors; continue
          } finally {
            active--;
            next();
          }
        })();
      }
    };
    next();
  });
}

function extractPlayerNameFromUrl(url) {
  try {
    const u = new URL(url);
    // e.g. /players/1467236/lamine-yamal
    const parts = u.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts.at(-1) || "");
  } catch {
    return "";
  }
}

export default async (req, context) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
    }
    const body = await req.json().catch(() => ({}));
    const urls = body.urls || body.players?.map(p => p.player_url) || [];

    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ error: "Provide { urls: [...] }" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Season window (UTC) for domestic 2025–26. Defaults cover early season now; widen via env if needed.
    const fromStr = process.env.SEASON_FROM_YYYYMMDD || "20250801";
    const toStr   = process.env.SEASON_TO_YYYYMMDD   || (()=>{
      const today = new Date();
      return yyyymmdd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
    })();

    const fromUTC = new Date(Date.UTC(+fromStr.slice(0,4), +fromStr.slice(4,6)-1, +fromStr.slice(6,8)));
    const toUTC   = new Date(Date.UTC(+toStr.slice(0,4), +toStr.slice(4,6)-1, +toStr.slice(6,8)));

    // Pull all Top-5 league matches in the window once.
    const { ids, infos } = await getTop5SeasonMatches({
