// netlify/functions/check.mjs
// POTM (unchanged + working) and FIXED stats for Top-5 2025–26:
//  • Goals / Penalty goals / Non-penalty goals
//  • Assists
//  • Yellow / Red (with 2nd yellow → RC+1)
//  • FMP (>=90) from minutes OR from lineups if minutes missing
//
// Key fix: when API path fails and we fall back to HTML (__NEXT_DATA__),
// we now DEEP-SCAN and ENRICH a minimal data block with:
//    - content.playerRatings (as before)
//    - content.matchFacts.{goals,cards,events}  ← newly populated
//    - content.lineups (starter/sub info)      ← newly populated
//
// You do not need to change index.html again.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0));     // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59)); // 2026-06-30

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS_JSON = { accept:"application/json","accept-language":"en-GB,en;q=0.9","user-agent":UA,referer:"https://www.fotmob.com/" };
const HDRS_HTML = { accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","user-agent":UA,referer:"https://www.fotmob.com/" };

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const norm = (s)=>String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const asNum = (v)=>Number.isFinite(Number(v)) ? Number(v) : null;
const asStr = (v)=>typeof v==="string" ? v : (v?.name || v?.fullName || null);

async function fetchJSON(url, retry=2){
  let last;
  for(let i=0;i<=retry;i++){
    try{
      const res = await fetch(url,{headers:HDRS_JSON,redirect:"follow"});
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200)||""}`);
      return JSON.parse(txt);
    }catch(e){ last=e; await sleep(200+300*i); }
  }
  throw last || new Error("fetch failed");
}
async function fetchText(url, retry=2){
  let last;
  for(let i=0;i<=retry;i++){
    try{
      const res = await fetch(url,{headers:HDRS_HTML,redirect:"follow"});
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if(!txt) throw new Error("Empty HTML");
      return { finalUrl: res.url || url, html: txt };
    }catch(e){ last=e; await sleep(200+300*i); }
  }
  throw last || new Error("fetch failed (html)");
}

function extractFirstNumericIdFromPath(path=""){
  const m = path.match(/\/match\/(\d{5,10})(?:\/|$)/i);
  return m ? m[1] : null;
}
async function resolveMatchIdFromUrl(urlStr){
  try{
    const u = new URL(urlStr);
    const id = extractFirstNumericIdFromPath(u.pathname);
    if(id) return { matchId:id, finalUrl:urlStr, html:null };
    const { finalUrl, html } = await fetchText(urlStr);
    const id2 = extractFirstNumericIdFromPath(new URL(finalUrl).pathname);
    if(id2) return { matchId:id2, finalUrl, html };
    let m = html.match(/"matchId"\s*:\s*(\d{5,10})/i);
    if(m) return { matchId:m[1], finalUrl, html };
    m = html.match(/\/match\/(\d{5,10})/i);
    if(m) return { matchId:m[1], finalUrl, html };
    return { matchId:null, finalUrl, html };
  }catch{ return { matchId:null, finalUrl:urlStr, html:null }; }
}

// ---------- generic walkers / pickers ----------
function* walkObjects(root){
  const stack=[root]; const seen=new Set();
  while(stack.length){
    const n=stack.pop();
    if(!n || typeof n!=="object") continue;
    if(seen.has(n)) continue; seen.add(n);
    yield n;
    for(const v of Object.values(n)){
      if(v && typeof v==="object") stack.push(v);
      if(Array.isArray(v)) for(const it of v) if(it && typeof it==="object") stack.push(it);
    }
  }
}
function ratingsFromJson(json){
  function coerce(p){
    if(!p || typeof p!=="object") return null;
    const id = p?.id ?? p?.playerId ?? p?.player?.id ?? null;
    const name = p?.name ?? p?.playerName ?? p?.player?.name ?? "";
    let rating = NaN;
    if(p?.rating!=null) rating=Number(p.rating);
    else if(p?.stats?.rating!=null) rating=Number(p.stats.rating);
    else if(p?.playerRating!=null) rating=Number(p.playerRating);
    return (name || id!=null) ? { id, name, rating, raw:p } : null;
  }
  const out=[];
  const pushArr=(arr)=>{ if(!Array.isArray(arr)) return; for(const it of arr){ const row=coerce(it); if(row) out.push(row);} };
  pushArr(json?.content?.playerRatings?.home?.players);
  pushArr(json?.content?.playerRatings?.away?.players);
  pushArr(json?.playerRatings?.home?.players);
  pushArr(json?.playerRatings?.away?.players);
  for(const n of walkObjects(json)){
    for(const [k,v] of Object.entries(n)){
      if(Array.isArray(v) && v.length && v.some(x=>x && typeof x==="object" && (("rating" in x) || ("playerRating" in x) || (x.stats && typeof x.stats==="object" && "rating" in x.stats))))
        pushArr(v);
    }
  }
  return out;
}
function pickLeagueId(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      if(/(leagueid|tournamentid|competitionid)$/i.test(k)){ const num=Number(v); if(Number.isFinite(num)) return num; }
    }
  }
  return null;
}
function pickLeagueName(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      if(/(leaguename|tournamentname|competitionname)$/i.test(k) && typeof v==="string") return v;
    }
  }
  return null;
}
function pickKickoff(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      const kk = k.toLowerCase();
      if(/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc)$/.test(kk) && typeof v==="string"){ const d=new Date(v); if(!isNaN(d)) return d; }
      if(/^(matchtime|kickoff|epoch|timestamp)$/.test(kk) && Number.isFinite(Number(v))){ const ts=Number(v); const d=new Date(ts>1e12?ts:ts*1000); if(!isNaN(d)) return d; }
    }
  }
  return null;
}
function explicitPOTM(obj){
  for(const n of walkObjects(obj)){
    if(n.playerOfTheMatch && (n.playerOfTheMatch.id!=null || n.playerOfTheMatch.name || n.playerOfTheMatch.fullName)) return n.playerOfTheMatch;
    if(n.matchFacts && n.matchFacts.playerOfTheMatch){
      const p=n.matchFacts.playerOfTheMatch;
      if(p && (p.id!=null || p.name || p.fullName)) return p;
    }
  }
  return null;
}
function deriveTitle(obj, html){
  const g=obj?.general;
  if(g?.matchName) return g.matchName;
  const ht=g?.homeTeam?.name || obj?.homeTeam?.name || "";
  const at=g?.awayTeam?.name || obj?.awayTeam?.name || "";
  if(ht || at) return `${ht||"?"} vs ${at||"?"}`;
  if(html){ const m=html.match(/<title>([^<]+)<\/title>/i); if(m) return m[1].replace(/\s+/g," ").trim(); }
  return "vs";
}

// ---------- HTML fallback: build matchFacts + lineups ----------
function extractNextDataString(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(s){ try{ return JSON.parse(s);}catch{ return null; } }

function buildEnrichedFromNext(root){
  const ratings = ratingsFromJson(root);
  const potm = explicitPOTM(root);
  const leagueId = pickLeagueId(root);
  const leagueName = pickLeagueName(root);
  const kickoff = pickKickoff(root);

  // Collect goals/cards/lineups from ANYWHERE in the tree (strict filters)
  const goals=[], cards=[];
  let lineups=null;

  const pushIf = (arr,val)=>{ if(val && typeof val==="object") arr.push(val); };
  const isGoalish = (e)=>{
    if(!e || typeof e!=="object") return false;
    const t = String(e.type || e.eventType || e.goalType || "").toLowerCase();
    return t.includes("goal") || !!(e.scorer || e.goalScorer || e.playerId) || e.goal===true;
  };
  const isCardish = (e)=>{
    if(!e || typeof e!=="object") return false;
    const t = String(e.card || e.cardType || e.type || e.eventType || "").toLowerCase();
    return t.includes("yellow") || t.includes("red");
  };

  for(const node of walkObjects(root)){
    // lineups: first object that carries starting/sub flags or looks like a lineup container
    if(!lineups){
      if(node?.lineups || node?.lineup || node?.content?.lineups){
        lineups = node?.lineups || node?.content?.lineups || node?.lineup;
      } else if (node && typeof node==="object" && (("isStarting" in node) || ("subbedIn" in node) || ("subbedOut" in node))) {
        // pack a minimal lineup from scattered nodes
        lineups = lineups || { blobs: [] };
      }
      if(lineups && lineups.blobs) lineups.blobs.push(node);
    }

    for(const [k,v] of Object.entries(node)){
      if(!Array.isArray(v) || !v.length || typeof v[0]!=="object") continue;

      const key = k.toLowerCase();

      // goals / scorers arrays
      if(/^goals?$/.test(key) || /^scorers?$/.test(key)){
        for(const e of v) if(isGoalish(e)) pushIf(goals, e);
        continue;
      }
      // cards / bookings arrays
      if(/^cards$/.test(key) || /^bookings$/.test(key)){
        for(const e of v) if(isCardish(e)) pushIf(cards, e);
        continue;
      }
      // generic events/timeline/incidents: filter strictly
      if(/^(events|incidents|timeline|summary)$/i.test(key)){
        for(const e of v){
          if(isGoalish(e)) pushIf(goals, e);
          else if(isCardish(e)) pushIf(cards, e);
        }
      }
    }
  }

  // Minimal dedupe by JSON string (ok for our use)
  const uniq = (arr)=>Array.from(new Map(arr.map(o=>[JSON.stringify(o),o])).values());

  return {
    general: { leagueId, leagueName, matchTimeUTC: kickoff ? kickoff.toISOString() : null, playerOfTheMatch: potm || null },
    content: {
      playerRatings: ratings.length ? { home:{players:[]}, away:{players:ratings} } : undefined,
      matchFacts: { goals: uniq(goals), cards: uniq(cards) },
      lineups
    }
  };
}

async function nextFallbackJSON(matchUrl, knownHtml){
  const { html } = knownHtml ? { finalUrl:matchUrl, html:knownHtml } : await fetchText(matchUrl);
  const nd = extractNextDataString(html);
  if(!nd) throw new Error("NEXT_DATA not found in HTML");
  const obj = safeJSON(nd);
  if(!obj) throw new Error("NEXT_DATA JSON parse failed");
  const enriched = buildEnrichedFromNext(obj);
  return { data: enriched, html, source:"next_html" };
}

// ---------- strict parsers over (API or enriched) data ----------
function findMatchFactsNode(data){
  if (data?.content?.matchFacts) return data.content.matchFacts;
  if (data?.matchFacts) return data.matchFacts;
  for(const n of walkObjects(data)){
    if(n && typeof n==="object" && (n.goals || n.cards || n.bookings)) return n;
  }
  return null;
}
function extractGoalsStrict(mf){
  const arrs=[];
  for(const [k,v] of Object.entries(mf||{})){
    if(Array.isArray(v) && v.length && typeof v[0]==="object" && (/^goals?$|^scorers?$/i.test(k))){
      arrs.push(v);
    }
  }
  if(!arrs.length){
    // fall back to events-like arrays inside matchFacts
    for(const [k,v] of Object.entries(mf||{})){
      if(Array.isArray(v) && v.length && typeof v[0]==="object" && /^(events|incidents|timeline)$/i.test(k)){
        arrs.push(v.filter(e=>{
          const t=String(e.type||e.eventType||e.goalType||"").toLowerCase();
          return t.includes("goal") || e.goal===true || e.scorer || e.goalScorer;
        }));
      }
    }
  }
  const out=[];
  const pushIf=(o)=>{ if(o) out.push(o); };
  for(const a of arrs){
    for(const e of a){
      const scorerId = asNum(e?.scorer?.id) ?? asNum(e?.playerId) ?? asNum(e?.mainPlayerId) ?? asNum(e?.player?.id) ?? asNum(e?.goalScorer?.id);
      const scorerName = asStr(e?.scorer) || asStr(e?.player) || asStr(e?.playerName) || asStr(e?.mainPlayer) || asStr(e?.goalScorer);
      const assistId = asNum(e?.assist?.id) ?? asNum(e?.assistId) ?? asNum(e?.assist1?.id);
      const assistName = asStr(e?.assist) || asStr(e?.assistName) || asStr(e?.assist1);
      const t = String(e?.type || e?.eventType || e?.goalType || "").toLowerCase();
      const d = String(e?.detail || e?.reason || e?.description || "").toLowerCase();
      const penalty = !!(e?.isPenalty || t.includes("pen") || d.includes("penalty"));
      const own = !!(t.includes("own") || d.includes("own goal"));
      pushIf({ scorerId, scorerName, assistId, assistName, penalty, own });
    }
  }
  // de-dupe rough
  return Array.from(new Map(out.map(o=>[JSON.stringify(o),o])).values());
}
function extractCardsStrict(mf){
  const arrs=[];
  for(const [k,v] of Object.entries(mf||{})){
    if(Array.isArray(v) && v.length && typeof v[0]==="object" && (/^cards$|^bookings$/i.test(k))){
      arrs.push(v);
    }
  }
  if(!arrs.length){
    for(const [k,v] of Object.entries(mf||{})){
      if(Array.isArray(v) && v.length && typeof v[0]==="object" && /^(events|incidents|timeline)$/i.test(k)){
        arrs.push(v.filter(e=>{
          const t=String(e.card||e.cardType||e.type||e.eventType||"").toLowerCase();
          return t.includes("yellow") || t.includes("red");
        }));
      }
    }
  }
  const out=[];
  for(const a of arrs){
    for(const e of a){
      const t=String(e.card||e.cardType||e.type||e.eventType||"").toLowerCase();
      const kind = t.includes("yellow") ? (t.includes("second") ? "second_yellow" : "yellow") : (t.includes("red") ? "red" : null);
      if(!kind) continue;
      const playerId = asNum(e?.playerId) ?? asNum(e?.player?.id) ?? asNum(e?.mainPlayerId);
      const playerName = asStr(e?.player) || asStr(e?.playerName) || asStr(e?.mainPlayer);
      out.push({ playerId, playerName, kind });
    }
  }
  return out;
}

// minutes / FMP
function minutesFromPlayerRow(row){
  return asNum(row?.minutesPlayed) ?? asNum(row?.minsPlayed) ??
         asNum(row?.playedMinutes) ?? asNum(row?.timeOnPitch) ??
         asNum(row?.timePlayed) ?? asNum(row?.stats?.minutesPlayed) ??
         asNum(row?.stats?.minsPlayed) ?? asNum(row?.performance?.minutesPlayed);
}
function inferFMPFromLineups(container, playerId, playerName){
  if(!container) return null;
  const nName = norm(playerName||"");
  let started=false, subOut=null;

  // Try common shapes quickly
  const candidateLists=[];
  for(const [k,v] of Object.entries(container)){
    if(Array.isArray(v)) candidateLists.push(v);
    else if (v && typeof v==="object"){
      for(const [kk,vv] of Object.entries(v)) if(Array.isArray(vv)) candidateLists.push(vv);
    }
  }
  const parseMinuteStr=(s)=>{ if(s==null) return null; if(typeof s==="number") return s; const m=String(s).match(/^(\d+)(?:\+(\d+))?/); return m ? Number(m[1])+(m[2]?Number(m[2]):0) : null; };

  for(const list of candidateLists){
    for(const p of list){
      if(!p || typeof p!=="object") continue;
      const id = asNum(p?.id ?? p?.playerId ?? p?.player?.id);
      const nm = asStr(p?.name ?? p?.playerName ?? p?.player);
      const isMe = (playerId!=null && id===playerId) || (!!nName && nm && norm(nm)===nName);
      if(!isMe) continue;

      if(p?.isStarting===true || p?.starter===true || p?.isSubstitute===false) started=true;
      const outMin = parseMinuteStr(p?.subbedOutExpandedTime) ?? asNum(p?.subbedOut) ?? asNum(p?.subOff);
      if(outMin!=null) subOut = Math.max(subOut??0, outMin);
    }
  }
  if(!started) return null;
  if(subOut==null) return true;
  return subOut >= 90;
}

// ---------- handler ----------
export async function handler(event){
  try{
    let payload={};
    if(event.httpMethod==="POST"){
      try{ payload = JSON.parse(event.body||"{}"); }
      catch{ return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Invalid JSON body" }) }; }
    }else{
      payload = {
        playerId: Number(event.queryStringParameters?.playerId || NaN),
        playerName: event.queryStringParameters?.playerName || "",
        matchUrl: event.queryStringParameters?.matchUrl || ""
      };
    }

    const playerId = Number(payload.playerId || NaN);
    const playerName = String(payload.playerName || "").trim();
    const matchUrl = String(payload.matchUrl || "").trim();

    if(!matchUrl || (!playerName && !Number.isFinite(playerId))){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Provide { playerId or playerName, matchUrl }" }) };
    }

    const { matchId, finalUrl, html: maybeHtml } = await resolveMatchIdFromUrl(matchUrl);
    if(!matchId){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    // 1) API fast path
    let data=null, htmlUsed=maybeHtml, source="api";
    try{
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    }catch{
      // 2) HTML fallback with ENRICHED content
      const fb = await nextFallbackJSON(finalUrl, maybeHtml || null);
      data = fb.data; htmlUsed = fb.html; source = fb.source || "next_html";
    }

    // --- gates ---
    const league_id = pickLeagueId(data);
    const league_label = pickLeagueName(data) || null;
    const league_allowed = league_id != null && TOP5_LEAGUE_IDS.has(Number(league_id));
    const dt = pickKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt >= SEASON_START && dt <= SEASON_END) : false;

    // ratings + POTM (unchanged)
    const ratings = ratingsFromJson(data);
    const pidOK = Number.isFinite(playerId);
    const nPlayer = norm(playerName);
    const me = ratings.find(r => (pidOK && Number(r.id)===playerId) || (!!nPlayer && r.name && norm(r.name)===nPlayer)) || null;
    const explicitP = data?.general?.playerOfTheMatch ?? data?.content?.matchFacts?.playerOfTheMatch ?? null;
    const potm = explicitP || (ratings.length ? (()=>{ const rs=[...ratings].sort((a,b)=>Number(b.rating||0)-Number(a.rating||0)); return rs[0] ? { id:rs[0].id ?? null, name:rs[0].name ?? null, fullName:rs[0].fullName ?? null, by:"max_rating_fallback", rating:rs[0].rating ?? null } : null; })() : null);
    const potmNameText = potm ? (potm.fullName || potm.name || "") : "";
    const player_is_pom = potm ? ((pidOK && Number(potm.id)===playerId) || (!!nPlayer && potmNameText && norm(potmNameText)===nPlayer)) : false;

    const match_title = deriveTitle(data, htmlUsed);

    // --- stats ---
    // (A) Try player's own ratings row first
    let goals=null, penGoals=null, assists=null, yc=null, rc=null, minutes=null;
    if(me && me.raw){
      const r = me.raw;
      const firstNum=(paths)=>{ for(const p of paths){ let cur=r; for(const k of p.split(".")){ if(!cur || typeof cur!=="object"){ cur=null; break; } cur=cur[k]; } const n=asNum(cur); if(n!=null) return n; } return null; };
      goals    = firstNum(["goals","stats.goals","offensive.goals","summary.goals"]);
      penGoals = firstNum(["penaltyGoals","stats.penaltyGoals","penalties.scored","penaltiesGoals","stats.penaltiesScored","stats.penaltyScored"]);
      assists  = firstNum(["assists","stats.assists","offensive.assists","summary.assists"]);
      const rcStraight = firstNum(["redCards","stats.redCards","cards.red","discipline.red","summary.redCards"]) || 0;
      const rc2nd      = firstNum(["secondYellow","stats.secondYellow","cards.secondYellow","discipline.secondYellow","summary.secondYellow"]) || 0;
      rc       = (rcStraight || 0) + (rc2nd || 0);
      yc       = firstNum(["yellowCards","stats.yellowCards","cards.yellow","discipline.yellow","summary.yellowCards"]);
      minutes  = minutesFromPlayerRow(r);
    }

    // (B) Strict matchFacts fallback (from API OR from enriched HTML)
    const mf = findMatchFactsNode(data);
    if(mf){
      if(goals==null || penGoals==null || assists==null){
        const gl = extractGoalsStrict(mf);
        const isMe=(id,nm)=> (pidOK && id!=null && Number(id)===playerId) || (!!nPlayer && nm && norm(nm)===nPlayer);
        let g=0, pg=0, ast=0;
        for(const e of gl){
          if(e.own) continue;
          if(isMe(e.scorerId, e.scorerName)){ g++; if(e.penalty) pg++; }
          if(isMe(e.assistId, e.assistName)) ast++;
        }
        if(goals==null) goals=g;
        if(penGoals==null) penGoals=pg;
        if(assists==null) assists=ast;
      }
      if(yc==null || rc==null){
        const cs = extractCardsStrict(mf);
        const isMe=(id,nm)=> (pidOK && id!=null && Number(id)===playerId) || (!!nPlayer && nm && norm(nm)===nPlayer);
        let y=0, r=0;
        for(const c of cs){
          if(!isMe(c.playerId, c.playerName)) continue;
          if(c.kind==="yellow") y++;
          else if(c.kind==="second_yellow"){ y++; r++; }
          else if(c.kind==="red") r++;
        }
        if(yc==null) yc=y;
        if(rc==null) rc=r;
      }
    }

    // (C) Minutes / FMP finalization
    if(minutes==null){
      const f = inferFMPFromLineups(data?.content?.lineups || data?.lineups, playerId, playerName);
      if(f!=null){ minutes = f ? 90 : null; } // set to 90 if we can assert full match
      if(minutes==null){
        // last sweep: any minutes field on any matching player object
        for(const n of walkObjects(data)){
          const id = asNum(n?.id ?? n?.playerId ?? n?.player?.id);
          const nm = asStr(n?.name ?? n?.playerName ?? n?.player);
          const ok = (pidOK && id===playerId) || (!!playerName && nm && norm(nm)===norm(playerName));
          if(!ok) continue;
          const cand = minutesFromPlayerRow(n) ?? asNum(n?.minutes) ?? asNum(n?.timeOnPitch) ?? asNum(n?.timePlayed);
          if(cand!=null){ minutes=cand; break; }
        }
      }
    }
    const full_match_played = minutes!=null ? (Number(minutes)>=90) : false;

    const nonPenGoals = Number(goals||0) - Number(penGoals||0);

    return {
      statusCode:200,
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({
        match_url: matchUrl,
        resolved_match_id: String(matchId),
        match_title,
        league_id, league_label, match_datetime_utc,
        league_allowed, within_season_2025_26,
        player_is_pom,
        player_rating: me?.rating ?? null,
        max_rating: ratings.length ? Math.max(...ratings.map(r=>Number(r.rating||0))) : null,
        potm_name: potm || null,
        potm_name_text: potmNameText,
        potm_id: potm?.id ?? null,
        player_stats: {
          goals: Number(goals||0),
          penalty_goals: Number(penGoals||0),
          non_penalty_goals: Number(nonPenGoals||0),
          assists: Number(assists||0),
          yellow_cards: Number(yc||0),
          red_cards: Number(rc||0),
          minutes_played: minutes==null?null:Number(minutes),
          full_match_played
        },
        source
      })
    };
  }catch(e){
    return { statusCode:500, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:String(e) }) };
  }
}
