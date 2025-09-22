// netlify/functions/check.mjs
// Check match stats for a player: POTM, rating, goals, assists, cards, FMP.
// Fixed: safeJson helper + retry safeguard. Clean syntax.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]);
const SEASON_START = new Date(Date.UTC(2025, 6, 1));
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_JSON = { accept: "application/json", "user-agent": UA };
const HDRS_HTML = { accept: "text/html", "user-agent": UA };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeJson(res) {
  const txt = await res.text();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function fetchJSON(url, retry = 1) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_JSON });
      const json = await safeJson(res);
      if (!json) throw new Error("empty JSON");
      return json;
    } catch (e) {
      last = e;
      await sleep(200 + 300 * i);
    }
  }
  throw last || new Error("fetchJSON failed");
}

async function fetchText(url, retry = 1) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS_HTML });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { html: txt, finalUrl: res.url || url };
    } catch (e) {
      last = e;
      await sleep(200 + 300 * i);
    }
  }
  throw last || new Error("fetchText failed");
}

function norm(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function extractMatchId(path) {
  const m = path.match(/\/match\/(\d{5,10})/);
  return m ? m[1] : null;
}

function extractNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractStats(obj, pid, pname) {
  const stats = { goals: 0, penalty_goals: 0, assists: 0, yellow_cards: 0, red_cards: 0, full_match_played: false };
  const stack = [obj];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;

    if (n.id == pid || (pname && norm(n.name || "") === norm(pname))) {
      if (Number(n.goals)) stats.goals = Number(n.goals);
      if (Number(n.penaltyGoals)) stats.penalty_goals = Number(n.penaltyGoals);
      if (Number(n.assists)) stats.assists = Number(n.assists);
      if (Number(n.yellowCards)) stats.yellow_cards = Number(n.yellowCards);
      if (Number(n.redCards)) stats.red_cards = Number(n.redCards);
      if (Number(n.minutesPlayed) >= 90) stats.full_match_played = true;
    }

    for (const v of Object.values(n)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return stats;
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try {
        payload = JSON.parse(event.body || "{}");
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
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
      return { statusCode: 400, body: JSON.stringify({ error: "Need playerId/playerName + matchUrl" }) };
    }

    const { html, finalUrl } = await fetchText(matchUrl);
    const matchId = extractMatchId(new URL(finalUrl).pathname);
    if (!matchId) {
      return { statusCode: 400, body: JSON.stringify({ error: "No matchId" }) };
    }

    let data = null;
    try {
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    } catch {
      data = extractNextData(html);
    }
    if (!data) {
      return { statusCode: 500, body: JSON.stringify({ error: "No data" }) };
    }

    const leagueId = Number(
      data?.general?.leagueId ||
      data?.general?.tournamentId ||
      data?.general?.competitionId ||
      NaN
    );
    const league_label = data?.general?.leagueName || null;
    const league_allowed = TOP5_LEAGUE_IDS.has(leagueId);

    const dt = new Date(data?.general?.matchTimeUTC || data?.general?.startTimeUTC || 0);
    const match_datetime_utc = dt.toISOString?.() || null;
    const within = dt >= SEASON_START && dt <= SEASON_END;

    const stats = extractStats(data, playerId, playerName);

    const potm = data?.general?.playerOfTheMatch;
    const player_is_pom = !!(
      potm &&
      (Number(potm.id) === playerId || norm(potm.name || "") === norm(playerName))
    );

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match_url: matchUrl,
        resolved_match_id: matchId,
        match_title: data?.general?.matchName || "vs",
        league_id: leagueId,
        league_label,
        match_datetime_utc,
        league_allowed,
        within_season_2025_26: within,
        player_is_pom,
        player_rating: null,
        ...stats
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
}
