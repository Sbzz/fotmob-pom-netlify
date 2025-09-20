// netlify/functions/discover.mjs
// Discover 2025–26 Top-5 domestic league matches for FotMob player URLs,
// safely (short timeouts + time budget) and ALWAYS return JSON.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30 23:59:59
const NOW          = new Date();

const BUDGET_MS    = 8500; // keep under Netlify’s cold function timeout
const FETCH_TO_MS  = 2200; // per-request timeout
const ENRICH_MAX   = 64;   // cap enrichment to avoid rate/time issues
const ENRICH_CONC  = 2;    // concurrency (gentle)

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_HTML = { accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "user-agent":UA, referer:"https://www.fotmob.com/", "accept-language":"en-GB,en;q=0.9" };
const HDRS_JSON = { accept:"application/json", "user-agent":UA, referer:"https://www.fotmob.com/", "accept-language":"en-GB,en;q=0.9" };

const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const unique = (arr) => Array.from(new Set(arr));
const resp  = (code, obj) => ({ statusCode: code, headers:{ "content-type":"application/json" }, body: JSON.stringify(obj) });

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

// fetch with timeout
async function fetchWithTimeout(url, opts, ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res  = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url){
  try{
    const { res, text } = await fetchWithTimeout(url, { headers: HDRS_HTML, redirect:"follow" }, FETCH_TO_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!text) throw new Error("Empty HTML");
    return { finalUrl: res.url || url, html: text };
  }catch(e){ throw new Error(`fetchText(${url}): ${String(e)}`); }
}

async function fetchJSON(url){
  try{
    const { res, text } = await fetchWithTimeout(url, { headers: HDRS_JSON, redirect:"follow" }, FETCH_TO_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text?.slice(0,180) || ""}`);
    return text ? JSON.parse(text) : {};
  }catch(e){ throw new Error(`fetchJSON(${url}): ${String(e)}`); }
}

function nextDataStr(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(s){ try { return JSON.parse(s); } catch { return null; } }

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

function parsePlayerIdFromUrl(url){
  try{
    const u = new URL(url);
    const m = u.pathname.match(/\/players\/(\d+)(?:\/|$)/i);
    return m ? Number(m[1]) : null;
  }catch{ return null; }
}

function collectMatchesFromNext(root){
  const matches = [];
  let playerId = null, playerName = null, teamId = null, teamSlug = null;

  const leagueIdFrom = (it) =>
    asNum(it?.leagueId ?? it?.tournamentId ?? it?.competitionId
      ?? it?.league?.id ?? it?.tournament?.id ?? it?.competition?.id);

  const isoFrom = (it) =>
    toISO(it?.matchTimeUTC ?? it?.startTimeUTC ?? it?.utcStart ?? it?.dateUTC
      ?? it?.date ?? it?.startDate ?? it?.kickoffISO ?? it?.time
      ?? it?.status?.utcTime ?? it?.kickoff?.utc);

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
        const lid = leagueIdFrom(it) ?? null;
        const iso = isoFrom(it) ?? null;
        matches.push({ matchId: mid, leagueId: lid, iso });
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
    if (!m.iso) continue;
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

// enrichment via matchDetails for IDs lacking metadata (time-budgeted)
async function enrichIdsViaApi(ids, teamId, debug, stage, deadline){
  const toProbe = [...new Set(ids)].slice(0, ENRICH_MAX);
  const q = [...toProbe];
  const out = [];
  const errs = [];

  const work = async (mid) => {
    if (Date.now() + 600 > deadline) { // keep some headroom to respond
      debug[stage].budget_skipped = (debug[stage].budget_skipped || 0) + (q.length + 1);
      return; // stop early
    }
    try{
      const j = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${mid}`);
      let leagueId = asNum(j?.general?.leagueId ?? j?.leagueId ?? j?.tournamentId ?? j?.competitionId);
      const ts = j?.general?.matchTimeUTC || j?.general?.startTimeUTC || j?.matchTimeUTC || j?.startTimeUTC;
      const iso = toISO(ts);
      const hId = asNum(j?.general?.homeTeam?.id ?? j?.homeTeam?.id);
      const aId = asNum(j?.general?.awayTeam?.id ?? j?.awayTeam?.id);

      if (!Number.isFinite(leagueId) || !TOP5_LEAGUE_IDS.has(leagueId)) return;
      if (!iso || !inSeasonPast(iso)) return;
      if (Number.isFinite(teamId) && !(hId===teamId || aId===teamId)) return;

      out.push({ matchId: Number(mid), leagueId, iso });
    }catch(e){ errs.push(`${mid}: ${String(e).slice(0,110)}`); }
  };

  const runners = new Array(ENRICH_CONC).fill(0).map(async ()=>{
    while(q.length){
      const id = q.shift();
      await work(id);
      await new Promise(r=>setTimeout(r, 140)); // be gentle
    }
  });
  await Promise.all(runners);

  debug[stage].enrich_probed = toProbe.length;
  debug[stage].enrich_kept   = out.length;
  debug[stage].enrich_errors = errs.length;

  return out;
}

