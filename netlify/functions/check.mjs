// netlify/functions/check.mjs
// Robust POTM + Highest + per-match player stats (Top-5 leagues, 2025–26).
// Keeps permissive __NEXT_DATA__ HTML fallback. Adds player_stats:
//   goals, penalty_goals, non_penalty_goals, assists, yellow_cards, red_cards,
//   minutes_played, full_match_played (>=90).
//
// Also fixes prior null checks ("in" on null) and keeps safe norm().

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

// ---------- Ratings & metadata readers ----------
function coerceRatingRow(p) {
  if (!p || typeof p !== "object") return null;
  const id = p?.id ?? p?.playerId ?? p?.player?.id ?? null;
  const name = p?.name ?? p?.playerName ?? p?.player?.name ?? "";
  let rating = NaN;
  if (p?.rating != null) rating = Number(p.rating);
  else if (p?.stats?.rating != null) rating = Number(p.stats.rating);
  else if (p?.playerRating != null) rating = Number(p.playerRating);
  return (name || id != null) ? { id, name, rating } : null;
}

function ratingsFromJson(json) {
  const out = [];
  const pushArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const row = coerceRatingRow(item);
      if (row) out.push(row);
    }
  };

  // canonical
  pushArr(json?.content?.playerRatings?.home?.players);
  pushArr(json?.content?.playerRatings?.away?.players);

  // common variants
  pushArr(json?.playerRatings?.home?.players);
  pushArr(json?.playerRatings?.away?.players);

  // deep scan for arrays resembling ratings
  const stack = [json];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    for (const [k,v] of Object.entries(node)) {
      if (!v) continue;
      if (Array.isArray(v)) {
        if (v.length && v.some(x => x && typeof x === "object" && (("rating" in x) || ("playerRating" in x) || (x.stats && typeof x.stats==="object" && "rating" in x.stats)))) {
          pushArr(v);
        }
        for (const it of v) if (it && typeof it === "object") stack.push(it);
      } else if (typeof v === "object") {
        stack.push(v);
      }
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
  const stack=[obj];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.playerOfTheMatch && (n.playerOfTheMatch.id != null || n.playerOfTheMatch.name || n.playerOfTheMatch.fullName)) {
      return n.playerOfTheMatch;
    }
    if (n.matchFacts && n.matchFacts.playerOfTheMatch) {
      const p = n.matchFacts.playerOfTheMatch;
      if (p && (p.id != null || p.name || p.fullName)) return p;
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

function deriveTitle(obj, html) {
  const g = obj?.general;
  if (g?.matchName) return g.matchName;
  const ht = g?.homeTeam?.name || obj?.homeTeam?.name || "";
  const at = g?.awayTeam?.name || obj?.awayTeam?.name || "";
  if (ht || at) return `${ht || "?"} vs ${at || "?"}`;
  if (html) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) return m[1].replace(/\s+/g," ").trim();
  }
  return "vs";
}

// ---------- Player minutes (for FMP) ----------
function getPlayerMinutes(root, playerId, playerName) {
  let best = null;
  const nTarget = norm(playerName || "");
  const stack=[root];
  const pickNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    // look in common lineups/ratings nodes
    const maybePlayer =
      (node.id != null || node.playerId != null || node.player?.id != null || node.name || node.playerName || node.player?.name);

    if (maybePlayer) {
      const id = node.id ?? node.playerId ?? node.player?.id ?? null;
      const nm = node.name ?? node.playerName ?? node.player?.name ?? null;

      const idMatch = (playerId != null && Number(id) === Number(playerId));
      const nameMatch = (!!nTarget && nm && norm(nm) === nTarget);

      if (idMatch || nameMatch) {
        const cands = [
          pickNum(node.minutesPlayed),
          pickNum(node.minsPlayed),
          pickNum(node.timeOnPitch),
          pickNum(node.timePlayed),
          pickNum(node.minutes),
          pickNum(node.playedMinutes),
          pickNum(node.stats?.minutesPlayed),
          pickNum(node.stats?.minsPlayed),
        ].filter(v => v != null);

        if (cands.length) {
          const max = Math.max(...cands);
          if (best == null || max > best) best = max;
        }
      }
    }

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") stack.push(v);
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") stack.push(it);
    }
  }
  return best; // may be null
}

