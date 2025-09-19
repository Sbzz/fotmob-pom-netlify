// netlify/functions/discover.mjs
// Inputs:  POST { urls: [ "https://www.fotmob.com/players/<id>/<slug>", ... ] }
// Outputs: { ok:true, players:[{ player_url, player_name, player_id, match_urls, debug }], meta:{...} }
// Filters to Top-5 leagues and the 2025–26 season, and verifies player presence per match.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0));
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS_HTML = { accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "user-agent":UA, referer:"https://www.fotmob.com/" };
const HDRS_JSON = { accept:"application/json", "user-agent":UA, referer:"https://www.fotmob.com/" };

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function pidFromUrl(u){
  try{ const m=new URL(u).pathname.match(/\/players\/(\d+)(?:\/|$)/i); return m?Number(m[1]):null; }catch{ return null; }
}
function norm(s){ return String(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim(); }

async function fetchText(url, retry=2){
  let last;
  for (let i=0;i<=retry;i++){
    try{
      const res = await fetch(url,{ headers: HDRS_HTML, redirect: "follow" });
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if(!txt) throw new Error("Empty HTML");
      return { finalUrl: res.url || url, html: txt };
    }catch(e){ last=e; await sleep(180+250*i); }
  }
  throw last || new Error("fetch failed (html)");
}
async function fetchJSON(url, retry=2){
  let last;
  for (let i=0;i<=retry;i++){
    try{
      const res = await fetch(url,{ headers: HDRS_JSON, redirect: "follow" });
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200)||""}`);
      return JSON.parse(txt);
    }catch(e){ last=e; await sleep(180+250*i); }
  }
  throw last || new Error("fetch failed (json)");
}

function extractNextData(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if(!m) return null;
  try{ return JSON.parse(m[1]); }catch{ return null; }
}

function* walkObjects(root){
  const stack=[root]; const seen=new Set();
  while(stack.length){
    const n=stack.pop();
    if(!n || typeof n!=="object") continue;
    if(seen.has(n)) continue;
    seen.add(n);
    yield n;
    for(const v of Object.values(n)){
      if(v && typeof v === "object") stack.push(v);
      if(Array.isArray(v)) for(const it of v) if(it && typeof it === "object") stack.push(it);
    }
  }
}

function asNum(v){ return Number.isFinite(Number(v)) ? Number(v) : null; }
function asStr(v){ return typeof v==="string" ? v : (v?.name || v?.fullName || null); }

function pickLeagueId(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      if(/(leagueid|tournamentid|competitionid)$/i.test(k)){
        const num = Number(v); if(Number.isFinite(num)) return num;
      }
    }
  } return null;
}
function pickKickoff(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      const kk = String(k).toLowerCase();
      if (/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc)$/.test(kk) && typeof v==="string"){
        const d=new Date(v); if(!isNaN(d)) return d;
      }
      if (/^(matchtime|kickoff|epoch|timestamp)$/.test(kk) && Number.isFinite(Number(v))){
        const ts = Number(v); const d=new Date(ts>1e12?ts:ts*1000); if(!isNaN(d)) return d;
      }
    }
  } return null;
}

async function fetchMatchData(matchId){
  // Try API first; fallback to HTML __NEXT_DATA__
  try{
    const j = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    return { data: j, source: "api" };
  }catch{
    const { html } = await fetchText(`https://www.fotmob.com/match/${matchId}`);
    const nd = extractNextData(html);
    if(!nd) throw new Error("NEXT_DATA not found");
    // Build a minimal container that still works with pickers
    return { data: nd, source: "next_html" };
  }
}

function collectMatchIdsFromNext(nextObj){
  const ids = new Set();
  // from dehydrated queries
  const queries = nextObj?.props?.pageProps?.dehydratedState?.queries;
  if(Array.isArray(queries)){
    for(const q of queries){
      const d=q?.state?.data;
      if(!d || typeof d!=="object") continue;
      for(const node of walkObjects(d)){
        // explicit matchId fields
        if (asNum(node?.matchId)) ids.add(String(node.matchId));
        // URLs or paths containing /match/<id>
        for(const [k,v] of Object.entries(node)){
          if(typeof v === "string"){
            const m = v.match(/\/match\/(\d{5,10})(?:\/|$)/i);
            if(m) ids.add(m[1]);
          }
        }
      }
    }
  }
  // fallback: search the entire tree
  for(const node of walkObjects(nextObj)){
    if (asNum(node?.matchId)) ids.add(String(node.matchId));
    for(const [k,v] of Object.entries(node)){
      if(typeof v === "string"){
        const m = v.match(/\/match\/(\d{5,10})(?:\/|$)/i);
        if(m) ids.add(m[1]);
      }
    }
  }
  return Array.from(ids);
}

