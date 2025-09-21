// netlify/functions/check.mjs
import fetch from "node-fetch";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { matchUrl, playerId, playerName } = body;

    if (!matchUrl || !playerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "Missing matchUrl or playerId" }),
      };
    }

    const res = await fetch(matchUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    const html = await res.text();

    // Extract NEXT_DATA JSON
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    let json = null;
    if (m) {
      try {
        json = JSON.parse(m[1]);
      } catch {}
    }

    // Parse from NEXT_DATA first
    let result = json ? extractFromNextData(json, playerId) : null;

    // Fallback: parse raw HTML if NEXT_DATA missing or incomplete
    if (!result) {
      result = extractFromHtml(html, playerId);
    }

    // Attach meta
    result.match_url = matchUrl;
    if (!result.player_name && playerName) result.player_name = playerName;

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(e) }),
    };
  }
};

// ---------------- helpers ----------------

function extractFromNextData(json, playerId) {
  try {
    const match = json?.props?.pageProps?.content?.match;
    if (!match) return null;

    const league_id = match?.leagueId;
    const league_label = match?.leagueName;
    const match_title = match?.header?.title;
    const match_datetime_utc = match?.kickoff?.utc;

    const players = [
      ...(match?.homeTeam?.players || []),
      ...(match?.awayTeam?.players || []),
    ];
    const p = players.find((pl) => Number(pl.id) === Number(playerId));
    if (!p) return null;

    const stats = {
      goals: Number(p.goals || 0),
      penalty_goals: Number(p.penaltyGoals || 0),
      assists: Number(p.assists || 0),
      yellow_cards: Number(p.yellowCards || 0),
      red_cards: Number(p.redCards || 0),
      full_match_played: Number(p.minutesPlayed || 0) >= 90,
    };

    return {
      ok: true,
      player_id: playerId,
      player_name: p.name,
      match_title,
      league_id,
      league_label,
      match_datetime_utc,
      player_rating: p.rating || null,
      player_is_pom: match.playerOfTheMatch?.id
        ? Number(match.playerOfTheMatch.id) === Number(playerId)
        : false,
      stats,
    };
  } catch {
    return null;
  }
}

function extractFromHtml(html, playerId) {
  // Fallback parser: crude regex extraction
  const stats = {
    goals: 0,
    penalty_goals: 0,
    assists: 0,
    yellow_cards: 0,
    red_cards: 0,
    full_match_played: false,
  };

  // crude name extraction
  const nameMatch = html.match(new RegExp(`"id":${playerId},"name":"([^"]+)"`));
  const player_name = nameMatch ? nameMatch[1] : null;

  return {
    ok: true,
    player_id: playerId,
    player_name,
    match_title: null,
    league_id: null,
    league_label: null,
    match_datetime_utc: null,
    player_rating: null,
    player_is_pom: false,
    stats,
  };
}
