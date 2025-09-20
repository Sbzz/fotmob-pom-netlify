// netlify/functions/check.mjs
// Check one match URL for a given player (POTM + key stats) and emit a stable fixture fingerprint
// Input (POST JSON): { matchUrl, playerId?, playerName? }
// Output: fields used by index.html (incl. fixture_key for de-dup)

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30
const NOW          = new Date();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
  "accept-language": "en-GB,en;q=0.9"
};

const resp = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clampInt = (v) => Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;

function toISO(v){
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) {
    const d = new Date(n > 1e12 ? n : n * 1000);
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
function inSeason(iso){
  if(!iso) return false;
  const d = new Date(iso);
  return d >= SEASON_START && d <= SEASON_END;
}

async function fetchText(url){
  const res = await fetch(url, { headers: HDRS, redirect: "follow" });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  if (!html) throw new Error("Empty HTML");
  return { finalUrl: res.url || url, html };
}
function nextDataStr(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(s){ try{ return JSON.parse(s); }catch{ return null; } }

function* walk(root){
  const stack=[root], seen=new Set();
  while(stack.length){
    const n=stack.pop();
    if(!n || typeof n!=="object") continue;
    if(seen.has(n)) continue;
    seen.add(n); yield n;
    for(const v of Object.values(n)){
      if(v && typeof v==="object") stack.push(v);
      if(Array.isArray(v)) for(const it of v) if(it && typeof it==="object") stack.push(it);
    }
  }
}
function normName(s){ return String(s||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }

// Create a stable key for a fixture (minute precision)
function mkFixtureKey(leagueId, iso, hId, aId, hName, aName){
  const lid = leagueId ?? 'X';
  const t   = (iso||'').slice(0,16); // YYYY-MM-DDTHH:MM
  const H   = (hId!=null ? `H#${hId}` : `H@${(hName||'').toLowerCase()}`);
  const A   = (aId!=null ? `A#${aId}` : `A@${(aName||'').toLowerCase()}`);
  return `L${lid}|${t}|${H}|${A}`;
}

// ---- Extraction helpers from match __NEXT_DATA__ ----
function extractGeneral(root){
  let leagueId=null, leagueName=null, iso=null, title=null, mid=null;
  let hId=null, aId=null, hName=null, aName=null;

  const setTeams = (g)=>{
    const home = g?.homeTeam || g?.home || null;
    const away = g?.awayTeam || g?.away || null;
    if(home){ hId = hId ?? asNum(home.id); hName = hName ?? (home.name || home.teamName || home.shortName || null); }
    if(away){ aId = aId ?? asNum(away.id); aName = aName ?? (away.name || away.teamName || away.shortName || null); }
  };

  for(const node of walk(root)){
    const g = node?.general || node?.overview?.general || node?.match?.general || null;
    if(!g) continue;
    leagueId   = leagueId   ?? asNum(g.leagueId ?? g.tournamentId ?? g.competitionId);
    leagueName = leagueName ?? (g.leagueName ?? g.tournamentName ?? g.competitionName ?? g?.league?.name ?? g?.tournament?.name ?? g?.competition?.name);
    iso        = iso        ?? toISO(g.matchTimeUTC ?? g.startTimeUTC ?? g.kickoff?.utc ?? g.dateUTC);
    title      = title      ?? (g.pageTitle || g.matchName || g.title);
    mid        = mid        ?? asNum(g.matchId ?? g.id);
    setTeams(g);
    if(leagueId && iso && (hId||hName) && (aId||aName)) break;
  }
  if(!title){
    for(const node of walk(root)){ if(node?.seo?.title){ title=node.seo.title; break; } }
  }
  if(!mid){
    for(const node of walk(root)){ if(asNum(node?.matchId)){ mid=asNum(node.matchId); break; } }
  }
  return { leagueId, leagueName, iso, title, matchId: mid, hId, aId, hName, aName };
}

function extractPOTM(root){
  // Prefer explicit fields
  for(const node of walk(root)){
    const potm = node?.playerOfTheMatch || node?.potm || node?.manOfTheMatch;
    if(potm && (potm.id || potm.playerId || potm.name)){
      const id = asNum(potm.id ?? potm.playerId);
      const nm = potm.name?.fullName || potm.name || (potm.firstName && potm.lastName ? `${potm.firstName} ${potm.lastName}` : null);
      const ratingNum = asNum(potm.rating?.num ?? potm.rating);
      return { id, name: nm, rating: ratingNum };
    }
  }
  // Fallback: top rating with isTopRating && finished
  let best = null;
  for(const node of walk(root)){
    if(!node?.rating) continue;
    const isTop = node?.rating?.isTop?.isTopRating;
    const finished = node?.rating?.isTop?.isMatchFinished;
    if(!isTop || !finished) continue;
    const cand = {
      id: asNum(node.id ?? node.playerId),
      name: node?.name?.fullName || node?.name || null,
      rating: asNum(node?.rating?.num)
    };
    if(cand.id || cand.name){
      if(!best || (asNum(cand.rating)||0) > (asNum(best.rating)||0)) best = cand;
    }
  }
  return best;
}

function findPlayerNode(root, playerId, playerName){
  const targetName = normName(playerName||'');
  let exactById=null, bestByName=null;
  for(const node of walk(root)){
    const id = asNum(node?.id ?? node?.playerId);
    const full = node?.name?.fullName || node?.name || null;
    const hasStats = Array.isArray(node?.stats) && node.stats.length>0;
    if(!hasStats) continue;
    if(playerId && id === playerId) return node;
    if(!bestByName && full && targetName && normName(full) === targetName) bestByName = node;
    if(!exactById && id && playerId && id === playerId) exactById = node;
  }
  return exactById || bestByName || null;
}

function extractStatsFromStatsBlocks(node){
  const acc = { goals:0, penalty_goals:0, assists:0, yellow_cards:0, red_cards:0, minutes_played:0, rating:null };
  if(!node || !Array.isArray(node.stats)) return acc;

  const pick = (labels) => {
    for(const lab of labels){
      for(const section of node.stats){
        const m = section?.stats?.[lab];
        const v = m?.stat?.value ?? m?.value ?? m;
        if(v!=null) return Number(v);
      }
    }
    return null;
  };

  const rating = pick(["FotMob rating","Rating","Match rating"]);
  const mins   = pick(["Minutes played","Minutes","Time played"]);
  const goals  = pick(["Goals","Total goals"]);
  const pg     = pick(["Penalty goals","Penalties scored","Scored penalties","Penalty Goals"]);
  const ast    = pick(["Assists","Total assists"]);
  const yc     = pick(["Yellow cards","Yellow Cards","YC"]);
  const rc     = pick(["Red cards","Red Cards","RC"]);

  if(Number.isFinite(rating)) acc.rating = rating;
  if(Number.isFinite(mins))   acc.minutes_played = mins;
  if(Number.isFinite(goals))  acc.goals = goals;
  if(Number.isFinite(pg))     acc.penalty_goals = pg;
  if(Number.isFinite(ast))    acc.assists = ast;
  if(Number.isFinite(yc))     acc.yellow_cards = yc;
  if(Number.isFinite(rc))     acc.red_cards = rc;

  return acc;
}

function buildResult(payload){
  const { matchUrl, general, potm, playerNode, playerId, playerName } = payload;
  const league_id   = asNum(general.leagueId);
  const league_name = general.leagueName || null;
  const iso         = general.iso || null;
  const allowed     = league_id!=null && TOP5_LEAGUE_IDS.has(league_id);
  const within      = !!iso && inSeason(iso) && (new Date(iso) <= NOW);

  let stats = { goals:0, penalty_goals:0, assists:0, yellow_cards:0, red_cards:0, minutes_played:0, rating:null };
  if(playerNode){ stats = extractStatsFromStatsBlocks(playerNode); }
  const fmp = stats.minutes_played >= 90;

  const pid = asNum(playerId);
  const player_is_pom =
    !!potm && ((pid && potm.id && pid === potm.id) || (!pid && potm.name && normName(potm.name) === normName(playerName||'')));

  const fixture_key = mkFixtureKey(
    league_id, iso,
    general.hId, general.aId,
    general.hName, general.aName
  );

  return {
    match_url: matchUrl,
    resolved_match_id: general.matchId ? String(general.matchId) : (matchUrl.match(/\/match\/(\d+)/)?.[1] || null),
    match_title: general.title || "match",
    league_id,
    league_label: league_name,
    match_datetime_utc: iso,
    league_allowed: allowed,
    within_season_2025_26: within,
    player_is_pom,
    player_rating: stats.rating!=null ? Number(stats.rating) : null,
    potm_name: potm?.name ? { fullName: potm.name } : null,
    potm_id: potm?.id ?? null,

    // NEW: team identity for de-dupe
    home_team_id: general.hId ?? null,
    home_team_name: general.hName ?? null,
    away_team_id: general.aId ?? null,
    away_team_name: general.aName ?? null,
    fixture_key,

    player_stats: {
      goals: clampInt(stats.goals),
      penalty_goals: clampInt(stats.penalty_goals),
      assists: clampInt(stats.assists),
      yellow_cards: clampInt(stats.yellow_cards),
      red_cards: clampInt(stats.red_cards),
      full_match_played: !!fmp
    },
    echo_player_name: (playerNode?.name?.fullName || playerName || null),
    source: "next_html"
  };
}

export async function handler(event){
  try{
    if(event.httpMethod!=="POST"){
      return resp(400, { error:"POST required" });
    }
    let body={};
    try{ body = JSON.parse(event.body||"{}"); }catch{ return resp(400,{ error:"Bad JSON" }); }

    const matchUrl = String(body.matchUrl||"").trim();
    const playerId = asNum(body.playerId);
    const playerName = String(body.playerName||"").trim();
    if(!/\/match\/\d+/.test(matchUrl)) return resp(200,{ error:"Provide matchUrl like https://www.fotmob.com/match/123456" });

    const { html } = await fetchText(matchUrl);
    const s = nextDataStr(html);
    if(!s) return resp(200, { error:"NEXT_DATA not found" });
    const next = safeJSON(s);
    if(!next) return resp(200, { error:"NEXT_DATA JSON parse failed" });

    const general = extractGeneral(next);
    const potm = extractPOTM(next) || null;

    let node = null;
    if(playerId || playerName){
      node = findPlayerNode(next, playerId||null, playerName||null);
    }

    const out = buildResult({ matchUrl, general, potm, playerNode: node, playerId, playerName });
    return resp(200, out);

  }catch(e){
    return resp(200, { error:String(e) });
  }
}
