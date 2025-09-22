// netlify/functions/discover.mjs
import fetch from "node-fetch";

/*
Robust discover:
- Safe NEXT_DATA extraction (multiline)
- Collects match IDs from NEXT_DATA and anchors
- Tries player page enriched HTML and team fixtures as fallback
- Avoids throwing on empty JSON
- Returns match_urls (deduped) + useful debug
*/

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const ALLOWED_LEAGUES = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, BuLi, Serie A, Ligue 1
const SEASON_START_TS = Date.UTC(2025, 6, 1, 0, 0, 0); // 2025-07-01
const SEASON_END_TS   = Date.UTC(2026, 5, 30, 23, 59, 59); // 2026-06-30

async function fetchText(url, retry = 2, timeoutMs = 10000) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!text) throw new Error("empty HTML");
      return { finalUrl: res.url || url, html: text };
    } catch (e) {
      last = e;
      // small backoff
      await new Promise(r => setTimeout(r, 200 + 200 * i));
    }
  }
  throw last || new Error("fetch failed");
}

function extractNextDataString(html) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// Walk object to collect match-like nodes
function collectMatchesFromObj(obj) {
  const ids = [];
  if (!obj || typeof obj !== "object") return ids;
  const q = [obj];
  while (q.length) {
    const node = q.pop();
    if (!node || typeof node !== "object") continue;

    // Common direct fields
    if (node.matchId && /^\d{5,12}$/.test(String(node.matchId))) {
      ids.push({
        id: String(node.matchId),
        leagueId: node.leagueId || node.competitionId || node.tournamentId || null,
        kickoff: node.utcDate || node.kickoff || node.matchTimeUTC || node.startDate || node.date || null
      });
    }
    // sometimes "id" inside a match-like block
    if (node.id && /^\d{5,12}$/.test(String(node.id)) && (node.homeTeam || node.awayTeam || node.home || node.away || node.kickoff)) {
      ids.push({
        id: String(node.id),
        leagueId: node.leagueId || node.competitionId || node.tournamentId || null,
        kickoff: node.utcDate || node.kickoff || node.matchTimeUTC || node.startDate || node.date || null
      });
    }

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") q.push(v);
    }
  }
  return ids;
}

