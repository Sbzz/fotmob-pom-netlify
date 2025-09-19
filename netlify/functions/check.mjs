// netlify/functions/check.mjs
// Robust POTM (and Highest Rating when possible) with HTML (__NEXT_DATA__) fallback
// + Safe name handling (fixes "s.normalize is not a function")

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

// --- safe name handling ---
function toStrName(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // common shapes from FotMob
    if (v.fullName) return String(v.fullName);
    if (v.longName) return String(v.longName);
    if (v.shortName) return String(v.shortName);
    if (v.name) return String(v.name);
    if (v.playerName) return String(v.playerName);
    const combo = [v.firstName, v.lastName].filter(Boolean).join(" ");
    if (combo) return combo;
    try { return JSON.stringify(v); } catch { /* ignore */ }
  }
  try { return String(v); } catch { return ""; }
}
function norm(v) {
  const s = toStrName(v);
  // normalize only on strings; toStrName guarantees string
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

async function fetchJSON(url, retry = 2) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_JSON, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200) || ""}`);
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      await sleep(200 + 300*i);
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
      await sleep(200 + 300*i);
    }
  }
  throw lastErr || new Error("fetch failed (html)");
}

function extractFirstNumericIdFromPath(pathname="") {
  const m = pathname.match(/\/match\/(\d{5,10})(?:\/|$)/i);
  return m ? m[1] : null;
}
async function resolveMatchIdFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const id = extractFirstNumericIdFromPath(u.pathname);
    if (id) return { matchId: id, finalUrl: urlStr, html: null };

    const { finalUrl, html } = await fetchText(urlStr);
    const id2 = extractFirstNumericIdFromPath(new URL(finalUrl).pathname);
    if (id2) return { matchId: id2, finalUrl, html };
    let m = html.match(/"matchId"\s*:\s*(\d{5,10})/i);
    if (m) return { matchId: m[1], finalUrl, html };
    m = html.match(/\/match\/(\d{5,10})/i);
    if (m) return { matchId: m[1], finalUrl, html };
    return { matchId: null, finalUrl, html };
  } catch {
    return { matchId: null, finalUrl: urlStr, html: null };
  }
}

// ----- readers -----
function ratingsFromJson(json) {
  const arrs = [];
  const home = json?.content?.playerRatings?.home?.players ?? [];
  const away = json?.content?.playerRatings?.away?.players ?? [];
  if (Array.isArray(home)) arrs.push(...home);
  if (Array.isArray(away)) arrs.push(...away);
  return arrs.map(p => ({
    id: p?.id ?? p?.playerId ?? null,
    name: toStrName(p?.name ?? p?.playerName ?? ""),
    rating: p?.rating != null ? Number(p.rating)
          : p?.stats?.rating != null ? Number(p.stats.rating)
          : NaN,
  })).filter(x => x.name || x.id != null);
}
function pickLeagueId(obj) {
  const cands = [
    obj?.general?.leagueId, obj?.general?.tournamentId, obj?.general?.competitionId,
    obj?.content?.leagueId, obj?.content?.tournamentId, obj?.leagueId, obj?.tournamentId
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function pickLeagueName(obj) {
  return obj?.general?.leagueName || obj?.general?.tournamentName || obj?.general?.competitionName ||
         obj?.content?.leagueName || obj?.content?.tournamentName || obj?.leagueName || obj?.tournamentName || null;
}
function pickKickoff(obj) {
  const candStr = obj?.general?.matchTimeUTC || obj?.general?.startTimeUTC || obj?.general?.startDate ||
                  obj?.content?.matchTimeUTC || obj?.content?.startTimeUTC || obj?.content?.startDate ||
                  obj?.matchTimeUTC || obj?.startTimeUTC || obj?.startDate || null;
  if (candStr) { const d = new Date(candStr); if (!isNaN(d)) return d; }
  const candNum = Number(obj?.general?.matchTime ?? obj?.general?.kickoff ?? obj?.kickoff ?? obj?.matchTime);
  if (Number.isFinite(candNum)) { const d = new Date(candNum > 1e12 ? candNum : candNum*1000); if (!isNaN(d)) return d; }
  return null;
}
function explicitPOTM(obj) {
  return obj?.general?.playerOfTheMatch ?? obj?.content?.matchFacts?.playerOfTheMatch ?? null;
}

// ----- NEXT helpers -----
function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(str){ try { return JSON.parse(str); } catch { return null; } }

function deepScanNextForMatch(root, targetId /* optional */) {
  const tgt = targetId ? String(targetId) : null;
  const res = { blocks: [], potm: null, ratings: [], leagueId: null, leagueName: null, kickoff: null };

  const pushRatings = (json) => {
    const rs = ratingsFromJson(json);
    if (rs && rs.length) res.ratings = rs;
  };

  const st = [root];
  while (st.length) {
    const node = st.pop();
    if (!node || typeof node !== "object") continue;

    if (res.leagueId == null) { const lid = pickLeagueId(node); if (lid != null) res.leagueId = lid; }
    if (!res.leagueName) { const ln = pickLeagueName(node); if (ln) res.leagueName = ln; }
    if (!res.kickoff) { const ko = pickKickoff(node); if (ko) res.kickoff = ko; }

    if (!res.potm) {
      const p = explicitPOTM(node);
      if (p && (p.id != null || p.name)) res.potm = p;
    }

    const looks =
      (node.general && (node.content?.playerRatings || node.content?.matchFacts || node.content?.lineups)) ||
      (node.content && (node.content.playerRatings || node.content.matchFacts));
    if (looks) {
      const idGuess = node?.general?.matchId ?? node?.general?.id ?? node?.content?.matchId ?? node?.matchId ?? null;
      if (!tgt || (idGuess != null && String(idGuess) === tgt)) {
        res.blocks.push(node);
        pushRatings(node);
      }
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v) continue;
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") st.push(it);
      else if (typeof v === "object") st.push(v);
    }
  }

  return res;
}

async function nextFallbackJSON(matchUrl, knownHtml, matchId /* optional */) {
  const { html } = knownHtml ? { finalUrl: matchUrl, html: knownHtml } : await fetchText(matchUrl);
  const ndStr = extractNextDataString(html);
  if (!ndStr) {
    // last-resort: regex-only POTM from raw HTML
    const rx = /"playerOfTheMatch"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"id"\s*:\s*(\d+)/i;
    const m = html.match(rx);
    if (m) return { data: null, source: "next_html_regex", potm: { name: m[1], id: Number(m[2]) }, ratings: [] };
    throw new Error("NEXT_DATA not found in HTML");
  }
  const nd = safeJSON(ndStr);
  if (!nd) throw new Error("NEXT_DATA JSON parse failed");

  let targetId = matchId ? String(matchId) : null;
  if (!targetId) {
    const m1 = html.match(/"matchId"\s*:\s*(\d{5,10})/i) || html.match(/\/match\/(\d{5,10})/i);
    if (m1) targetId = m1[1];
  }

  const scan = deepScanNextForMatch(nd, targetId);
  const dataLike =
    scan.blocks[0] ||
    { general: { leagueId: scan.leagueId, leagueName: scan.leagueName, matchTimeUTC: scan.kickoff?.toISOString?.() || null },
      content: scan.ratings.length ? { playerRatings: { home:{players:[]}, away:{players: scan.ratings} } } : {} };

  return { data: dataLike, source: "next_html", potmOverride: scan.potm || null, ratingsOverride: scan.ratings };
}

// ---------- handler ----------
export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers: { "content-type":"application/json" }, body: JSON.stringify({ error:"Invalid JSON body" }) }; }
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
      return { statusCode: 400, headers: { "content-type":"application/json" }, body: JSON.stringify({ error:"Provide { playerId or playerName, matchUrl }" }) };
    }

    const { matchId, finalUrl, html: maybeHtml } = await resolveMatchIdFromUrl(matchUrl);
    if (!matchId) {
      return { statusCode: 400, headers: { "content-type":"application/json" }, body: JSON.stringify({ error:"Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    // 1) API fast path
    let data = null, source = "api";
    try {
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    } catch {
      // 2) HTML fallback with deep scan
      const { data: d2, source: s2, potmOverride, ratingsOverride } =
        await nextFallbackJSON(finalUrl, maybeHtml || null, matchId);
      data = d2; source = s2 || "next_html";
      if (potmOverride && (!data?.general?.playerOfTheMatch && !data?.content?.matchFacts?.playerOfTheMatch)) {
        if (!data.general) data.general = {};
        data.general.playerOfTheMatch = potmOverride;
      }
      if (ratingsOverride && ratingsOverride.length && !data?.content?.playerRatings) {
        if (!data.content) data.content = {};
        data.content.playerRatings = { home:{players:[]}, away:{players: ratingsOverride} };
      }
    }

    // League / time
    const leagueId = pickLeagueId(data);
    const league_label = pickLeagueName(data) || null;
    const league_allowed = leagueId != null && TOP5_LEAGUE_IDS.has(Number(leagueId));

    const dt = pickKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt >= SEASON_START && dt <= SEASON_END) : false;

    // Ratings (if present)
    const ratings = ratingsFromJson(data);
    const maxRating = ratings.length ? Math.max(...ratings.map(r => Number(r.rating || 0))) : null;

    const pidOK = Number.isFinite(playerId);
    const nPlayer = norm(playerName);
    const me = ratings.find(r =>
      (pidOK && Number(r.id) === playerId) || (!!nPlayer && r.name && norm(r.name) === nPlayer)
    ) || null;

    // POTM: explicit preferred, else max rating
    const expl = explicitPOTM(data);
    const potm = expl || (ratings.length ? (() => {
      const rs = [...ratings].sort((a,b)=>Number(b.rating||0)-Number(a.rating||0));
      return rs[0] ? { id: rs[0].id ?? null, name: rs[0].name ?? null, by:"max_rating_fallback", rating: rs[0].rating ?? null } : null;
    })() : null);

    const potm_name_text = toStrName(potm?.name ?? potm ?? "");
    const player_is_pom =
      !!potm &&
      (
        (pidOK && Number(potm.id) === playerId) ||
        (!!nPlayer && norm(potm_name_text) === nPlayer)
      );

    const has_highest_rating =
      me && maxRating != null ? Number(me.rating || 0) === Number(maxRating) : false;

    const match_title =
      data?.general?.matchName ||
      `${toStrName(data?.general?.homeTeam?.name ?? "")} vs ${toStrName(data?.general?.awayTeam?.name ?? "")}`.trim() || null;

    return {
      statusCode: 200,
      headers: { "content-type":"application/json" },
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
        potm_name_text,
        potm_id: potm?.id ?? null,
        source
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type":"application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
