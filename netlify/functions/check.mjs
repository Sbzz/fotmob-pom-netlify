// netlify/functions/check.mjs
import fetch from "node-fetch";

const POINTS = {
  npg: 20, // Non-penalty goal
  pg: 15,  // Penalty goal
  assist: 10,
  fm: 5,   // 90 minutes played
  motm: 5, // FotMob POTM
  yc: -3,  // Yellow card
};

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`fetch ${url} ${r.status}`);
  return await r.json();
}

function calcPoints(stats) {
  return (
    (stats.npg || 0) * POINTS.npg +
    (stats.pg || 0) * POINTS.pg +
    (stats.assist || 0) * POINTS.assist +
    (stats.fm || 0) * POINTS.fm +
    (stats.motm || 0) * POINTS.motm +
    (stats.yc || 0) * POINTS.yc
  );
}

export async function handler(event) {
  const start = Date.now();
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "invalid body" }) };
  }

  const { player_id, match_urls } = body;
  if (!player_id || !Array.isArray(match_urls)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "missing player_id or match_urls" }) };
  }

  const matches = [];
  const debug = { attempted: match_urls.length, processed: 0, errors: [], skipped: [] };

  for (const url of match_urls) {
    const idMatch = url.match(/\/match\/(\d+)/);
    if (!idMatch) {
      debug.skipped.push({ url, reason: "invalid url" });
      continue;
    }
    const matchId = idMatch[1];

    try {
      const data = await fetchJson(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);

      // find player stats
      const playerStat = findPlayerStats(data, player_id);
      if (!playerStat) {
        debug.skipped.push({ matchId, reason: "player not in lineup" });
        continue;
      }

      // parse key stats
      const stats = extractStats(playerStat, data, player_id);
      const points = calcPoints(stats);

      matches.push({ matchId, stats, points });
      debug.processed++;
    } catch (e) {
      debug.errors.push({ matchId, msg: e.message });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      player_id,
      matches,
      total_points: matches.reduce((a, m) => a + m.points, 0),
      meta: { ms: Date.now() - start, ...debug },
    }),
  };
}

/**
 * Find the stats object for a given player in matchDetails JSON
 */
function findPlayerStats(data, playerId) {
  const all = [];
  function scan(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.playerId && Number(obj.playerId) === Number(playerId)) {
      all.push(obj);
    }
    for (const k of Object.keys(obj)) scan(obj[k]);
  }
  scan(data);
  return all[0] || null;
}

/**
 * Extract stats we care about
 */
function extractStats(p, data, playerId) {
  const stats = {
    npg: 0,
    pg: 0,
    assist: 0,
    fm: 0,
    motm: 0,
    yc: 0,
  };

  // goals
  if (p.goals != null) {
    stats.npg = Number(p.goals) - Number(p.penaltyGoals || 0);
    stats.pg = Number(p.penaltyGoals || 0);
  }

  // assists
  if (p.assists != null) stats.assist = Number(p.assists);

  // minutes played (full match = 90)
  if (Number(p.minutesPlayed) >= 90) stats.fm = 1;

  // yellow card
  if (p.yellowCards != null && Number(p.yellowCards) > 0) stats.yc = Number(p.yellowCards);

  // FotMob POTM check
  const potm = data?.content?.playerOfTheMatch?.playerId;
  if (Number(potm) === Number(playerId)) stats.motm = 1;

  return stats;
}
