// netlify/functions/check.mjs
// Robust POTM (and Highest Rating when possible) with HTML (__NEXT_DATA__) fallback.
// Works with both match URL styles and blocked API (401/403).

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
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();

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

    // Not /match/<id> → load HTML to find id
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

// ---------- Readers ----------
function ratingsFromJson(json) {
  // search both canonical and variant shapes
  const out = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      const id = p?.id ?? p?.playerId ?? p?.player?.id ?? null;
      const name = p?.name ?? p?.playerName ?? p?.player?.name ?? "";
      const rating =
        p?.rating != null ? Number(p.rating) :
        p?.stats?.rating != null ? Number(p.stats.rating) :
        p?.playerRating != null ? Number(p.playerRating) :
        NaN;
      if (name || id != null) out.push({ id, name, rating });
    }
  };

  // canonical
  const home = json?.content?.playerRatings?.home?.players;
  const away = json?.content?.playerRatings?.away?.players;
  push(home); push(away);

  // sometimes flattened
  push(json?.playerRatings?.home?.players);
  push(json?.playerRatings?.away?.players);

  // generic arrays with rating + (id|name)
  const stack = [json];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    for (const [k,v] of Object.entries(node)) {
      if (!v) continue;
      if (Array.isArray(v)) {
        // push arrays with objects that look like ratings
        if (v.length && typeof v[0] === "object" && ("rating" in v[0] || "playerRating" in v[0])) push(v);
        for (const it of v) if (it && typeof it === "object") stack.push(it);
      } else if (typeof v === "object") stack.push(v);
    }
  }

  return out;
}

