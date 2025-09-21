// netlify/functions/discover.mjs
import fetch from "node-fetch";

const ALLOWED_LEAGUES = [47, 87, 54, 55, 53]; // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date("2025-07-01T00:00:00Z");
const SEASON_END = new Date("2026-06-30T23:59:59Z");

// Helper: safe fetch text
async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`fetch ${url} ${r.status}`);
  return await r.text();
}

// Helper: extract __NEXT_DATA__ JSON
function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Normalize FotMob player URL
function normalizeUrl(u) {
  try {
    const url = new URL(u.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "players") {
      return `https://www.fotmob.com/players/${parts[1]}/${parts[2] || ""}`;
    }
  } catch {}
  return u.trim();
}

// Filter matches to season + allowed leagues
function filterMatches(rawMatches) {
  return rawMatches.filter(m => {
    const leagueId = Number(m.leagueId || m.competitionId || m.tournamentId);
    const dt = new Date(m.utcDate || m.kickoff || m.matchDate || 0);
    if (!leagueId || !dt.getTime()) return false;
    return (
      ALLOWED_LEAGUES.includes(leagueId) &&
      dt >= SEASON_START &&
      dt <= SEASON_END
    );
  });
}

// Collect matches from NEXT_DATA (player or team)
function collectMatchIdsFromNextData(next) {
  const out = [];
  function scan(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.matchId && (obj.leagueId || obj.competitionId || obj.tournamentId)) {
      out.push({
        id: obj.matchId,
        leagueId: obj.leagueId || obj.competitionId || obj.tournamentId,
        utcDate: obj.utcDate || obj.kickoff || obj.matchDate,
      });
    }
    for (const k of Object.keys(obj)) scan(obj[k]);
  }
  scan(next);
  return out;
}

export async function handler(event) {
  const start = Date.now();
  let urls;
  try {
    urls = JSON.parse(event.body).urls || [];
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "invalid body" }) };
  }

  const players = [];
  for (const rawUrl of urls) {
    const url = normalizeUrl(rawUrl);
    const debug = {
      sources: [],
      raw_matches: 0,
      kept_matches: 0,
      dropped_matches: 0,
      errors: [],
    };

    let playerId, playerName, teamId, matchObjs = [];

    try {
      const html = await fetchText(url);
      const next = extractNextData(html);
      if (next) {
        debug.sources.push("player_next");
        // extract basics
        playerId = Number(next?.props?.pageProps?.player?.id) || null;
        playerName = next?.props?.pageProps?.player?.name || null;
        teamId = Number(next?.props?.pageProps?.player?.teamId) || null;
        // collect matches
        const found = collectMatchIdsFromNextData(next);
        debug.raw_matches += found.length;
        matchObjs.push(...found);
      }
    } catch (e) {
      debug.errors.push("player fetch: " + e.message);
    }

    // fallback: team fixtures
    if (teamId) {
      try {
        const teamUrl = `https://www.fotmob.com/teams/${teamId}/fixtures`;
        const html = await fetchText(teamUrl);
        const next = extractNextData(html);
        if (next) {
          debug.sources.push("team_next");
          const found = collectMatchIdsFromNextData(next);
          debug.raw_matches += found.length;
          matchObjs.push(...found);
        }
      } catch (e) {
        debug.errors.push("team fetch: " + e.message);
      }
    }

    // filter → dedupe → build URLs
    const kept = filterMatches(matchObjs);
    debug.kept_matches = kept.length;
    debug.dropped_matches = matchObjs.length - kept.length;

    const matchIds = [...new Set(kept.map(m => m.id))];
    const match_urls = matchIds.map(id => `https://www.fotmob.com/match/${id}`);

    players.push({
      player_url: url,
      player_id: playerId,
      player_name: playerName,
      team_id: teamId,
      match_urls,
      debug,
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      players,
      meta: { ms: Date.now() - start },
    }),
  };
}