function scrapeMatchLinks(html) {
  const set = new Set();
  // anchors to /match/<digits>
  for (const m of html.matchAll(/href=["'](\/match\/\d{5,12}(?:\/[^"']*)?)["']/gi)) {
    set.add("https://www.fotmob.com" + m[1].split(/[?#]/)[0]);
  }
  // anchors to /matches/<slug>/<token>
  for (const m of html.matchAll(/href=["'](\/matches\/[^"']+)["']/gi)) {
    set.add("https://www.fotmob.com" + m[1].split(/[?#]/)[0]);
  }
  // inline "matchId": 123456
  for (const m of html.matchAll(/"matchId"\s*:\s*(\d{5,12})/gi)) {
    set.add("https://www.fotmob.com/match/" + m[1]);
  }
  return Array.from(set);
}

function findTeamFromPlayerHtml(html) {
  const hrefs = Array.from(html.matchAll(/href=["']\/teams\/([^"'?#]+)["']/gi)).map(m => m[1]);
  const BAD = new Set(["overview","fixtures","matches","squad","stats","statistics","transfers","news","table","season","results"]);
  for (const h of hrefs) {
    const path = h.split("?")[0].replace(/^\/+|\/+$/g, "");
    const segs = path.split("/");
    const id = Number(segs[0]);
    if (!Number.isFinite(id)) continue;
    let slug = null;
    for (let i = segs.length - 1; i >= 1; i--) {
      const s = (segs[i] || "").toLowerCase();
      if (!s || BAD.has(s)) continue;
      if (/^\d+$/.test(s)) continue;
      slug = s;
      break;
    }
    if (!slug) continue;
    return { team_id: id, team_slug: slug };
  }
  return { team_id: null, team_slug: null };
}

function dedupeAndNormalize(matches) {
  const byId = new Map();
  for (const m of matches) {
    if (!m || !m.id) continue;
    const id = String(m.id);
    const existing = byId.get(id) || {};
    byId.set(id, {
      id,
      leagueId: existing.leagueId || m.leagueId || m.leagueId || m.leagueId || m.leagueId || m.league_id || m.leagueId,
      kickoff: existing.kickoff || m.kickoff || m.utcDate || m.startDate || m.date || null
    });
  }
  return Array.from(byId.values());
}

function matchesPassFilter(m) {
  // If we have both kickoff and leagueId apply strong filter
  if (m.leagueId || m.kickoff) {
    const leagueOk = m.leagueId ? ALLOWED_LEAGUES.has(Number(m.leagueId)) : true;
    const t = m.kickoff ? new Date(m.kickoff).getTime() : null;
    const timeOk = t ? (t >= SEASON_START_TS && t <= SEASON_END_TS) : true;
    return leagueOk && timeOk;
  }
  // If we lack metadata, be permissive (let check.mjs filter later)
  return true;
}

function normalizePlayerUrl(u) {
  try {
    let url = u.trim();
    // strip locale segments like /en-GB/ or /en/
    url = url.replace(/\/(en|es|fr|de|it|pt|[a-z]{2}-[A-Z]{2})\//, "/");
    url = url.replace(/[?#].*$/, "");
    url = url.replace(/\/\/+/g, "/").replace(/^https?:\/(?!\/)/, "https://");
    url = url.replace(/\/$/, "");
    // ensure protocol + host if user pasted relative-ish
    if (!/^https?:\/\//i.test(url)) url = "https://www.fotmob.com" + (url.startsWith("/") ? url : "/" + url);
    return url;
  } catch {
    return u;
  }
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); } catch { payload = {}; }
    } else {
      payload = { urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean), maxMatches: Number(event.queryStringParameters?.maxMatches || 0) };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    const cap = Number(payload.maxMatches) || 0;

    if (!urls.length) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    const players = [];
    for (const raw of urls) {
      const player_url = normalizePlayerUrl(raw);
      const debug = { used: [], raw_matches: 0, anchors_found: 0, kept: 0, errors: [] };
      let player_id = null;
      let player_name = null;
      let team_id = null;
      let team_slug = null;
      try {
        // 1) fetch player page
        let fetched = null;
        try { fetched = await fetchText(player_url, 2); } catch (e) { debug.errors.push("player_fetch:" + String(e)); }
        const playerHtml = fetched ? fetched.html : "";

        if (playerHtml) {
          // extract player id/name from URL or from NEXT_DATA if present
          const uParts = player_url.split("/").filter(Boolean);
          // naive parse of id and slug
          const pidMatch = player_url.match(/\/players\/(\d{4,12})/);
          player_id = pidMatch ? Number(pidMatch[1]) : null;

          // parse __NEXT_DATA__ for matches
          const ndStr = extractNextDataString(playerHtml);
          if (ndStr) {
            const ndObj = safeParseJSON(ndStr);
            if (ndObj) {
              const found = collectMatchesFromObj(ndObj);
              debug.raw_matches += found.length;
              const normalized = dedupeAndNormalize(found);
              const kept = normalized.filter(matchesPassFilter);
              debug.kept += kept.length;
              const urls = kept.map(x => `https://www.fotmob.com/match/${x.id}`);
              debug.anchors_found += urls.length;
              // add to array
              // we'll store intermediate items and then maybe probe team pages
              team_id = team_id || findTeamFromPlayerHtml(playerHtml).team_id;
              // push those after team probe/dedupe
              if (urls.length) debug.used.push("player_next");
              // set matchUrls local var
              // we'll merge with other sources below
              // temporarily collect
              player_name = player_name || (ndObj?.props?.pageProps?.player?.name) || null;
              // accumulate
            }
          }

          // anchors from HTML (catch-all)
          const anchors = scrapeMatchLinks(playerHtml);
          if (anchors && anchors.length) {
            debug.raw_matches += anchors.length;
            debug.anchors_found += anchors.length;
            debug.used.push("player_anchors");
          }

          // set team from anchors/html
          const teamFromHtml = findTeamFromPlayerHtml(playerHtml);
          if (teamFromHtml.team_id) { team_id = teamFromHtml.team_id; team_slug = teamFromHtml.team_slug; }
        }

        // 2) team pages if we have team_id or if still zero matches
        let collectedMatches = new Set();
        // if we found anchors directly from playerHtml or nd earlier, add them
        if (playerHtml) {
          const anchors = scrapeMatchLinks(playerHtml);
          for (const a of anchors) {
            const mm = a.match(/\/match\/(\d{5,12})/);
            if (mm) collectedMatches.add(mm[1]);
          }
        }

        if (team_id) {
          const candidates = [
            `https://www.fotmob.com/teams/${team_id}/fixtures/${encodeURIComponent(team_slug || "")}`,
            `https://www.fotmob.com/teams/${team_id}/matches/${encodeURIComponent(team_slug || "")}`,
            `https://www.fotmob.com/teams/${team_id}/overview/${encodeURIComponent(team_slug || "")}`,
            `https://www.fotmob.com/teams/${team_id}/${encodeURIComponent(team_slug || "")}`
          ];
          for (const turl of candidates) {
            try {
              const fetchedT = await fetchText(turl, 1);
              const html = fetchedT.html || "";
              const anchors = scrapeMatchLinks(html);
              for (const a of anchors) {
                const mm = a.match(/\/match\/(\d{5,12})/);
                if (mm) collectedMatches.add(mm[1]);
              }
              if (anchors.length) debug.used.push("team_anchors");
            } catch (e) {
              // non-fatal
              debug.errors.push(`team_fetch ${turl}: ${String(e)}`);
            }
          }
        }

        // If no match IDs yet, as last resort try regex over playerHtml again
        if (playerHtml && collectedMatches.size === 0) {
          for (const m of playerHtml.matchAll(/\/match\/(\d{5,12})/g)) collectedMatches.add(m[1]);
        }

        // Build objects array with optional metadata from earlier NEXT_DATA if present
        let candidateObjs = Array.from(collectedMatches).map(id => ({ id }));

        // Try to enrich from NEXT_DATA if any
        if (playerHtml) {
          const ndStr2 = extractNextDataString(playerHtml);
          const ndObj2 = ndStr2 ? safeParseJSON(ndStr2) : null;
          if (ndObj2) {
            const foundObjs = collectMatchesFromObj(ndObj2);
            for (const fo of foundObjs) {
              const idx = candidateObjs.findIndex(x => String(x.id) === String(fo.id));
              if (idx >= 0) {
                candidateObjs[idx] = { ...candidateObjs[idx], leagueId: fo.leagueId || fo.league_id, kickoff: fo.kickoff || fo.utcDate || fo.matchDate };
              } else {
                candidateObjs.push({ id: fo.id, leagueId: fo.leagueId || fo.league_id, kickoff: fo.kickoff || fo.utcDate || fo.matchDate });
              }
            }
          }
        }

        // Filter/dedupe normalized objects
        const normalized = dedupeAndNormalize(candidateObjs);

        // Filter by season & league when possible; if no meta present, keep and let check filter later
        const final = normalized.filter(matchesPassFilter);

        const match_urls = (cap > 0 ? final.slice(0, cap) : final).map(x => `https://www.fotmob.com/match/${x.id}`);

        players.push({
          player_url,
          player_id,
          player_name,
          team_id,
          team_slug,
          match_urls,
          debug: {
            used: debug.used,
            raw_matches: debug.raw_matches,
            anchors_found: debug.anchors_found,
            kept: final.length,
            errors: debug.errors
          }
        });
      } catch (e) {
        players.push({
          player_url,
          player_id: null,
          player_name: null,
          team_id: null,
          team_slug: null,
          match_urls: [],
          debug: { used: [], raw_matches: 0, anchors_found: 0, kept: 0, errors: [String(e)] }
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, players, meta: { ms: 0 } })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok:false, error: String(e) }) };
  }
}
