// netlify/functions/discover.mjs
// Discover 2025–26 Top-5 domestic league matches for FotMob player URLs.
// Strategy:
// 1) Parse player __NEXT_DATA__ → collect (matchId, leagueId, kickoff).
// 2) Parse team fixtures/matches pages __NEXT_DATA__ → collect more.
// 3) If few/none, scrape /match/<id> anchors from BOTH pages and ENRICH each
//    via /api/matchDetails to get leagueId + kickoff and filter properly.
// Keeps only Top-5 domestic, within season window, and already kicked off.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30 23:59:59
const NOW          = new Date();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_HTML = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
  "accept-language": "en-GB,en;q=0.9"
};
const HDRS_JSON = {
  accept: "application/json",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
  "accept-language": "en-GB,en;q=0.9"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const resp = (code, obj) => ({ statusCode: code, headers:{ "content-type":"application/json" }, body: JSON.stringify(obj) });

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
    }catch(e){ last = e; await sleep(220 + 260*i); }
  }
  throw last || new Error("fetch failed (html)");
}
async function fetchJSON(url, retry=2){
  let last;
  for(let i=0;i<=retry;i++){
    try{
      const res = await fetch(url, { headers: HDRS_JSON, redirect:"follow" });
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,160) || ""}`);
      return JSON.parse(txt);
    }catch(e){ last = e; await sleep(280 + 300*i); }
  }
  throw last || new Error("fetch failed (json)");
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
function collectAnchorIds(html){
  return unique(Array.from(html.matchAll(/\/match\/(\d{5,10})/g)).map(m=>m[1]));
}

function discoverMatchesFromNextData(root){
  const matches = [];
  let playerId = null, playerName = null, teamId = null, teamSlug = null;

  for (const node of walk(root)){
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

function filterTop5SeasonPast(list){
  const out = [];
  for (const m of list){
    const lid = Number(m.leagueId);
    if (!Number.isFinite(lid) || !TOP5_LEAGUE_IDS.has(lid)) continue;
    if (!m.iso) continue;            // must have kickoff
    if (!inSeasonPast(m.iso)) continue;
    out.push(m);
  }
  return out;
}

function buildMatchUrls(listOrIds){
  const ids = Array.isArray(listOrIds)
    ? [...new Set(listOrIds.map(x => typeof x === "string" || typeof x === "number" ? String(x) : String(x.matchId)))]
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

async function enrichAnchorIds(ids, teamId){
  // Probe a reasonable window to avoid rate limits
  const MAX_PROBE = 96;
  const toProbe = [...new Set(ids)].slice(0, MAX_PROBE);
  const CONC = 2;             // gentle concurrency to avoid 401s
  const out = [];
  const q = [...toProbe];

  const work = async (mid) => {
    try{
      const j = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${mid}`);
      let leagueId = null, iso = null, hId = null, aId = null;
      leagueId = asNum(j?.general?.leagueId ?? j?.leagueId ?? j?.tournamentId ?? j?.competitionId);
      const ts = j?.general?.matchTimeUTC || j?.general?.startTimeUTC || j?.matchTimeUTC || j?.startTimeUTC;
      iso = toISO(ts);
      hId = asNum(j?.general?.homeTeam?.id ?? j?.homeTeam?.id);
      aId = asNum(j?.general?.awayTeam?.id ?? j?.awayTeam?.id);

      if (!Number.isFinite(leagueId) || !TOP5_LEAGUE_IDS.has(leagueId)) return;
      if (!iso || !inSeasonPast(iso)) return;
      if (Number.isFinite(teamId) && !(hId===teamId || aId===teamId)) return;

      out.push({ matchId: Number(mid), leagueId, iso });
    }catch(_e){ /* ignore */ }
  };

  const runners = new Array(CONC).fill(0).map(async ()=> {
    while(q.length){
      const id = q.shift();
      await work(id);
      await sleep(180); // spacing to be polite
    }
  });
  await Promise.all(runners);
  return out;
}

async function discoverForPlayerUrl(playerUrl){
  const debug = {
    used: [],
    player_page: { next_matches: 0, kept: 0, errors: [], anchors_found: 0, anchors_kept: 0, anchors_probed: 0 },
    team_pages:  { attempts: 0, next_matches: 0, kept: 0, errors: [], anchors_found: 0, anchors_kept: 0, anchors_probed: 0 },
  };

  let player_id = parsePlayerIdFromUrl(playerUrl);
  let player_name = null;
  let team_id = null;
  let team_slug = null;
  let matches = [];

  // 1) Player page
  let playerHtml = "";
  try{
    const { next, html } = await getNextData(playerUrl);
    playerHtml = html;
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

    // collect anchors for enrichment fallback
    const ids = collectAnchorIds(playerHtml);
    debug.player_page.anchors_found = ids.length;

    // Enrich if still none/few
    if (matches.length === 0 && ids.length){
      const enriched = await enrichAnchorIds(ids, team_id ?? null);
      debug.used.push("player_anchors_enriched");
      debug.player_page.anchors_probed = Math.min(96, ids.length);
      debug.player_page.anchors_kept = enriched.length;
      matches = matches.concat(enriched);
    }
  }catch(e){
    debug.player_page.errors.push(String(e));
  }

  // 2) Team fixtures/matches pages (adds more dated matches + anchors)
  let teamAnchors = [];
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
        const { next, html } = await getNextData(u);
        const found = discoverMatchesFromNextData(next);
        debug.used.push("team_next");
        debug.team_pages.next_matches += found.matches.length;

        const kept = filterTop5SeasonPast(found.matches);
        debug.team_pages.kept += kept.length;
        matches = matches.concat(kept);

        // also gather anchors for enrichment if still empty
        const ids = collectAnchorIds(html);
        teamAnchors = teamAnchors.concat(ids);
      }catch(e){
        debug.team_pages.errors.push(`${u} :: ${String(e)}`);
      }
    }

    // only enrich team anchors if we still have nothing
    if (matches.length === 0 && teamAnchors.length){
      teamAnchors = unique(teamAnchors);
      debug.team_pages.anchors_found = teamAnchors.length;
      const enriched = await enrichAnchorIds(teamAnchors, team_id);
      debug.used.push("team_anchors_enriched");
      debug.team_pages.anchors_probed = Math.min(96, teamAnchors.length);
      debug.team_pages.anchors_kept = enriched.length;
      matches = matches.concat(enriched);
    }
  }

  // Deduplicate → URLs
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
      catch { return resp(400, { ok:false, error:"Provide { urls: [...] }" }); }
    } else if (event.httpMethod === "GET"){
      const q = event.queryStringParameters?.urls || "";
      const urls = decodeURIComponent(q).split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
      payload = { urls };
    } else {
      return resp(400, { ok:false, error:"Provide { urls: [...] }" });
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    if (!urls.length){
      return resp(200, { ok:false, error:"Provide { urls: [...] }" });
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

    return resp(200, { ok:true, players });
  }catch(e){
    return resp(500, { ok:false, error:String(e) });
  }
}