function pickLeagueId(obj) {
  const stack=[obj];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    for (const [k,v] of Object.entries(n)) {
      const kk = String(k).toLowerCase();
      if (/(leagueid|tournamentid|competitionid)$/.test(kk)) {
        const num = Number(v); if (Number.isFinite(num)) return num;
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}
function pickLeagueName(obj) {
  const stack=[obj];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    for (const [k,v] of Object.entries(n)) {
      const kk = String(k).toLowerCase();
      if (/(leaguename|tournamentname|competitionname)$/.test(kk) && typeof v === "string") return v;
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}
function pickKickoff(obj) {
  // ISO-ish string
  const stack=[obj];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    for (const [k,v] of Object.entries(n)) {
      const kk = String(k).toLowerCase();
      if (/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc)$/.test(kk) && typeof v === "string") {
        const d = new Date(v); if (!isNaN(d)) return d;
      }
      if (/^(matchtime|kickoff|epoch|timestamp)$/.test(kk) && Number.isFinite(Number(v))) {
        const ts = Number(v); const d = new Date(ts > 1e12 ? ts : ts*1000); if (!isNaN(d)) return d;
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function explicitPOTM(obj) {
  // look for playerOfTheMatch anywhere
  const stack=[obj];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.playerOfTheMatch && (n.playerOfTheMatch.id != null || n.playerOfTheMatch.name)) {
      return n.playerOfTheMatch;
    }
    if (n.matchFacts && n.matchFacts.playerOfTheMatch) {
      const p = n.matchFacts.playerOfTheMatch;
      if (p && (p.id != null || p.name)) return p;
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

function deriveTitle(obj, html) {
  const g = obj?.general;
  const n = g?.matchName;
  if (n) return n;
  const ht = g?.homeTeam?.name || obj?.homeTeam?.name || "";
  const at = g?.awayTeam?.name || obj?.awayTeam?.name || "";
  if (ht || at) return `${ht || "?"} vs ${at || "?"}`;
  if (html) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) return m[1].replace(/\s+/g," ").trim();
  }
  return "vs";
}

function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(str) { try { return JSON.parse(str); } catch { return null; } }

function deepScanNext(root) {
  // Returns a merged "best effort" data-like block plus helpers
  const results = { blocks: [], ratings: [], potm: null, leagueId: null, leagueName: null, kickoff: null };
  const stack=[root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node!=="object") continue;

    // league + time rolling capture
    if (results.leagueId == null) { const lid = pickLeagueId(node); if (lid != null) results.leagueId = lid; }
    if (!results.leagueName) { const ln = pickLeagueName(node); if (ln) results.leagueName = ln; }
    if (!results.kickoff) { const ko = pickKickoff(node); if (ko) results.kickoff = ko; }

    if (!results.potm) {
      const p = explicitPOTM(node);
      if (p) results.potm = p;
    }

    // candidate block
    const looksLike =
      (node.general && (node.content?.playerRatings || node.content?.matchFacts || node.content?.lineups)) ||
      (node.content && (node.content.playerRatings || node.content.matchFacts));
    if (looksLike) results.blocks.push(node);

    // push ratings if present
    const rs = ratingsFromJson(node);
    if (rs.length) results.ratings = rs;

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") stack.push(v);
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") stack.push(it);
    }
  }

  // synthesize minimal block if none found
  const block =
    results.blocks[0] ||
    { general: { leagueId: results.leagueId, leagueName: results.leagueName, matchTimeUTC: results.kickoff?.toISOString?.() || null }, content: {} };
  if (results.ratings.length && !block.content.playerRatings) {
    block.content.playerRatings = { home:{players:[]}, away:{players: results.ratings} };
  }
  if (results.potm && !block.general?.playerOfTheMatch && !block.content?.matchFacts?.playerOfTheMatch) {
    if (!block.general) block.general = {};
    block.general.playerOfTheMatch = results.potm;
  }

  return { data: block, helpers: results };
}

async function nextFallbackJSON(matchUrl, knownHtml) {
  const { html } = knownHtml ? { finalUrl: matchUrl, html: knownHtml } : await fetchText(matchUrl);
  const nd = extractNextDataString(html);
  if (!nd) {
    // last resort: direct regex for POTM in HTML
    const rx = /"playerOfTheMatch"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*?(?:"id"\s*:\s*(\d+))?/i;
    const m = html.match(rx);
    if (m) {
      const potm = { name: m[1], id: m[2] ? Number(m[2]) : null };
      return { data: { general: { playerOfTheMatch: potm } }, html, source: "next_html_regex" };
    }
    throw new Error("NEXT_DATA not found in HTML");
  }
  const obj = safeJSON(nd);
  if (!obj) throw new Error("NEXT_DATA JSON parse failed");

  const scan = deepScanNext(obj);
  const data = scan.data;
  const source = "next_html";
  return { data, html, source };
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

    // Resolve numeric matchId (also returns HTML if we fetched)
    const { matchId, finalUrl, html: maybeHtml } = await resolveMatchIdFromUrl(matchUrl);
    if (!matchId) {
      return { statusCode: 400, headers: { "content-type":"application/json" }, body: JSON.stringify({ error:"Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    // 1) API fast path
    let data = null, htmlUsed = maybeHtml, source = "api";
    try {
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    } catch {
      // 2) HTML fallback with deep scan
      const fb = await nextFallbackJSON(finalUrl, maybeHtml || null);
      data = fb.data; htmlUsed = fb.html; source = fb.source || "next_html";
    }

    // Extract fields
    const leagueId = pickLeagueId(data);
    const league_label = pickLeagueName(data) || null;
    const league_allowed = leagueId != null && TOP5_LEAGUE_IDS.has(Number(leagueId));

    const dt = pickKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt >= SEASON_START && dt <= SEASON_END) : false;

    const ratings = ratingsFromJson(data);
    const maxRating = ratings.length ? Math.max(...ratings.map(r => Number(r.rating || 0))) : null;

    const pidOK = Number.isFinite(playerId);
    const nPlayer = norm(playerName);
    const me = ratings.find(r =>
      (pidOK && Number(r.id) === playerId) || (!!nPlayer && r.name && norm(r.name) === nPlayer)
    ) || null;

    const explicitP = data?.general?.playerOfTheMatch ?? data?.content?.matchFacts?.playerOfTheMatch ?? null;
    const potm = explicitP || (ratings.length ? (() => {
      const rs = [...ratings].sort((a,b)=>Number(b.rating||0) - Number(a.rating||0));
      return rs[0] ? { id: rs[0].id ?? null, name: rs[0].name ?? null, by:"max_rating_fallback", rating: rs[0].rating ?? null } : null;
    })() : null);

    const player_is_pom =
      potm
        ? ((pidOK && Number(potm.id) === playerId) ||
           (!!nPlayer && potm.name && norm(potm.name) === nPlayer))
        : false;

    const has_highest_rating =
      me && maxRating != null ? Number(me.rating || 0) === Number(maxRating) : false;

    const match_title = deriveTitle(data, htmlUsed);

    return {
      statusCode: 200,
      headers: { "content-type":"application/json" },
      body: JSON.stringify({
        match_url: matchUrl,
        resolved_match_id: String(matchId),
        match_title,
        league_id: leagueId ?? null,
        league_label,
        match_datetime_utc,
        league_allowed,
        within_season_2025_26,
        player_is_pom,
        has_highest_rating,
        player_rating: me?.rating ?? null,
        max_rating: maxRating,
        potm_name: potm?.name || potm?.fullName ? { fullName: potm.fullName || potm.name } : (potm || null),
        potm_id: potm?.id ?? null,
        source
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type":"application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
