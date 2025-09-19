// netlify/functions/check.mjs
// POTM (unchanged) + FIXED stats (Goals/NPG/PG/Assists/YC/RC/FMP) for Top-5, 2025–26.
// Strategy:
//  1) Try player's own box-score row (playerRatings) for minutes/goals/assists/cards.
//  2) Else parse ONLY matchFacts.{goals,cards/bookings,events} (strict) to avoid duplicates.
//  3) FMP from minutes >= 90; if minutes missing, infer from lineups (started & not subbed off < 90).

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
    } catch (e) { lastErr = e; await sleep(200 + 300*i); }
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
    } catch (e) { lastErr = e; await sleep(200 + 300*i); }
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

// ---------- helpers: walk & pick ----------
function* walkObjects(root){
  const stack=[root]; const seen=new Set();
  while(stack.length){
    const n=stack.pop();
    if(!n || typeof n!=="object") continue;
    if(seen.has(n)) continue; seen.add(n);
    yield n;
    for(const v of Object.values(n)){
      if(v && typeof v==="object") stack.push(v);
      if(Array.isArray(v)) for(const it of v) if(it && typeof it==="object") stack.push(it);
    }
  }
}
const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const asStr = (v) => (typeof v === "string" ? v : (v?.name || v?.fullName || null));

function findMatchFactsNode(data){
  // Prefer content.matchFacts; else first object that "looks like" matchFacts.
  if (data?.content?.matchFacts) return data.content.matchFacts;
  if (data?.matchFacts) return data.matchFacts;
  for(const n of walkObjects(data)){
    if (n && typeof n==="object" && (n.goals || n.cards || n.bookings || n.events || n.incidents)) return n;
  }
  return null;
}
function getFirstArrayByKeyRegex(root, rx){
  for (const n of walkObjects(root)){
    for (const [k,v] of Object.entries(n)){
      if (rx.test(String(k)) && Array.isArray(v) && v.length && typeof v[0]==="object") return v;
    }
  }
  return null;
}

function parseMinuteStr(s){
  if (s == null) return null;
  if (typeof s === "number") return s;
  const m = String(s).match(/^(\d+)(?:\+(\d+))?/);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
}

// ---------- ratings row ----------
function coerceRatingRow(p) {
  if (!p || typeof p !== "object") return null;
  const id = p?.id ?? p?.playerId ?? p?.player?.id ?? null;
  const name = p?.name ?? p?.playerName ?? p?.player?.name ?? "";
  let rating = NaN;
  if (p?.rating != null) rating = Number(p.rating);
  else if (p?.stats?.rating != null) rating = Number(p.stats.rating);
  else if (p?.playerRating != null) rating = Number(p.playerRating);
  return (name || id != null) ? { id, name, rating, raw: p } : null;
}
function ratingsFromJson(json) {
  const out = [];
  const pushArr = (arr) => { if (!Array.isArray(arr)) return; for (const item of arr) { const row = coerceRatingRow(item); if (row) out.push(row); } };
  pushArr(json?.content?.playerRatings?.home?.players);
  pushArr(json?.content?.playerRatings?.away?.players);
  pushArr(json?.playerRatings?.home?.players);
  pushArr(json?.playerRatings?.away?.players);
  // minimal deep fallback
  for(const n of walkObjects(json)){
    for (const [k,v] of Object.entries(n)){
      if (Array.isArray(v) && v.length && v.some(x => x && typeof x === "object" && ("rating" in x || "playerRating" in x || (x.stats && typeof x.stats==="object" && "rating" in x.stats)))) {
        pushArr(v);
      }
    }
  }
  return out;
}

// ---------- metadata pickers ----------
function pickLeagueId(obj) {
  for (const n of walkObjects(obj)) {
    for (const [k,v] of Object.entries(n)) {
      const kk = String(k).toLowerCase();
      if (/(leagueid|tournamentid|competitionid)$/.test(kk)) { const num = Number(v); if (Number.isFinite(num)) return num; }
    }
  }
  return null;
}
function pickLeagueName(obj) {
  for (const n of walkObjects(obj)) {
    for (const [k,v] of Object.entries(n)) {
      const kk = String(k).toLowerCase();
      if (/(leaguename|tournamentname|competitionname)$/.test(kk) && typeof v === "string") return v;
    }
  }
  return null;
}
function pickKickoff(obj) {
  for (const n of walkObjects(obj)) {
    for (const [k,v] of Object.entries(n)) {
      const kk = String(k).toLowerCase();
      if (/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc)$/.test(kk) && typeof v === "string") {
        const d = new Date(v); if (!isNaN(d)) return d;
      }
      if (/^(matchtime|kickoff|epoch|timestamp)$/.test(kk) && Number.isFinite(Number(v))) {
        const ts = Number(v); const d = new Date(ts > 1e12 ? ts : ts*1000); if (!isNaN(d)) return d;
      }
    }
  }
  return null;
}