// ---------- Events (goals/assists/cards) ----------
function deepCollectEvents(root) {
  const out = [];
  const stack = [root];

  const asId = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
  const str = (v) => (typeof v === "string" ? v : (v?.name || v?.fullName || ""));

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    // Candidate arrays: events, incidents, timeline, goals, cards, comments
    for (const [k,v] of Object.entries(node)) {
      if (!v) continue;

      if (Array.isArray(v) && v.length && v.some(x => x && typeof x === "object")) {
        // Normalize known shapes
        for (const e of v) {
          if (!e || typeof e !== "object") continue;

          // Basic fields
          const typeRaw = (e.type || e.eventType || e.incidentType || e.detailType || e.card || e.cardType || "").toString();
          const subRaw = (e.detail || e.card || e.cardType || e.subType || "").toString();

          const playerId =
            asId(e.playerId) ?? asId(e.player?.id) ?? asId(e.mainPlayerId) ?? asId(e.actorId) ?? null;
          const playerName =
            str(e.player) || str(e.playerName) || str(e.mainPlayer) || str(e.actor) || e.name || null;

          const assistId =
            asId(e.assistId) ?? asId(e.assist?.id) ?? asId(e.secondaryPlayerId) ?? null;
          const assistName =
            str(e.assist) || str(e.secondaryPlayer) || e.assistName || null;

          const isPenalty =
            !!(e.isPenalty || /pen/i.test(typeRaw) || /pen/i.test(subRaw) || /penalty/i.test(e.reason || "") || /penalty/i.test(e.description || ""));

          const ownGoal =
            !!(/own/i.test(typeRaw) || /own/i.test(subRaw) || /own goal/i.test(e.reason || ""));

          const minute =
            e.minute ?? e.time ?? e.clock ? Number(e.minute || e.time || e.clock?.minute) : null;

          // Classify
          let kind = null;
          const tr = typeRaw.toLowerCase();
          const sr = subRaw.toLowerCase();

          if (tr.includes("goal") || sr.includes("goal") || e.goal === true) {
            kind = isPenalty ? "penalty_goal" : (ownGoal ? "own_goal" : "goal");
          } else if (tr.includes("pen") && (tr.includes("scored") || tr.includes("converted"))) {
            kind = "penalty_goal";
          } else if (tr.includes("assist") || sr.includes("assist")) {
            kind = "assist";
          } else if (tr.includes("yellow") || sr.includes("yellow")) {
            kind = sr.includes("second") || tr.includes("second") ? "second_yellow" : "yellow";
          } else if (tr.includes("red") || sr.includes("red")) {
            kind = "red";
          }

          if (kind) {
            out.push({
              kind,
              playerId, playerName,
              assistId, assistName,
              isPenalty, ownGoal,
              minute: Number.isFinite(minute) ? minute : null
            });
          }
        }
      } else if (typeof v === "object") {
        stack.push(v);
      }
    }
  }
  return out;
}

function tallyPlayerStats(root, playerId, playerName) {
  const events = deepCollectEvents(root);
  const targetName = norm(playerName || "");
  let goals = 0, pen = 0, assists = 0, yc = 0, rc = 0;

  for (const e of events) {
    const isMe =
      (playerId != null && Number(e.playerId) === Number(playerId)) ||
      (!!targetName && e.playerName && norm(e.playerName) === targetName);

    // Count goals for *scorer*
    if (isMe && (e.kind === "goal" || e.kind === "penalty_goal")) {
      goals++;
      if (e.kind === "penalty_goal" || e.isPenalty) pen++;
    }

    // Count assists if our player is the assister
    const assistIsMe =
      (playerId != null && Number(e.assistId) === Number(playerId)) ||
      (!!targetName && e.assistName && norm(e.assistName) === targetName);
    if (assistIsMe) assists++;

    // Cards (if issued to our player)
    if (isMe) {
      if (e.kind === "yellow") yc++;
      else if (e.kind === "second_yellow") { yc++; rc++; } // 2nd yellow → YC+1 and RC+1
      else if (e.kind === "red") rc++;
    }
  }

  const npg = goals - pen;
  return { goals, penalty_goals: pen, non_penalty_goals: npg, assists, yellow_cards: yc, red_cards: rc };
}

// ---------- __NEXT_DATA__ fallback ----------
function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(str) { try { return JSON.parse(str); } catch { return null; } }

function deepScanNext(root) {
  // Build best-effort data-like block
  const results = { blocks: [], ratings: [], potm: null, leagueId: null, leagueName: null, kickoff: null };
  const stack=[root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node!=="object") continue;

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

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") stack.push(v);
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") stack.push(it);
    }
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
    // last resort: regex POTM from HTML
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

    // Ratings (for POTM & "highest")
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
      potm
        ? ((pidOK && Number(potm.id) === playerId) ||
           (!!nPlayer && potmNameText && norm(potmNameText) === nPlayer))
        : false;

    const has_highest_rating =
      me && maxRating != null ? Number(me.rating || 0) === Number(maxRating) : false;

    const match_title = deriveTitle(data, htmlUsed);

    // --------- NEW: per-match player stats ---------
    const minutes_played = getPlayerMinutes(data, playerId, playerName);
    const fmp = minutes_played != null ? (Number(minutes_played) >= 90) : false;

    const tallied = tallyPlayerStats(data, playerId, playerName);
    const player_stats = {
      goals: tallied.goals,
      penalty_goals: tallied.penalty_goals,
      non_penalty_goals: tallied.non_penalty_goals,
      assists: tallied.assists,
      yellow_cards: tallied.yellow_cards,
      red_cards: tallied.red_cards,
      minutes_played: minutes_played,
      full_match_played: fmp
    };

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
        potm_name: potm || null,
        potm_name_text: potmNameText,
        potm_id: potm?.id ?? null,
        player_stats,
        source
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type":"application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