function guessPlayerName(nextObj){
  // Try to find the player display name on the player page next data
  const pp = nextObj?.props?.pageProps;
  const name = pp?.player?.name || pp?.pagePlayer?.name || pp?.header?.playerName || pp?.meta?.title;
  if(typeof name === "string") return name;
  for(const node of walkObjects(nextObj)){
    const nm = node?.playerName || node?.name || node?.fullName;
    if(typeof nm === "string" && nm.length >= 3) return nm;
  }
  return "";
}

function findTeamId(nextObj){
  // Common locations: currentTeam.id, club.id, teamId fields
  for(const node of walkObjects(nextObj)){
    if (asNum(node?.teamId)) return Number(node.teamId);
    if (node?.currentTeam && asNum(node.currentTeam.id)) return Number(node.currentTeam.id);
    if (node?.club && asNum(node.club.id)) return Number(node.club.id);
  }
  return null;
}

async function hasPlayerInMatch(matchId, playerId){
  try{
    const { data } = await fetchMatchData(matchId);
    const lid = pickLeagueId(data);
    const dt  = pickKickoff(data);
    // league + season gate
    if (!TOP5_LEAGUE_IDS.has(Number(lid)) || !dt || dt < SEASON_START || dt > SEASON_END) return false;

    // presence check anywhere in payload
    for(const node of walkObjects(data)){
      const id = asNum(node?.playerId ?? node?.id ?? node?.player?.id);
      if (id != null && Number(id) === Number(playerId)) return true;
    }
    return false;
  }catch{
    return false;
  }
}

async function discoverForUrl(playerUrl){
  const debug = { player_next_ids:0, team_id:null, tried_urls:[], errors:[] };
  try{
    const { html } = await fetchText(playerUrl);
    const nd = extractNextData(html);
    if(!nd) throw new Error("No __NEXT_DATA__ on player page");

    const player_id = pidFromUrl(playerUrl);
    const player_name = guessPlayerName(nd) || (playerUrl.split("/").pop()||"").replace(/-/g," ");
    debug.team_id = findTeamId(nd);

    // Gather candidate match IDs from player page ND
    const ids = collectMatchIdsFromNext(nd);
    debug.player_next_ids = ids.length;

    // Verify and filter candidates by presence + league + season
    const kept = [];
    for (const mid of ids){
      // throttle implicitly via loop; FotMob can rate-limit if too many
      if (await hasPlayerInMatch(mid, player_id)) kept.push(mid);
    }

    const match_urls = kept.map(id => `https://www.fotmob.com/match/${id}`);
    return {
      ok: true,
      player_url: playerUrl,
      player_name,
      player_id,
      match_urls,
      debug
    };
  }catch(e){
    debug.errors.push(String(e));
    return { ok:false, player_url: playerUrl, player_name:"", player_id: pidFromUrl(playerUrl), match_urls:[], debug };
  }
}

export async function handler(event){
  try{
    if (event.httpMethod !== "POST"){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Provide POST { urls: [...] }" }) };
    }
    let body;
    try{ body = JSON.parse(event.body||"{}"); }catch{ return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Invalid JSON body" }) }; }
    const urls = Array.isArray(body.urls) ? body.urls.map(String).map(s=>s.trim()).filter(Boolean) : [];
    if (!urls.length){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Provide { urls: [...] }" }) };
    }

    const players = [];
    for (const u of urls){
      const one = await discoverForUrl(u);
      players.push({
        player_url: one.player_url,
        player_name: one.player_name,
        player_id: one.player_id,
        match_urls: one.match_urls || [],
        debug: one.debug || {}
      });
    }

    // Meta
    const uniqueMatches = new Set();
    for (const p of players) (p.match_urls||[]).forEach(m => uniqueMatches.add(m));
    const meta = {
      unique_matches: uniqueMatches.size,
      returned_per_player: players.reduce((a,p)=>a+(p.match_urls||[]).length,0)/(players.length||1),
      season_window: { from: "2025-07-01", to: "2026-06-30" }
    };

    return { statusCode:200, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:true, players, meta }) };
  }catch(e){
    return { statusCode:500, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:String(e) }) };
  }
}