function explicitPOTM(obj) {
  for (const n of walkObjects(obj)) {
    if (n.playerOfTheMatch && (n.playerOfTheMatch.id != null || n.playerOfTheMatch.name || n.playerOfTheMatch.fullName)) return n.playerOfTheMatch;
    if (n.matchFacts && n.matchFacts.playerOfTheMatch) {
      const p = n.matchFacts.playerOfTheMatch;
      if (p && (p.id != null || p.name || p.fullName)) return p;
    }
  }
  return null;
}
function deriveTitle(obj, html) {
  const g = obj?.general;
  if (g?.matchName) return g.matchName;
  const ht = g?.homeTeam?.name || obj?.homeTeam?.name || "";
  const at = g?.awayTeam?.name || obj?.awayTeam?.name || "";
  if (ht || at) return `${ht || "?"} vs ${at || "?"}`;
  if (html) { const m = html.match(/<title>([^<]+)<\/title>/i); if (m) return m[1].replace(/\s+/g," ").trim(); }
  return "vs";
}

// ---------- STRICT stats from matchFacts ----------
function extractGoalsStrict(mf){
  // Prefer a dedicated "goals" array; otherwise filter "events/incidents" to only goal events.
  const goalsArr =
    getFirstArrayByKeyRegex(mf, /^goals?$/i) ||
    getFirstArrayByKeyRegex(mf, /^scorers?$/i);
  const eventsArr =
    getFirstArrayByKeyRegex(mf, /^(events|incidents|timeline)$/i);

  const out = [];

  const addGoal = (e) => {
    const scorerId = asNum(e?.scorer?.id) ?? asNum(e?.playerId) ?? asNum(e?.mainPlayerId) ?? asNum(e?.player?.id) ?? asNum(e?.goalScorer?.id);
    const scorerName = asStr(e?.scorer) || asStr(e?.player) || asStr(e?.playerName) || asStr(e?.mainPlayer) || asStr(e?.goalScorer);
    const assistId = asNum(e?.assist?.id) ?? asNum(e?.assistId) ?? asNum(e?.assist1?.id);
    const assistName = asStr(e?.assist) || asStr(e?.assistName) || asStr(e?.assist1);
    const typeRaw = String(e?.type || e?.eventType || e?.goalType || "").toLowerCase();
    const detailRaw = String(e?.detail || e?.reason || e?.description || "").toLowerCase();
    const penalty = !!(e?.isPenalty || typeRaw.includes("pen") || detailRaw.includes("penalty"));
    const own = !!(typeRaw.includes("own") || detailRaw.includes("own goal"));
    out.push({ scorerId, scorerName, assistId, assistName, penalty, own });
  };

  if (Array.isArray(goalsArr)) {
    for (const e of goalsArr) if (e && typeof e==="object") addGoal(e);
    return out;
  }

  if (Array.isArray(eventsArr)) {
    for (const e of eventsArr) {
      if (!e || typeof e!=="object") continue;
      const t = String(e.type || e.eventType || "").toLowerCase();
      if (!(t.includes("goal") || e.goal === true || e.scorer || e.goalScorer)) continue;
      addGoal(e);
    }
  }

  return out;
}

function extractCardsStrict(mf){
  // Prefer "cards" or "bookings"; fallback: filter "events/incidents"
  const cardsArr =
    getFirstArrayByKeyRegex(mf, /^cards|bookings$/i) ||
    getFirstArrayByKeyRegex(mf, /^bookings$/i);
  const eventsArr =
    getFirstArrayByKeyRegex(mf, /^(events|incidents|timeline)$/i);

  const out = [];
  const addCard = (e, kind) => {
    const playerId = asNum(e?.playerId) ?? asNum(e?.player?.id) ?? asNum(e?.mainPlayerId);
    const playerName = asStr(e?.player) || asStr(e?.playerName) || asStr(e?.mainPlayer);
    out.push({ playerId, playerName, kind });
  };

  if (Array.isArray(cardsArr)) {
    for (const e of cardsArr) {
      if (!e || typeof e!=="object") continue;
      const t = String(e.card || e.cardType || e.type || "").toLowerCase();
      if (t.includes("yellow")) addCard(e, t.includes("second") ? "second_yellow" : "yellow");
      else if (t.includes("red")) addCard(e, "red");
    }
    return out;
  }

  if (Array.isArray(eventsArr)) {
    for (const e of eventsArr) {
      if (!e || typeof e!=="object") continue;
      const t = String(e.card || e.cardType || e.type || e.eventType || "").toLowerCase();
      if (t.includes("yellow")) addCard(e, t.includes("second") ? "second_yellow" : "yellow");
      else if (t.includes("red")) addCard(e, "red");
    }
  }

  return out;
}

