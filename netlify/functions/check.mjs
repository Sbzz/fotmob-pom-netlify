// netlify/functions/check.mjs
// Accepts match URLs in both formats:
//   • https://www.fotmob.com/match/4694553[/...]
//   • https://www.fotmob.com/matches/levante-vs-barcelona/2g8c9m
// Resolves the numeric matchId, then:
// 1) Try /api/matchDetails?matchId=...
// 2) On 401/403/any failure, fetch HTML and parse __NEXT_DATA__ to compute POTM/Highest.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
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

function norm(s = "") {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

async function fetchJSON(url, retry = 2) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_JSON, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0, 200) || ""}`);
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      await sleep(200 + 300 * i);
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function fetchText(url, retry = 2) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_HTML, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!txt) throw new Error("Empty HTML");
      return { finalUrl: res.url || url, html: txt };
    } catch (e) {
      lastErr = e;
      await sleep(200 + 300 * i);
    }
  }
  throw lastErr || new Error("fetch failed (html)");
}

function extractFirstNumericIdFromPath(pathname = "") {
  const m = pathname.match(/\/match\/(\d{5,10})(?:\/|$)/i);
  return m ? m[1] : null;
}

async function resolveMatchIdFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const id = extractFirstNumericIdFromPath(u.pathname);
    if (id) return { matchId: id, finalUrl: urlStr, html: null };

    // Not a /match/<id> URL — fetch the page to find the numeric id
    const { finalUrl, html } = await fetchText(urlStr);
    const id2 = extractFirstNumericIdFromPath(new URL(finalUrl).pathname);
    if (id2) return { matchId: id2, finalUrl, html };
    // Fallback: scan HTML
    let m = html.match(/"matchId"\s*:\s*(\d{5,10})/i);
    if (m) return { matchId: m[1], finalUrl, html };
    m = html.match(/\/match\/(\d{5,10})/i);
    if (m) return { matchId: m[1], finalUrl, html };
    return { matchId: null, finalUrl, html };
  } catch {
    return { matchId: null, finalUrl: urlStr, html: null };
  }
}

// ---------- Match JSON readers ----------
function getAllRatings(json) {
  const arrs = [];
  const home = json?.content?.playerRatings?.home?.players ?? [];
  const away = json?.content?.playerRatings?.away?.players ?? [];
  if (Array.isArray(home)) arrs.push(...home);
  if (Array.isArray(away)) arrs.push(...away);
  return arrs
    .map((p) => ({
      id: p?.id ?? p?.playerId ?? null,
      name: p?.name ?? p?.playerName ?? "",
      rating:
        p?.rating != null
          ? Number(p.rating)
          : p?.stats?.rating != null
          ? Number(p.stats.rating)
          : NaN,
    }))
    .filter((x) => x.name || x.id != null);
}

function findPOTM(json) {
  const cand =
    json?.general?.playerOfTheMatch ??
    json?.content?.matchFacts?.playerOfTheMatch ??
    null;
  if (cand && (cand.id != null || cand.name)) return cand;

  const ratings = getAllRatings(json);
  if (!ratings.length) return null;
  ratings.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
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

// ---------- __NEXT_DATA__ fallback ----------
function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(str) { try { return JSON.parse(str); } catch { return null; } }

function deepFindMatchDetails(root, targetMatchId) {
  const tgt = String(targetMatchId || "").trim();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    // Heuristic: an object that has general + content with playerRatings/matchFacts looks like matchDetails
    const looksLike =
      node.general &&
      (node.content?.playerRatings || node.content?.matchFacts || node.content?.lineups);

    if (looksLike) {
      const idGuess =
        node?.general?.matchId ??
        node?.general?.id ??
        node?.content?.matchId ??
        node?.matchId ??
        null;
      if (tgt ? String(idGuess) === tgt : true) {
        return node;
      }
    }

    // keep walking
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v) continue;
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") stack.push(it);
      else if (typeof v === "object") stack.push(v);
    }
  }
  return null;
}

async function getMatchJSONViaNext(matchUrl, knownHtml) {
  const { html } = knownHtml ? { finalUrl: matchUrl, html: knownHtml } : await fetchText(matchUrl);
  const nd = extractNextDataString(html);
  if (!nd) throw new Error("NEXT_DATA not found in HTML");
  const obj = safeJSON(nd);
  if (!obj) throw new Error("NEXT_DATA JSON parse failed");

  // Try to determine matchId quickly for targeting
  let targetId = null;
  const m1 = html.match(/"matchId"\s*:\s*(\d{5,10})/i);
  if (m1) targetId = m1[1];
  const m2 = html.match(/\/match\/(\d{5,10})/i);
  if (!targetId && m2) targetId = m2[1];

  const details = deepFindMatchDetails(obj, targetId);
  if (!details) throw new Error("match details not found inside NEXT_DATA");
  return details;
}

// ---------- handler ----------
export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch {
        return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
    } else {
      payload = {
        playerId: Number(event.queryStringParameters?.playerId || NaN),
        playerName: event.queryStringParameters?.playerName || "",
        matchUrl: event.queryStringParameters?.matchUrl || ""
      };
    }

    const playerId = Number(payload.playerId || NaN);
    const playerName = String(payload.playerName || "").trim();
    const matchUrl = String(payload.matchUrl || "").trim();

    if (!matchUrl || (!playerName && !Number.isFinite(playerId))) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { playerId or playerName, matchUrl }" }) };
    }

    // Resolve numeric matchId (also returns HTML if we had to fetch it)
    const { matchId, finalUrl, html: maybeHtml } = await resolveMatchIdFromUrl(matchUrl);
    if (!matchId) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    // Try API first
    let data = null;
    let source = "api";
    try {
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    } catch (e) {
      // Fallback to HTML (__NEXT_DATA__)
      source = "next_html";
      const details = await getMatchJSONViaNext(finalUrl, maybeHtml || null);
      data = details;
    }

    // Read fields
    const leagueId = extractLeagueId(data);
    const league_allowed = leagueId != null && TOP5_LEAGUE_IDS.has(Number(leagueId));
    const league_label = extractLeagueName(data) || null;

    const dt = extractKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt >= SEASON_START && dt <= SEASON_END) : false;

    const ratings = getAllRatings(data);
    const maxRating = ratings.length ? Math.max(...ratings.map(r => Number(r.rating || 0))) : null;

    const pidOK = Number.isFinite(playerId);
    const nPlayer = norm(playerName);
    const me = ratings.find(r =>
      (pidOK && Number(r.id) === playerId) ||
      (!!nPlayer && norm(r.name) === nPlayer)
    ) || null;

    const potm = findPOTM(data);
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
      data?.general?.matchName ||
      `${data?.general?.homeTeam?.name ?? ""} vs ${data?.general?.awayTeam?.name ?? ""}`.trim();

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
        potm_id: potm?.id ?? null,
        source
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
