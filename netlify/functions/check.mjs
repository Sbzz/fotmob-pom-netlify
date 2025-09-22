// netlify/functions/check.mjs
import fetch from "node-fetch";

/*
Check:
- resolve numeric matchId from matchUrl
- try API fast path: https://www.fotmob.com/api/matchDetails?matchId=ID
- fallback to HTML NEXT_DATA scanning
- defensive JSON.parse and returns consistent structure:
  {
    ok: true,
    match_url, resolved_match_id, match_title, league_id, league_label,
    match_datetime_utc, league_allowed, within_season_2025_26,
    player_is_pom, player_rating, max_rating, potm:object,
    stats: { goals, penalty_goals, assists, yellow_cards, red_cards, full_match_played, minutes_played }
  }
*/

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]);
const SEASON_START = new Date(Date.UTC(2025,6,1,0,0,0));
const SEASON_END   = new Date(Date.UTC(2026,5,30,23,59,59));

async function fetchJSON(url, retry = 1) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200) || ""}`);
      try { return JSON.parse(txt); } catch { throw new Error("json parse failed"); }
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 200 + 200 * i));
    }
  }
  throw last || new Error("fetch failed");
}

async function fetchText(url, retry = 1) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return { finalUrl: res.url || url, html: txt };
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 200 + 200 * i));
    }
  }
  throw last || new Error("fetch failed");
}

function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

// deep scan helpers (safe and defensive)
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
      if (/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc|matchtime)$/.test(kk) && typeof v === "string") {
        const d = new Date(v); if (!isNaN(d)) return d;
      }
      if (/^(epoch|timestamp|kickoff|matchtime)$/.test(kk) && Number.isFinite(Number(v))) {
        const ts = Number(v); const d = new Date(ts > 1e12 ? ts : ts*1000); if (!isNaN(d)) return d;
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function ratingsFromJson(json) {
  const out = [];
  function coerce(p) {
    if (!p || typeof p !== "object") return null;
    const id = p?.id ?? p?.playerId ?? p?.player?.id ?? null;
    const name = p?.name ?? p?.playerName ?? p?.player?.name ?? "";
    let rating = NaN;
    if (p?.rating != null) rating = Number(p.rating);
    else if (p?.stats?.rating != null) rating = Number(p.stats.rating);
    else if (p?.playerRating != null) rating = Number(p.playerRating);
    return (name || id != null) ? { id, name, rating } : null;
  }
  const pushArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      const r = coerce(it);
      if (r) out.push(r);
    }
  };
  pushArr(json?.content?.playerRatings?.home?.players);
  pushArr(json?.content?.playerRatings?.away?.players);
  pushArr(json?.playerRatings?.home?.players);
  pushArr(json?.playerRatings?.away?.players);

  // deep scan arrays that look like ratings
  const stack = [json];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    for (const v of Object.values(node)) {
      if (!v) continue;
      if (Array.isArray(v)) {
        if (v.length && v.some(x => x && typeof x === "object" && (("rating" in x) || ("playerRating" in x) || (x.stats && typeof x.stats==="object" && "rating" in x.stats)))) {
          pushArr(v);
        }
        for (const it of v) if (it && typeof it === "object") stack.push(it);
      } else if (typeof v === "object") stack.push(v);
    }
  }
  return out;
}

function explicitPOTM(obj) {
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

function findPlayerNode(json, playerId, playerName) {
  // scan for an object describing this player (lots of shapes)
  const stack=[json];
  const strName = (playerName || "").toLowerCase();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    // candidate keys
    if ((node.playerId && String(node.playerId).startsWith(String(playerId))) ||
        (node.id && String(node.id).startsWith(String(playerId))) ||
        (node.player && node.player.id && String(node.player.id).startsWith(String(playerId)))) {
      return node;
    }
    // match by name
    if (strName && (String(node.name || node.fullName || node.playerName || "").toLowerCase() === strName)) {
      return node;
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

function extractStatFromNode(node) {
  if (!node || typeof node !== "object") return null;
  const stats = {
    goals: Number(node.goals ?? node.goalsScored ?? node.totalGoals ?? 0),
    penalty_goals: Number(node.penaltyGoals ?? node.penalty_goals ?? 0),
    assists: Number(node.assists ?? node.assist ?? 0),
    yellow_cards: Number(node.yellowCards ?? node.yellow_cards ?? 0),
    red_cards: Number(node.redCards ?? node.red_cards ?? 0),
    minutes_played: Number(node.minutesPlayed ?? node.playedMinutes ?? node.minutes ?? 0)
  };
  stats.full_match_played = Number(stats.minutes_played) >= 90;
  return stats;
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); } catch { payload = {}; }
    } else {
      payload = {
        playerId: Number(event.queryStringParameters?.playerId || NaN),
        playerName: event.queryStringParameters?.playerName || "",
        matchUrl: event.queryStringParameters?.matchUrl || ""
      };
    }

    const matchUrl = String(payload.matchUrl || payload.match_url || "").trim();
    const playerId = payload.playerId || payload.player_id || payload.player || null;
    const playerName = payload.playerName || payload.player_name || "";

    if (!matchUrl || !playerId) {
      return { statusCode: 400, headers: { "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide matchUrl and playerId" }) };
    }

    // resolve numeric matchId
    let matchId = null;
    try {
      const u = new URL(matchUrl);
      const mm = u.pathname.match(/\/match\/(\d{5,12})/);
      if (mm) matchId = mm[1];
    } catch { /* continue */ }

    if (!matchId) {
      // try fetching page to find id
      try {
        const { finalUrl, html } = await fetchText(matchUrl, 1);
        const mm = finalUrl.match(/\/match\/(\d{5,12})/);
        if (mm) matchId = mm[1];
        const m2 = html.match(/"matchId"\s*:\s*(\d{5,12})/);
        if (!matchId && m2) matchId = m2[1];
      } catch (e) {
        // can't resolve
      }
    }

    if (!matchId) {
      return { statusCode: 400, headers: { "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Could not resolve matchId from matchUrl", matchUrl }) };
    }

    // 1) API fast path
    let data = null;
    let source = "api";
    try {
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`, 1);
    } catch (e) {
      // fallback to HTML NEXT_DATA scan
      try {
        const { html } = await fetchText(matchUrl, 1);
        const nd = extractNextDataString(html);
        const obj = nd ? safeJSON(nd) : null;
        if (obj) {
          data = obj;
          source = "next_html";
        } else {
          // try regex fallback for potm only
          data = { _raw_html: html };
          source = "html_only";
        }
      } catch (err) {
        // final failure
        return { statusCode: 500, headers: { "content-type":"application/json" }, body: JSON.stringify({ ok:false, error: `Failed to fetch match details: ${String(err)}` }) };
      }
    }

    // Now produce outputs by scanning data
    // Pick league id/name/kickoff if available
    const league_id = pickLeagueId(data);
    const league_label = pickLeagueName(data) || null;
    const kickoff = pickKickoff(data);
    const match_datetime_utc = kickoff ? kickoff.toISOString() : null;
    const league_allowed = league_id != null ? TOP5_LEAGUE_IDS.has(Number(league_id)) : null;
    const within_season_2025_26 = kickoff ? (kickoff >= SEASON_START && kickoff <= SEASON_END) : null;

    // ratings & potm
    const ratings = ratingsFromJson(data || {});
    const maxRating = ratings.length ? Math.max(...ratings.map(r => Number(r.rating || 0))) : null;
    const meNode = findPlayerNode(data, playerId, playerName);
    const player_rating = meNode ? (meNode.rating ?? meNode.playerRating ?? (meNode.stats && meNode.stats.rating) ?? null) : null;

    const explicitP = explicitPOTM(data);
    // fall back to highest rating if explicit missing
    let potm = explicitP || (ratings.length ? (() => {
      const rs = [...ratings].sort((a,b)=>Number(b.rating||0) - Number(a.rating||0));
      return rs[0] ? { id: rs[0].id ?? null, name: rs[0].name ?? null, rating: rs[0].rating ?? null, by: "max_rating_fallback" } : null;
    })() : null);

    const potmNameText = potm ? (potm.fullName || potm.name || "") : "";

    const player_is_pom = potm
      ? ((Number(potm.id) && Number(potm.id) === Number(playerId)) || (potmNameText && String(potmNameText).toLowerCase() === String(playerName).toLowerCase()))
      : false;

    // stats extraction: try to find player node and extract stats
    let stats = { goals:0, penalty_goals:0, assists:0, yellow_cards:0, red_cards:0, full_match_played:false, minutes_played:0 };
    if (meNode) {
      const extracted = extractStatFromNode(meNode);
      if (extracted) {
        stats.goals = extracted.goals;
        stats.penalty_goals = extracted.penalty_goals;
        stats.assists = extracted.assists;
        stats.yellow_cards = extracted.yellow_cards;
        stats.red_cards = extracted.red_cards;
        stats.minutes_played = extracted.minutes_played;
        stats.full_match_played = extracted.full_match_played;
      }
    } else {
      // try to find in common arrays: lineups / players
      const consolidated = [].concat(
        data?.content?.lineups?.home?.players || [],
        data?.content?.lineups?.away?.players || [],
        data?.home?.players || [],
        data?.away?.players || []
      );
      const found = consolidated.find(p => (p?.id && String(p.id).startsWith(String(playerId))) || (p?.playerId && String(p.playerId).startsWith(String(playerId))));
      if (found) {
        const extracted = extractStatFromNode(found);
        if (extracted) {
          stats.goals = extracted.goals;
          stats.penalty_goals = extracted.penalty_goals;
          stats.assists = extracted.assists;
          stats.yellow_cards = extracted.yellow_cards;
          stats.red_cards = extracted.red_cards;
          stats.minutes_played = extracted.minutes_played;
          stats.full_match_played = extracted.full_match_played;
        }
      }
    }

    return {
      statusCode: 200,
      headers: { "content-type":"application/json" },
      body: JSON.stringify({
        ok: true,
        match_url: matchUrl,
        resolved_match_id: String(matchId),
        match_title: (data?.content?.general?.matchName) || (data?.general?.matchName) || null,
        league_id: league_id ?? null,
        league_label,
        match_datetime_utc,
        league_allowed,
        within_season_2025_26,
        player_is_pom,
        player_rating: player_rating ?? null,
        max_rating: maxRating ?? null,
        potm: potm ?? null,
        source,
        stats
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:String(e) }) };
  }
}