// ---------- minutes / FMP ----------
function minutesFromRatingsRow(row){
  const n = asNum(row?.minutesPlayed) ?? asNum(row?.minsPlayed) ??
            asNum(row?.playedMinutes) ?? asNum(row?.timeOnPitch) ??
            asNum(row?.timePlayed) ?? asNum(row?.stats?.minutesPlayed) ??
            asNum(row?.stats?.minsPlayed) ?? asNum(row?.performance?.minutesPlayed);
  return n;
}
function inferFMPFromLineups(root, playerId, playerName){
  // Started? subbed out? subbed in? We only need FMP=true if started and (no sub off before 90).
  let started = false, subOutMin = null, subInMin = null;

  for (const n of walkObjects(root)) {
    const id = asNum(n?.id ?? n?.playerId ?? n?.player?.id);
    const nm = asStr(n?.name ?? n?.playerName ?? n?.player);
    const isMe = (playerId!=null && id===playerId) || (!!playerName && nm && norm(nm)===norm(playerName));
    if (!isMe) continue;

    // flags
    if (n?.isStarting === true) started = true;
    if (n?.isSubstitute === false) started = true;
    if (n?.starter === true) started = true;

    // in/out minutes
    const in1  = parseMinuteStr(n?.subbedInExpandedTime)  ?? asNum(n?.subbedIn)  ?? asNum(n?.subOn);
    const out1 = parseMinuteStr(n?.subbedOutExpandedTime) ?? asNum(n?.subbedOut) ?? asNum(n?.subOff);
    if (in1 != null)  subInMin  = (subInMin==null  || in1 < subInMin)  ? in1  : subInMin;
    if (out1 != null) subOutMin = (subOutMin==null || out1 > subOutMin) ? out1 : subOutMin;
  }

  if (!started) return null;           // can't assert FMP from lineups alone
  if (subOutMin == null) return true;  // started and never subbed off → FMP
  return subOutMin >= 90;              // started but subbed off late enough
}

