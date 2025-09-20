// netlify/functions/discover.mjs
// Robust discovery of 2025–26 Top-5 domestic league match URLs for player profile URLs,
// filtered to matches that have ALREADY KICKED OFF (<= now) to avoid huge lists early in the season.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30
const NOW          = new Date();                                    // keep only matches <= NOW

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_HTML = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
  "accept-language": "en-GB,en;q=0.9"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

function toISO(v){
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) {
    const d = new Date(n > 1e12 ? n : n*1000);
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
function inSeasonPast(iso){
  if(!iso) return false;
  const d = new Date(iso);
  return d >= SEASON_START && d <= SEASON_END && d <= NOW;
}

async function fetchText(url, retry=2){
  let last;
  for(let i=0;i<=retry;i++){
    try{
      const res = await fetch(url, { headers: HDRS_HTML, redirect: "follow" });
      const html = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if(!html) throw new Error("Empty HTML");
      return { finalUrl: res.url || url, html };
    }catch(e){ last = e; await sleep(200 + 250*i); }
  }
  throw last || new Error("fetch failed");
}
function nextDataStr(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(s){ try{ return JSON.parse(s); } catch { return null; } }

function* walk(root){
  const stack = [root], seen = new Set();
  while (stack.length){
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (seen.has(n)) continue;
    seen.add(n); yield n;
    for (const v of Object.values(n)){
      if (v && typeof v === "object") stack.push(v);
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") stack.push(it);
    }
  }
}
function unique(arr){ return Array.from(new Set(arr)); }

function parsePlayerIdFromUrl(url){
  try{
    const u = new URL(url);
    const m = u.pathname.match(/\/players\/(\d+)(?:\/|$)/i);
    return m ? Number(m[1]) : null;
  }catch{ return null; }
}

function discoverMatchesFromNextData(root){
  // Traverse arrays that look like match/fixture lists and pull (matchId, leagueId, kickoff ISO).
  const matches = [];
  let playerId = null, playerName = null, teamId = null, teamSlug = null;

  for (const node of walk(root)){
    // learn player/team
    if (playerId == null && (node?.playerId != null || node?.id != null) && (node?.fullName || node?.name)) {
      playerId = asNum(node?.playerId ?? node?.id) ?? playerId;
      playerName = (node?.fullName || node?.name || playerName || null);
    }
    if (teamId == null && (node?.teamId != null || node?.team?.id != null)){
      teamId = asNum(node?.teamId ?? node?.team?.id) ?? teamId;
      const nm = node?.team?.name || node?.teamName || null;
      if (nm && !teamSlug){
        teamSlug = String(nm).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
      }
    }

    for (const [k, v] of Object.entries(node)){
      if (!Array.isArray(v) || v.length === 0) continue;
      const key = String(k).toLowerCase();
      if (!/(match|fixture|game|recent|last|upcoming|schedule)/.test(key)) continue;

      for (const it of v){
        if (!it || typeof it !== "object") continue;
        const mid = asNum(it?.matchId ?? it?.id);
        if (!mid) continue;
        const lid = asNum(it?.leagueId ?? it?.tournamentId ?? it?.competitionId);
        const iso = toISO(
          it?.matchTimeUTC || it?.startTimeUTC || it?.utcStart || it?.dateUTC ||
          it?.date || it?.startDate || it?.kickoffISO || it?.time
        );
        matches.push({ matchId: mid, leagueId: lid ?? null, iso });
      }
    }
  }
  return { matches, playerId, playerName, teamId, teamSlug };
}

// STRICT filter: must have leagueId in Top-5 AND a valid kickoff within the 2025–26 window AND <= now.
function filterTop5SeasonPast(list){
  const out = [];
  for (const m of list){
    const lid = Number(m.leagueId);
    if (!Number.isFinite(lid) || !TOP5_LEAGUE_IDS.has(lid)) continue;
    if (!m.iso) continue;           // require a real kickoff timestamp
    if (!inSeasonPast(m.iso)) continue;
    out.push(m);
  }
  return out;
}

function buildMatchUrls(listOrIds){
  const ids = Array.isArray(listOrIds)
    ? unique(listOrIds.map(x => typeof x === "string" || typeof x === "number" ? String(x) : String(x.matchId)))
    : [];
  return ids.filter(Boolean).map(id => `https://www.fotmob.com/match/${id}`);
}

async function getNextData(url){
  const { html, finalUrl } = await fetchText(url);
  const s = nextDataStr(html);
  if (!s) throw new Error("NEXT_DATA not found");
  const obj = safeJSON(s);
  if (!obj) throw new Error("NEXT_DATA JSON parse failed");
  return { next: obj, html, finalUrl };
}

async function discoverForPlayerUrl(playerUrl){
  const debug = {
    used: [],
    player_page: { next_matches: 0, kept: 0, errors: [] },
    team_pages:  { attempts: 0, next_matches: 0, kept: 0, errors: [] },
    anchors:     { found: 0, kept: 0 },
  };

  let player_id = parsePlayerIdFromUrl(playerUrl);
  let player_name = null;
  let team_id = null;
  let team_slug = null;
  let matches = [];

  // 1) Player page
  try{
    const { next, html } = await getNextData(playerUrl);
    const found = discoverMatchesFromNextData(next);
    if (found.playerId) player_id = player_id ?? found.playerId;
    if (found.playerName) player_name = found.playerName;
    team_id  = team_id  ?? found.teamId;
    team_slug= team_slug?? found.teamSlug;

    debug.used.push("player_next");
    debug.player_page.next_matches += found.matches.length;

    const kept = filterTop5SeasonPast(found.matches);
    debug.player_page.kept += kept.length;
    matches = matches.concat(kept);

    // raw anchors -> keep only if we can later enrich dates (we can't here), so we drop them by default.
    // (We still record how many anchors existed for debugging.)
    const ids = Array.from(html.matchAll(/\/match\/(\d{5,10})/g)).map(m=>m[1]);
    debug.anchors.found = ids.length;
    // We do not use anchors now because they lack reliable league/date metadata
    // and previously caused over-collection.
  }catch(e){
    debug.player_page.errors.push(String(e));
  }

  // 2) Team fixtures/matches pages (if we know team)
  if (team_id){
    const tryUrls = [];
    const base = `https://www.fotmob.com/teams/${team_id}`;
    const slug = team_slug ? `/${team_slug}` : "";
    tryUrls.push(`${base}/fixtures${slug}`);
    tryUrls.push(`${base}/matches${slug}`);
    tryUrls.push(`${base}/overview${slug}`);
    tryUrls.push(`${base}${slug}`);

    for (const u of tryUrls){
      try{
        debug.team_pages.attempts += 1;
        const { next } = await getNextData(u);
        const found = discoverMatchesFromNextData(next);
        debug.used.push("team_next");
        debug.team_pages.next_matches += found.matches.length;

        const kept = filterTop5SeasonPast(found.matches);
        debug.team_pages.kept += kept.length;
        matches = matches.concat(kept);
      }catch(e){
        debug.team_pages.errors.push(`${u} :: ${String(e)}`);
      }
    }
  }

  // Deduplicate -> URLs
  const urlList = buildMatchUrls(matches);

  return {
    player_url: playerUrl,
    player_id,
    player_name: player_name || null,
    team_id: team_id || null,
    team_slug: team_slug || null,
    match_urls: urlList,
    debug
  };
}

export async function handler(event){
  try{
    let payload = {};
    if (event.httpMethod === "POST"){
      try{ payload = JSON.parse(event.body || "{}"); }
      catch { return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide { urls: [...] }" }) }; }
    } else {
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide { urls: [...] }" }) };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    if (!urls.length){
      return { statusCode:200, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide { urls: [...] }" }) };
    }

    const players = [];
    for (const u of urls){
      try{
        const one = await discoverForPlayerUrl(u);
        players.push(one);
      }catch(e){
        players.push({ player_url: u, player_id: parsePlayerIdFromUrl(u), match_urls: [], debug: { errors:[String(e)] } });
      }
    }

    return { statusCode:200, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:true, players }) };
  }catch(e){
    return { statusCode:500, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:String(e) }) };
  }
}