async function discoverForPlayerUrl(playerUrl, deadline){
  const debug = {
    used: [],
    player_page: { next_matches: 0, kept: 0, errors: [], enrich_probed:0, enrich_kept:0, enrich_errors:0, budget_skipped:0 },
    team_pages:  { attempts: 0, next_matches: 0, kept: 0, errors: [], enrich_probed:0, enrich_kept:0, enrich_errors:0, budget_skipped:0 },
  };

  let player_id = parsePlayerIdFromUrl(playerUrl);
  let player_name = null, team_id = null, team_slug = null;
  let matches = [];

  // 1) Player page
  let playerNextIds = [];
  try{
    const { next } = await getNextData(playerUrl);
    const found = collectMatchesFromNext(next);
    if (found.playerId) player_id = player_id ?? found.playerId;
    if (found.playerName) player_name = found.playerName;
    team_id  = team_id  ?? found.teamId;
    team_slug= team_slug?? found.teamSlug;

    debug.used.push("player_next");
    debug.player_page.next_matches += found.matches.length;

    const kept = filterTop5SeasonPast(found.matches);
    debug.player_page.kept += kept.length;
    matches = matches.concat(kept);

    playerNextIds = unique(found.matches.map(m => String(m.matchId))).filter(Boolean);

    // Enrich if still nothing/few and we have time
    if (matches.length === 0 && playerNextIds.length && (Date.now()+1500 < deadline)){
      const enr = await enrichIdsViaApi(playerNextIds, team_id ?? null, debug, "player_page", deadline);
      debug.used.push("player_next_enriched");
      matches = matches.concat(enr);
    }
  }catch(e){
    debug.player_page.errors.push(String(e));
  }

  // 2) Team fixtures/matches pages
  if (team_id && (Date.now()+1200 < deadline)){
    const tryUrls = [];
    const base = `https://www.fotmob.com/teams/${team_id}`;
    const slug = team_slug ? `/${team_slug}` : "";
    tryUrls.push(`${base}/fixtures${slug}`);
    tryUrls.push(`${base}/matches${slug}`);
    tryUrls.push(`${base}/overview${slug}`);
    tryUrls.push(`${base}${slug}`);

    let teamNextIds = [];
    for (const u of tryUrls){
      if (Date.now()+1000 >= deadline) break;
      try{
        debug.team_pages.attempts += 1;
        const { next } = await getNextData(u);
        const found = collectMatchesFromNext(next);

        debug.used.push("team_next");
        debug.team_pages.next_matches += found.matches.length;

        const kept = filterTop5SeasonPast(found.matches);
        debug.team_pages.kept += kept.length;
        matches = matches.concat(kept);

        teamNextIds = teamNextIds.concat(found.matches.map(m => String(m.matchId)));
      }catch(e){
        debug.team_pages.errors.push(`${u} :: ${String(e)}`);
      }
    }

    if (matches.length === 0 && teamNextIds.length && (Date.now()+1500 < deadline)){
      const enr = await enrichIdsViaApi(unique(teamNextIds), team_id, debug, "team_pages", deadline);
      debug.used.push("team_next_enriched");
      matches = matches.concat(enr);
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
  const start = Date.now();
  const deadline = start + BUDGET_MS;

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
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 600){
        // out of time — return what we have so far
        players.push({ player_url: u, player_id: parsePlayerIdFromUrl(u), match_urls: [], debug: { errors:["time budget exceeded before processing"], used:[] } });
        break;
      }
      try{
        const one = await discoverForPlayerUrl(u, deadline);
        players.push(one);
      }catch(e){
        players.push({ player_url: u, player_id: parsePlayerIdFromUrl(u), match_urls: [], debug: { errors:[String(e)] } });
      }
    }

    return resp(200, { ok:true, players, meta:{ ms: Date.now()-start, budget_ms: BUDGET_MS } });
  }catch(e){
    // Always return JSON, never empty body
    return resp(200, { ok:false, error:String(e), meta:{ ms: Date.now()-start, budget_ms: BUDGET_MS } });
  }
}