// ---------- __NEXT_DATA__ fallback ----------
function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(str) { try { return JSON.parse(str); } catch { return null; } }
function deepScanNext(root) {
  const results = { blocks: [], ratings: [], potm: null, leagueId: null, leagueName: null, kickoff: null };
  for (const node of walkObjects(root)) {
    if (results.leagueId == null) { const lid = pickLeagueId(node); if (lid != null) results.leagueId = lid; }
    if (!results.leagueName) { const ln = pickLeagueName(node); if (ln) results.leagueName = ln; }
    if (!results.kickoff) { const ko = pickKickoff(node); if (ko) results.kickoff = ko; }
    if (!results.potm) {
      const p = explicitPOTM(node);
      if (p) results.potm = p;
    }
    const looksLike =
      (node.general && (node.content?.playerRatings || node.content?.matchFacts || node.content?.lineups)) ||
      (node.content && (node.content.playerRatings || node.content.matchFacts));
    if (looksLike) results.blocks.push(node);
    const rs = ratingsFromJson(node);
    if (rs.length) results.ratings = rs;
  }
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
  return { data: block };
}
async function nextFallbackJSON(matchUrl, knownHtml) {
  const { html } = knownHtml ? { finalUrl: matchUrl, html: knownHtml } : await fetchText(matchUrl);
  const nd = extractNextDataString(html);
  if (!nd) {
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
  return { data: scan.data, html, source: "next_html" };
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

    // fast path
    let data = null, htmlUsed = maybeHtml, source = "api";
    try {
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    } catch {
      const fb = await nextFallbackJSON(finalUrl, maybeHtml || null);
      data = fb.data; htmlUsed = fb.html; source = fb.source || "next_html";
    }

    // league/time gates
    const leagueId = pickLeagueId(data);
    const league_label = pickLeagueName(data) || null;
    const league_allowed = leagueId != null && TOP5_LEAGUE_IDS.has(Number(leagueId));
    const dt = pickKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt >= SEASON_START && dt <= SEASON_END) : false;

    // ratings + POTM (unchanged logic)
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
      return rs[0] ? { id: rs[0].id ?? null, name: rs[0].name ?? null, fullName: rs[0].fullName ?? null, by:"max_rating_fallback", rating: rs[0].rating ?? null } : null;
    })() : null);
    const potmNameText = potm ? (potm.fullName || potm.name || "") : "";
    const player_is_pom =
      potm ? ((pidOK && Number(potm.id) === playerId) || (!!nPlayer && potmNameText && norm(potmNameText) === nPlayer)) : false;

    const match_title = deriveTitle(data, htmlUsed);

    // ---------- player stats ----------
    // 1) Try ratings row first
    let goals=null, penGoals=null, assists=null, yc=null, rc=null, minutes=null;

    if (me && me.raw) {
      const r = me.raw;
      const firstNum = (paths) => {
        for (const p of paths){
          let cur=r;
          for(const k of p.split(".")){
            if(!cur || typeof cur!=="object"){ cur=null; break; }
            cur = cur[k];
          }
          const n = asNum(cur);
          if (n!=null) return n;
        }
        return null;
      };
      goals    = firstNum(["goals","stats.goals","offensive.goals","summary.goals"]);
      penGoals = firstNum(["penaltyGoals","stats.penaltyGoals","penalties.scored","penaltiesGoals","stats.penaltiesScored","stats.penaltyScored"]);
      assists  = firstNum(["assists","stats.assists","offensive.assists","summary.assists"]);
      const rcStraight = firstNum(["redCards","stats.redCards","cards.red","discipline.red","summary.redCards"]) || 0;
      const rc2nd      = firstNum(["secondYellow","stats.secondYellow","cards.secondYellow","discipline.secondYellow","summary.secondYellow"]) || 0;
      rc       = (rcStraight || 0) + (rc2nd || 0);
      yc       = firstNum(["yellowCards","stats.yellowCards","cards.yellow","discipline.yellow","summary.yellowCards"]);
      minutes  = minutesFromRatingsRow(r);
    }

    // 2) Strict matchFacts fallback for anything missing
    const mf = findMatchFactsNode(data);
    if (mf) {
      if (goals==null || penGoals==null || assists==null) {
        const goalsList = extractGoalsStrict(mf);
        const isMe = (id, nm) =>
          (pidOK && id!=null && Number(id)===playerId) ||
          (!!nPlayer && nm && norm(nm)===nPlayer);
        let g=0, pg=0, ast=0;
        for (const e of goalsList) {
          if (e.own) continue; // never count own goals
          if (isMe(e.scorerId, e.scorerName)) { g++; if (e.penalty) pg++; }
          if (isMe(e.assistId, e.assistName)) { ast++; }
        }
        if (goals   == null) goals    = g;
        if (penGoals== null) penGoals = pg;
        if (assists == null) assists  = ast;
      }
      if (yc==null || rc==null) {
        const cards = extractCardsStrict(mf);
        const isMe = (id, nm) =>
          (pidOK && id!=null && Number(id)===playerId) ||
          (!!nPlayer && nm && norm(nm)===nPlayer);
        let y=0, r=0;
        for (const c of cards) {
          if (!isMe(c.playerId, c.playerName)) continue;
          if (c.kind==="yellow") y++;
          else if (c.kind==="second_yellow") { y++; r++; }
          else if (c.kind==="red") r++;
        }
        if (yc==null) yc = y;
        if (rc==null) rc = r;
      }
    }

    // 3) Minutes/FMP finalization
    if (minutes==null) {
      const f = inferFMPFromLineups(data, playerId, playerName);
      if (f != null) {
        // If we inferred FMP but no minutes, set minutes to 90 for downstream ">=90" logic.
        minutes = f ? 90 : null;
      }
      if (minutes==null) {
        // last resort: any numeric minutes across player objects
        for (const n of walkObjects(data)){
          const id = asNum(n?.id ?? n?.playerId ?? n?.player?.id);
          const nm = asStr(n?.name ?? n?.playerName ?? n?.player);
          const isMe = (pidOK && id===playerId) || (!!playerName && nm && norm(nm)===norm(playerName));
          if (!isMe) continue;
          const cand = minutesFromRatingsRow(n) ?? asNum(n?.minutes) ?? asNum(n?.timeOnPitch) ?? asNum(n?.timePlayed);
          if (cand != null) { minutes = cand; break; }
        }
      }
    }
    const full_match_played = minutes != null ? (Number(minutes) >= 90) : false;

    // compute non-penalty goals
    const nonPenGoals = Number(goals || 0) - Number(penGoals || 0);

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
        // rating fields preserved (UI no longer shows "Highest")
        player_rating: me?.rating ?? null,
        max_rating: ratings.length ? Math.max(...ratings.map(r => Number(r.rating||0))) : null,

        potm_name: potm || null,
        potm_name_text: potmNameText,
        potm_id: potm?.id ?? null,

        player_stats: {
          goals: Number(goals||0),
          penalty_goals: Number(penGoals||0),
          non_penalty_goals: Number(nonPenGoals||0),
          assists: Number(assists||0),
          yellow_cards: Number(yc||0),
          red_cards: Number(rc||0),
          minutes_played: minutes==null?null:Number(minutes),
          full_match_played
        },
        source: data?.content ? "api" : "next_html"
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type":"application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
