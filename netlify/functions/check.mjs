// netlify/functions/check.mjs
// Accepts match URLs in both formats:
//   • https://www.fotmob.com/match/4694553[/...]
//   • https://www.fotmob.com/matches/levante-vs-barcelona/2g8c9m
// Resolves the numeric matchId and then calls /api/matchDetails?matchId=...

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]);
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0));     // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59)); // 2026-06-30

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS_JSON = {
  accept: "application/json",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
};
const HDRS_HTML = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, retry = 3) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_JSON, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0, 200) || ""}`);
      return JSON.parse(txt);
    } catch (e) {
      last = e;
      await sleep(200 + 400 * i);
    }
  }
  throw last || new Error("fetch failed");
}

function extractFirstNumericIdFromPath(pathname = "") {
  const m = pathname.match(/\/match\/(\d{5,10})(?:\/|$)/i); // handles /match/<id> and /match/<id>/playbyplay
  return m ? m[1] : null;
}

async function resolveMatchIdFromUrl(urlStr) {
  // 1) If it's already /match/<digits>, done.
  try {
    const u = new URL(urlStr);
    const id = extractFirstNumericIdFromPath(u.pathname);
    if (id) return id;

    // 2) If it's /matches/..., try to follow redirect and read the final URL (Node fetch exposes res.url)
    const res = await fetch(urlStr, { headers: HDRS_HTML, redirect: "follow" });
    const finalUrl = res.url || urlStr;
    const id2 = extractFirstNumericIdFromPath(new URL(finalUrl).pathname);
    if (id2) return id2;

    // 3) Parse HTML for any /match/<digits> or "matchId": <digits>
    const html = await res.text();
    let m = html.match(/\/match\/(\d{5,10})/);
    if (m) return m[1];
    m = html.match(/"matchId"\s*:\s*(\d{5,10})/i);
    if (m) return m[1];

    return null;
  } catch {
    return null;
  }
}

function norm(s = "") { return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }

function getAllRatings(json) {
  const arrs = [];
  const home = json?.content?.playerRatings?.home?.players ?? [];
  const away = json?.content?.playerRatings?.away?.players ?? [];
  if (Array.isArray(home)) arrs.push(...home);
  if (Array.isArray(away)) arrs.push(...away);
  return arrs.map(p => ({
    id: p?.id ?? p?.playerId ?? null,
    name: p?.name ?? p?.playerName ?? "",
    rating: (p?.rating != null) ? Number(p.rating) : (p?.stats?.rating != null ? Number(p.stats.rating) : NaN)
  })).filter(x => x.name || x.id != null);
}

function findPOTM(json) {
  const cand = json?.general?.playerOfTheMatch ?? json?.content?.matchFacts?.playerOfTheMatch ?? null;
  if (cand && (cand.id != null || cand.name)) return cand;

  const ratings = getAllRatings(json);
  if (!ratings.length) return null;
  ratings.sort((a, b) => (Number(b.rating || 0) - Number(a.rating || 0)));
  const top = ratings[0];
  if (!top) return null;
  return { id: top.id ?? null, name: top.name ?? null, by: "max_rating_fallback", rating: top.rating ?? null };
}

function extractLeagueId(json) {
  const a = Number(json?.general?.leagueId ?? json?.general?.tournamentId ?? json?.general?.competitionId ?? NaN);
  if (Number.isFinite(a)) return a;
  const b = Number(json?.content?.leagueId ?? json?.content?.tournamentId ?? NaN);
  if (Number.isFinite(b)) return b;
  return null;
}

function extractLeagueName(json) {
  return json?.general?.leagueName || json?.general?.tournamentName || json?.general?.competitionName || null;
}

function extractKickoff(json) {
  const iso = json?.general?.matchTimeUTC || json?.general?.startTimeUTC || json?.general?.startDate;
  if (iso) { const d = new Date(iso); if (!Number.isNaN(d.getTime())) return d; }
  const ts = Number(json?.general?.matchTime || json?.general?.kickoff);
  if (Number.isFinite(ts)) { const d = new Date(ts > 1e12 ? ts : ts * 1000); if (!Number.isNaN(d.getTime())) return d; }
  return null;
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
      payload = { playerId: Number(event.queryStringParameters?.playerId || NaN), playerName: event.queryStringParameters?.playerName || "", matchUrl: event.queryStringParameters?.matchUrl || "" };
    }

    const playerId = Number(payload.playerId || NaN);
    const playerName = String(payload.playerName || "").trim();
    const matchUrl = String(payload.matchUrl || "").trim();

    if (!matchUrl || (!playerName && !Number.isFinite(playerId))) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { playerId or playerName, matchUrl }" }) };
    }

    const matchId = await resolveMatchIdFromUrl(matchUrl);
    if (!matchId) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    const json = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    const leagueId = extractLeagueId(json);
    const league_allowed = leagueId != null && TOP5_LEAGUE_IDS.has(Number(leagueId));
    const league_label = extractLeagueName(json) || null;

    const dt = extractKickoff(json);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt >= SEASON_START && dt <= SEASON_END) : false;

    const ratings = getAllRatings(json);
    const maxRating = ratings.length ? Math.max(...ratings.map(r => Number(r.rating || 0))) : null;

    const pidOK = Number.isFinite(playerId);
    const nPlayer = norm(playerName);
    const me = ratings.find(r =>
      (pidOK && Number(r.id) === playerId) ||
      (!!nPlayer && norm(r.name) === nPlayer)
    ) || null;

    const potm = findPOTM(json);
    const player_is_pom =
      potm
        ? ((pidOK && Number(potm.id) === playerId) ||
           (!!nPlayer && potm.name && norm(potm.name) === nPlayer))
        : false;

    const has_highest_rating =
      me && maxRating != null
        ? Number(me.rating || 0) === Number(maxRating)
        : false;

    const match_title =
      json?.general?.matchName ||
      `${json?.general?.homeTeam?.name ?? ""} vs ${json?.general?.awayTeam?.name ?? ""}`.trim();

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match_url: matchUrl,
        resolved_match_id: matchId,
        match_title,
        league_id: leagueId,
        league_label,
        match_datetime_utc,
        league_allowed,
        within_season_2025_26,
        player_is_pom,
        has_highest_rating,
        player_rating: me?.rating ?? null,
        max_rating: maxRating,
        potm_name: potm?.name ?? null,
        potm_id: potm?.id ?? null
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
