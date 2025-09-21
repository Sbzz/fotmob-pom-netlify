// netlify/functions/discover.mjs
import fetch from "node-fetch";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const urls = body.urls || [];
    const maxMatches = Number(body.maxMatches || 0);

    const players = [];
    for (const url of urls) {
      const normUrl = normalizeUrl(url);
      const playerId = extractPlayerId(normUrl);

      const result = await discoverForPlayer(normUrl, playerId, maxMatches);
      players.push(result);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, players }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(e) }),
    };
  }
};

// -------------------- helpers --------------------

function normalizeUrl(url) {
  let u = url.trim();
  u = u.replace(/\/(en|es|fr|de|it|pt|[a-z]{2}-[A-Z]{2})\//, "/"); // strip locale
  u = u.replace(/[?#].*$/, ""); // strip queries/hash
  u = u.replace(/\/$/, ""); // strip trailing slash
  return u;
}

function extractPlayerId(url) {
  const m = url.match(/\/players\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function discoverForPlayer(playerUrl, playerId, maxMatches) {
  const seasonStart = new Date("2025-07-01T00:00:00Z").getTime();
  const seasonEnd = new Date("2026-06-30T23:59:59Z").getTime();
  const allowedLeagues = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1

  const debug = { used: [], player_page: {}, team_pages: {} };
  let matchUrls = [];

  // --- step 1: player __NEXT_DATA__ ---
  try {
    const res = await fetch(playerUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    const text = await res.text();
    const m = text.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (m) {
      const json = JSON.parse(m[1]);
      const matches = extractMatchesFromNextData(json);
      debug.player_page.next_matches = matches.length;

      const filtered = filterMatches(matches, allowedLeagues, seasonStart, seasonEnd);
      debug.player_page.kept = filtered.length;
      matchUrls.push(...filtered.map((x) => `https://www.fotmob.com/match/${x.id}`));

      debug.used.push("player_next");
    }
  } catch (e) {
    debug.player_page.errors = [String(e)];
  }

  // --- step 2: enriched HTML anchors (fallback) ---
  if (matchUrls.length === 0) {
    try {
      const res = await fetch(playerUrl + "?enrich=true", { headers: { "user-agent": "Mozilla/5.0" } });
      const text = await res.text();
      const matches = [...text.matchAll(/\/match\/(\d+)/g)].map((m) => ({ id: m[1] }));
      debug.player_page.enrich_probed = matches.length;

      const filtered = filterMatches(matches, allowedLeagues, seasonStart, seasonEnd);
      debug.player_page.enrich_kept = filtered.length;
      matchUrls.push(...filtered.map((x) => `https://www.fotmob.com/match/${x.id}`));

      debug.used.push("player_next_enriched_html");
    } catch (e) {
      debug.player_page.enrich_errors = [String(e)];
    }
  }

  // --- step 3: team fixtures (guaranteed fallback) ---
  if (matchUrls.length === 0) {
    try {
      const teamId = await discoverTeamId(playerUrl);
      if (teamId) {
        debug.team_pages.attempts = 1;
        const fixturesUrl = `https://www.fotmob.com/teams/${teamId}/fixtures`;
        const res = await fetch(fixturesUrl, { headers: { "user-agent": "Mozilla/5.0" } });
        const text = await res.text();
        const matches = [...text.matchAll(/\/match\/(\d+)/g)].map((m) => ({ id: m[1] }));
        debug.team_pages.next_matches = matches.length;

        const filtered = filterMatches(matches, allowedLeagues, seasonStart, seasonEnd);
        debug.team_pages.kept = filtered.length;
        matchUrls.push(...filtered.map((x) => `https://www.fotmob.com/match/${x.id}`));

        debug.used.push("team_next");
      }
    } catch (e) {
      debug.team_pages.errors = [String(e)];
    }
  }

  // --- dedupe ---
  matchUrls = Array.from(new Set(matchUrls));

  // --- cap ---
  if (maxMatches > 0) {
    matchUrls = matchUrls.slice(0, maxMatches);
  }

  return {
    player_url: playerUrl,
    player_id: playerId,
    player_name: null, // name can be filled later in check
    team_id: null,
    team_slug: null,
    match_urls: matchUrls,
    debug,
  };
}

function extractMatchesFromNextData(json) {
  try {
    let matches = [];
    const sections = json?.props?.pageProps?.player?.fixtures?.fixtures;
    if (Array.isArray(sections)) {
      for (const sec of sections) {
        if (Array.isArray(sec.Matches)) {
          for (const m of sec.Matches) {
            if (m.id) matches.push({ id: m.id, kickoff: m.kickoffTime, league_id: m.pageUrl?.leagueId });
          }
        }
      }
    }
    return matches;
  } catch {
    return [];
  }
}

function filterMatches(matches, allowedLeagues, seasonStart, seasonEnd) {
  return matches.filter((m) => {
    const t = new Date(m.kickoff || 0).getTime();
    const okLeague = allowedLeagues.has(Number(m.league_id || m.leagueId || 0));
    const okTime = t >= seasonStart && t <= seasonEnd;
    return okLeague && okTime;
  });
}

async function discoverTeamId(playerUrl) {
  try {
    const res = await fetch(playerUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    const text = await res.text();
    const m = text.match(/\/teams\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
