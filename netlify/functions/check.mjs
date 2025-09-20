// netlify/functions/check.mjs
// Per-match checker: POTM + (goals, PG, NPG, assists, YC, RC, minutes/FMP) for Top-5 leagues, 2025–26.
// Counts ONLY from per-match events (plus shotmaps fallback) to avoid season-total bleed.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const LEAGUE_LABELS = { 47:"Premier League", 87:"LaLiga", 54:"Bundesliga", 55:"Serie A", 53:"Ligue 1" };
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30 23:59:59

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_HTML = { accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "user-agent":UA, referer:"https://www.fotmob.com/" };
const HDRS_JSON = { accept:"application/json", "user-agent":UA, referer:"https://www.fotmob.com/" };

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const norm=(s)=>String(s??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").trim();
const canon=(s)=>norm(s).toLowerCase().replace(/[^a-z]/g,"");
const sameName=(a,b)=>{
  if(!a||!b) return false;
  let A=canon(a).replace(/jr$/,"junior"), B=canon(b).replace(/jr$/,"junior");
  if(A===B) return true;
  const p=(s)=>s.startsWith("vini")||s.startsWith("vinici");
  return p(A)&&p(B);
};
const asNum=(v)=>Number.isFinite(Number(v))?Number(v):null;
const asStr=(v)=>typeof v==="string"?v:(v?.name||v?.fullName||null);
const parseMinuteStr=(s)=>{ if(s==null) return null; if(typeof s==="number") return s; const m=String(s).match(/^(\d{1,3})(?:\+(\d{1,2}))?/); return m?Number(m[1])+(m[2]?Number(m[2]):0):null; };

async function fetchJSON(url, retry=2){
  let last; for(let i=0;i<=retry;i++){
    try{ const r=await fetch(url,{headers:HDRS_JSON,redirect:"follow"}); const t=await r.text(); if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} :: ${t?.slice(0,180)||""}`); return JSON.parse(t); }
    catch(e){ last=e; await sleep(180+250*i); }
  } throw last||new Error("fetch failed");
}
async function fetchText(url, retry=2){
  let last; for(let i=0;i<=retry;i++){
    try{ const r=await fetch(url,{headers:HDRS_HTML,redirect:"follow"}); const t=await r.text(); if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`); if(!t) throw new Error("Empty HTML"); return { finalUrl:r.url||url, html:t }; }
    catch(e){ last=e; await sleep(180+250*i); }
  } throw last||new Error("fetch failed (html)");
}

function extractIdFromPath(p=""){ const m=p.match(/\/match\/(\d{5,10})(?:\/|$)/i); return m?m[1]:null; }
async function resolveMatchIdFromUrl(uStr){
  try{
    const u=new URL(uStr); const id=extractIdFromPath(u.pathname);
    if(id) return { matchId:id, finalUrl:uStr, html:null };
    const { finalUrl, html }=await fetchText(uStr);
    const id2=extractIdFromPath(new URL(finalUrl).pathname);
    if(id2) return { matchId:id2, finalUrl, html };
    const m=html.match(/"matchId"\s*:\s*(\d{5,10})/i) || html.match(/\/match\/(\d{5,10})/i);
    return { matchId:m?m[1]:null, finalUrl, html };
  }catch{ return { matchId:null, finalUrl:uStr, html:null }; }
}

// walk any JSON
function* walk(root){
  const st=[root], seen=new Set();
  while(st.length){
    const n=st.pop();
    if(!n||typeof n!=="object") continue;
    if(seen.has(n)) continue; seen.add(n); yield n;
    for(const v of Object.values(n)){
      if(v&&typeof v==="object") st.push(v);
      if(Array.isArray(v)) for(const it of v) if(it&&typeof it==="object") st.push(it);
    }
  }
}
// ratings
function ratingsFromJson(json){
  const out=[];
  const co=(p)=>{
    if(!p||typeof p!=="object") return null;
    const id=p?.id ?? p?.playerId ?? p?.player?.id ?? null;
    const name=p?.name ?? p?.playerName ?? p?.player?.name ?? "";
    let rating=null;
    if(p?.rating!=null) rating=Number(p.rating);
    else if(p?.stats?.rating!=null) rating=Number(p.stats.rating);
    else if(p?.playerRating!=null) rating=Number(p.playerRating);
    return (name || id!=null)?{id,name,rating}:null;
  };
  const push=(arr)=>{ if(Array.isArray(arr)) for(const it of arr){ const r=co(it); if(r) out.push(r);} };
  push(json?.content?.playerRatings?.home?.players);
  push(json?.content?.playerRatings?.away?.players);
  push(json?.playerRatings?.home?.players);
  push(json?.playerRatings?.away?.players);
  for(const n of walk(json)){
    for(const [k,v] of Object.entries(n)){
      if(Array.isArray(v) && v.some(x=>x && typeof x==="object" && ("rating" in x || "playerRating" in x || (x.stats && x.stats.rating!=null))))
        push(v);
    }
  }
  return out;
}
// league & kickoff pickers
function pickLeagueId(obj){
  for(const n of walk(obj)) for(const [k,v] of Object.entries(n))
    if(/(leagueid|tournamentid|competitionid)$/i.test(k)){ const num=Number(v); if(Number.isFinite(num)) return num; }
  return null;
}
function pickLeagueName(obj){
  for(const n of walk(obj)) for(const [k,v] of Object.entries(n))
    if(/(leaguename|tournamentname|competitionname)$/i.test(k) && typeof v==="string") return v;
  return null;
}
function pickKickoff(obj){
  for(const n of walk(obj)){
    for(const [k,v] of Object.entries(n)){
      const kk=String(k).toLowerCase();
      if(/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc)$/.test(kk) && typeof v==="string"){ const d=new Date(v); if(!isNaN(d)) return d; }
      if(/^(matchtime|kickoff|epoch|timestamp)$/.test(kk) && Number.isFinite(Number(v))){ const ts=Number(v), d=new Date(ts>1e12?ts:ts*1000); if(!isNaN(d)) return d; }
    }
  } return null;
}
// title
function titleFrom(obj, html){
  const g=obj?.general;
  const ht=g?.homeTeam?.name || obj?.homeTeam?.name || "";
  const at=g?.awayTeam?.name || obj?.awayTeam?.name || "";
  if(g?.matchName) return g.matchName;
  if(ht||at) return `${ht||"?"} vs ${at||"?"}`;
  if(html){ const m=html.match(/<title>([^<]+)<\/title>/i); if(m) return m[1].replace(/\s+/g," ").trim(); }
  return "vs";
}

// NEXT fallback
function nextDataStr(html){ const m=html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i); return m?m[1]:null; }
const safeJSON=(s)=>{ try{return JSON.parse(s);}catch{return null;} };
function mergeUnique(dst, src){ if(!Array.isArray(src)) return; const key=o=>JSON.stringify(o); const seen=new Set(dst.map(key)); for(const o of src){ const k=key(o); if(!seen.has(k)){ seen.add(k); dst.push(o); } } }
function buildFromNext(root){
  const out={ general:{}, content:{ matchFacts:{ goals:[], cards:[], events:[] }, lineups:null }, playerRatings:null };
  const queries=root?.props?.pageProps?.dehydratedState?.queries;
  const harvestMF=(mf)=>{ if(!mf||typeof mf!=="object") return;
    for(const [k,v] of Object.entries(mf)){ const key=String(k).toLowerCase();
      if(Array.isArray(v)){
        if(/^goals?$|^scorers?$/.test(key)) mergeUnique(out.content.matchFacts.goals,v);
        else if(/^cards$|^bookings$/.test(key)) mergeUnique(out.content.matchFacts.cards,v);
        else if(/^(events|incidents|timeline|summary)$/.test(key)) mergeUnique(out.content.matchFacts.events,v);
      }
    }
  };
  if(Array.isArray(queries)){
    for(const q of queries){
      const d=q?.state?.data; if(!d||typeof d!=="object") continue;
      const rs=ratingsFromJson(d); if(rs.length) out.playerRatings = [...(out.playerRatings||[]), ...rs];
      harvestMF(d?.content?.matchFacts || d?.matchFacts);
      const lu=d?.content?.lineups || d?.lineups || d?.formations || null; if(lu && !out.content.lineups) out.content.lineups=lu;
      out.general.playerOfTheMatch = out.general.playerOfTheMatch || d?.general?.playerOfTheMatch || d?.playerOfTheMatch || null;
      out.general.leagueId = out.general.leagueId ?? pickLeagueId(d);
      out.general.leagueName = out.general.leagueName || pickLeagueName(d) || null;
      out.general.matchTimeUTC = out.general.matchTimeUTC || (pickKickoff(d)?.toISOString?.() || null);
    }
  }
  if(!out.playerRatings){ const rs=ratingsFromJson(root); if(rs.length) out.playerRatings=rs; }
  harvestMF(root?.content?.matchFacts || root?.matchFacts);
  out.general.playerOfTheMatch = out.general.playerOfTheMatch || null;
  out.general.leagueId = out.general.leagueId ?? pickLeagueId(root);
  out.general.leagueName = out.general.leagueName || pickLeagueName(root) || null;
  out.general.matchTimeUTC = out.general.matchTimeUTC || (pickKickoff(root)?.toISOString?.() || null);
  return out;
}
async function nextFallbackJSON(matchUrl, knownHtml){
  const { html } = knownHtml ? { finalUrl:matchUrl, html:knownHtml } : await fetchText(matchUrl);
  const s=nextDataStr(html); if(!s) throw new Error("NEXT_DATA not found in HTML");
  const obj=safeJSON(s); if(!obj) throw new Error("NEXT_DATA JSON parse failed");
  const enriched=buildFromNext(obj);
  return { data: enriched, html, source:"next_html" };
}

// ---- robust event collectors ----
function uniqueByJSON(arr){ const seen=new Set(); const out=[]; for(const o of arr){ const k=JSON.stringify(o); if(!seen.has(k)){ seen.add(k); out.push(o); } } return out; }

function collectGoalsFromMatchFacts(mf){
  const out=[];
  const normAssist = (e) => {
    const cand = e?.assist ?? e?.assists ?? e?.assist1 ?? e?.assistPlayer ?? e?.secondaryPlayer ?? null;
    if (Array.isArray(cand) && cand.length){
      const p = cand[0];
      return { id: asNum(p?.id ?? p?.playerId), name: asStr(p?.name ?? p?.playerName) };
    }
    if (cand && typeof cand === 'object'){
      return { id: asNum(cand.id ?? cand.playerId), name: asStr(cand.name ?? cand.playerName) };
    }
    return { id: asNum(e?.assistId), name: asStr(e?.assistName) };
  };
  const isGoalish = (e) => {
    const t = String(e?.type || e?.eventType || e?.goalType || '').toLowerCase();
    return t.includes('goal') || e?.goal === true || e?.scorer || e?.goalScorer;
  };
  const pushOne = (e) => {
    const scorerId   = asNum(e?.scorer?.id) ?? asNum(e?.scorerId) ?? asNum(e?.playerId) ?? asNum(e?.player?.id) ?? asNum(e?.goalScorer?.id);
    const scorerName = asStr(e?.scorer) || asStr(e?.scorerName) || asStr(e?.player) || asStr(e?.playerName) || asStr(e?.goalScorer);
    const A = normAssist(e);
    const t = String(e?.type || e?.eventType || e?.goalType || '').toLowerCase();
    const penalty = !!(e?.isPenalty || e?.penalty === true || t.includes('penalt'));
    const own     = !!(e?.isOwnGoal || t.includes('own'));
    out.push({ scorerId, scorerName, assistId: A.id ?? null, assistName: A.name ?? null, penalty, own });
  };
  for (const [k,v] of Object.entries(mf || {})){
    if (!Array.isArray(v)) continue;
    const key = String(k).toLowerCase();
    if (/^goals?$|^scorers?$/.test(key)) v.forEach(e => e && pushOne(e));
    if (/^(events|incidents|timeline|summary)$/.test(key)) v.forEach(e => { if (e && isGoalish(e)) pushOne(e); });
  }
  return uniqueByJSON(out);
}

function collectShotmapGoals(root){
  const out = [];
  for (const node of walk(root)){
    for (const [k, v] of Object.entries(node)){
      if (!Array.isArray(v) || !v.length) continue;
      const key = String(k).toLowerCase();
      if (!key.includes('shot')) continue;
      for (const s of v){
        if (!s || typeof s !== 'object') continue;
        const isGoal = !!(s.isGoal || s.goal === true);
        if (!isGoal) continue;
        const penalty = !!(s.isPenalty || String(s?.situation || '').toLowerCase().includes('pen'));
        const own = !!s.isOwnGoal;
        const scorerId   = asNum(s?.playerId ?? s?.player?.id ?? s?.scorerId);
        const scorerName = asStr(s?.player ?? s?.playerName ?? s?.scorer);
        const assistId   = asNum(s?.assistId ?? s?.assist?.id);
        const assistName = asStr(s?.assist ?? s?.assistName);
        out.push({ scorerId, scorerName, assistId, assistName, penalty, own });
      }
    }
  }
  return uniqueByJSON(out);
}

function collectCardsStrict(mf){
  const out=[];
  const push=(e,kind)=>{
    const playerId=asNum(e?.playerId) ?? asNum(e?.player?.id);
    const playerName=asStr(e?.player)||asStr(e?.playerName);
    out.push({ playerId, playerName, kind });
  };
  for (const [k,v] of Object.entries(mf||{})){
    if (!Array.isArray(v)) continue;
    const key=String(k).toLowerCase();
    if (/^cards$|^bookings$/.test(key)){
      for (const e of v){
        const t=String(e?.card||e?.cardType||e?.type||'').toLowerCase();
        if (t.includes('yellow')) push(e, t.includes('second') ? 'second_yellow' : 'yellow');
        else if (t.includes('red')) push(e, 'red');
      }
    }
    if(/^(events|incidents|timeline|summary)$/.test(key)){
      for (const e of v){
        const t=String(e?.card||e?.cardType||e?.type||e?.eventType||'').toLowerCase();
        if (t.includes('yellow')) push(e, t.includes('second') ? 'second_yellow' : 'yellow');
        else if (t.includes('red')) push(e, 'red');
      }
    }
  }
  return out;
}

// minutes (avoid season totals > 130)
function minutesFromStatsRows(root, playerId, playerName){
  let best=null;
  for(const node of walk(root)){
    const id=asNum(node?.playerId ?? node?.id ?? node?.player?.id);
    const nm=asStr(node?.playerName ?? node?.name ?? node?.player);
    const me = (Number.isFinite(playerId) && id===playerId) || sameName(nm, playerName);
    if(!me) continue;
    const cand =
      asNum(node?.minutesPlayed) ?? asNum(node?.minsPlayed) ?? asNum(node?.playedMinutes) ??
      asNum(node?.timeOnPitch) ?? asNum(node?.timePlayed) ??
      asNum(node?.stats?.minutesPlayed) ?? asNum(node?.stats?.minsPlayed);
    if(cand!=null && cand<=130) best = Math.max(best??0, cand);
  }
  return best;
}
function fmpFromLineups(lineups, playerId, playerName){
  if(!lineups) return null;
  let started=false, subOut=null;
  const me=(id,nm)=> (Number.isFinite(playerId)&&id!=null&&Number(id)===Number(playerId))||sameName(nm, playerName);

  const lists=[];
  for(const [k,v] of Object.entries(lineups)){
    if(Array.isArray(v)) lists.push(v);
    else if(v && typeof v==="object") for(const [kk,vv] of Object.entries(v)) if(Array.isArray(vv)) lists.push(vv);
  }
  for(const list of lists){
    for(const p of list){
      if(!p||typeof p!=="object") continue;
      const id=asNum(p?.id ?? p?.playerId ?? p?.player?.id);
      const nm=asStr(p?.name ?? p?.playerName ?? p?.player);
      if(!me(id,nm)) continue;
      if(p?.isStarting===true || p?.starter===true || p?.isSubstitute===false || p?.position==="Starting XI") started=true;
      const outMin =
        parseMinuteStr(p?.substitutedOutExpandedTime) ??
        parseMinuteStr(p?.subbedOutExpandedTime) ??
        asNum(p?.substitutedOut) ?? asNum(p?.subbedOut) ?? asNum(p?.subOff) ??
        parseMinuteStr(p?.offTime) ?? parseMinuteStr(p?.outTime);
      if(outMin!=null) subOut=Math.max(subOut??0, outMin);
    }
  }
  if(!started) return null;
  if(subOut==null) return true;
  return subOut>=90;
}
function minutesFromSubs(mf, playerId, playerName){
  if(!mf) return null;
  const pools=[]
    .concat(Array.isArray(mf.events)?mf.events:[])
    .concat(Array.isArray(mf.timeline)?mf.timeline:[])
    .concat(Array.isArray(mf.summary)?mf.summary:[]);
  if(!pools.length) return null;
  const me=(id,nm)=> (Number.isFinite(playerId)&&id!=null&&Number(id)===Number(playerId))||sameName(nm, playerName);
  let inMin=null,outMin=null;
  for(const e of pools){
    const t=String(e?.type||e?.eventType||"").toLowerCase(); if(!t.includes("sub")) continue;
    const minute=parseMinuteStr(e?.minute||e?.time||e?.elapsed||e?.clock||e?.minuteStr||e?.timeStr);
    const pIn=e?.playerIn||e?.playerOn||e?.inPlayer||e?.substituteIn||e?.subbedIn;
    const pOut=e?.playerOut||e?.playerOff||e?.outPlayer||e?.substituteOut||e?.subbedOut;
    if(pIn  && me(pIn.id ?? pIn?.playerId,  pIn.name  ?? pIn?.playerName)) inMin = Math.min(inMin ?? Infinity, minute ?? 0);
    if(pOut && me(pOut.id ?? pOut?.playerId, pOut.name ?? pOut?.playerName)) outMin= Math.max(outMin ?? 0,      minute ?? 0);
  }
  if(inMin==null && outMin==null) return null;
  const start=inMin==null?0:inMin, end=outMin==null?90:Math.max(90,outMin), mins=Math.max(0,end-start);
  return Number.isFinite(mins)?mins:null;
}

export async function handler(event){
  try{
    let payload={};
    if(event.httpMethod==="POST"){ try{ payload=JSON.parse(event.body||"{}"); }catch{ return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Invalid JSON body" }) }; } }
    else { payload = { playerId:Number(event.queryStringParameters?.playerId||NaN), playerName:String(event.queryStringParameters?.playerName||"").trim(), matchUrl:String(event.queryStringParameters?.matchUrl||"").trim() }; }

    const playerId = Number(payload.playerId||NaN);
    const playerName = String(payload.playerName||"").trim();
    const matchUrl = String(payload.matchUrl||"").trim();
    if(!matchUrl || (!playerName && !Number.isFinite(playerId))){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Provide { playerId or playerName, matchUrl }" }) };
    }

    const { matchId, finalUrl, html: maybeHtml } = await resolveMatchIdFromUrl(matchUrl);
    if(!matchId){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    // API → HTML fallback
    let data=null, htmlUsed=maybeHtml, source="api";
    try{
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    }catch{
      const fb = await nextFallbackJSON(finalUrl, maybeHtml||null);
      data = fb.data; htmlUsed = fb.html; source = fb.source || "next_html";
    }

    // gates
    const league_id = pickLeagueId(data);
    const league_label = LEAGUE_LABELS[league_id] || pickLeagueName(data) || null;
    const dt = pickKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const league_allowed = league_id!=null && TOP5_LEAGUE_IDS.has(Number(league_id));
    const within_season_2025_26 = dt ? (dt>=SEASON_START && dt<=SEASON_END) : false;

    // ratings & explicit POTM
    const ratings = ratingsFromJson(data);
    const explicitP = data?.general?.playerOfTheMatch ?? data?.content?.matchFacts?.playerOfTheMatch ?? null;
    const potm = explicitP || (ratings.length ? (()=>{ const rs=[...ratings].sort((a,b)=>Number(b.rating||0)-Number(a.rating||0)); return rs[0] ? { id:rs[0].id ?? null, name:rs[0].name ?? null, fullName:rs[0].fullName ?? null, by:"max_rating_fallback", rating:rs[0].rating ?? null } : null; })() : null);
    const potmNameText = potm ? (potm.fullName || potm.name || "") : "";
    const player_is_pom = potm ? ((Number.isFinite(playerId) && Number(potm.id)===playerId) || sameName(potmNameText, playerName)) : false;

    // player's own rating + echo name
    let player_rating = null;
    let echo_player_name = playerName || null;
    const meRating = ratings.find(r => (Number.isFinite(playerId) && r.id!=null && Number(r.id)===Number(playerId)) || sameName(r.name, playerName));
    if(meRating){
      if (Number.isFinite(Number(meRating.rating))) player_rating = Number(meRating.rating);
      if (!echo_player_name && meRating.name) echo_player_name = String(meRating.name);
    }
    if (!echo_player_name && Number.isFinite(playerId)){
      const lu = data?.content?.lineups || data?.lineups || data?.formations || null;
      for (const node of walk(lu||{})){
        const id = asNum(node?.id ?? node?.playerId ?? node?.player?.id);
        if (id != null && Number(id) === Number(playerId)){
          const nm = asStr(node?.name ?? node?.playerName ?? node?.player);
          if (nm){ echo_player_name = nm; break; }
        }
      }
    }

    // strict per-match counts
    const mf = (data?.content && data.content.matchFacts) ? data.content.matchFacts : (data.matchFacts || null);
    let goalsEvents = collectGoalsFromMatchFacts(mf);
    goalsEvents = uniqueByJSON([ ...goalsEvents, ...collectShotmapGoals(data) ]); // shotmap fallback

    const me = (id,nm)=> (Number.isFinite(playerId) && id!=null && Number(id)===Number(playerId)) || sameName(nm, playerName);

    let goals=0, pg=0, ast=0;
    for (const e of goalsEvents){
      if (e.own) continue;
      if (me(e.scorerId, e.scorerName)){ goals++; if (e.penalty) pg++; }
      if (me(e.assistId, e.assistName)) ast++;
    }

    const cardsE = collectCardsStrict(mf);
    let yc=0, rc=0;
    for (const c of cardsE){
      if (!me(c.playerId, c.playerName)) continue;
      if (c.kind === 'yellow') yc++;
      else if (c.kind === 'second_yellow'){ yc++; rc++; }
      else if (c.kind === 'red') rc++;
    }

    // minutes / FMP (safe)
    let minutes = minutesFromStatsRows(data, Number.isFinite(playerId)?playerId:null, playerName);
    if (minutes == null){
      const lu = data?.content?.lineups || data?.lineups || data?.formations || null;
      const f = fmpFromLineups(lu, Number.isFinite(playerId)?playerId:null, playerName);
      if (f != null) minutes = f ? 90 : null;
    }
    if (minutes == null && mf){
      const m = minutesFromSubs(mf, Number.isFinite(playerId)?playerId:null, playerName);
      if (m != null) minutes = m;
    }
    const full_match_played = minutes != null ? (Number(minutes) >= 90) : false;

    const match_title = titleFrom(data, htmlUsed);

    return {
      statusCode:200,
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({
        echo_player_id: Number.isFinite(playerId)?playerId:null,
        echo_player_name,
        match_url: matchUrl,
        resolved_match_id: String(matchId),
        match_title,
        league_id,
        league_label,
        match_datetime_utc,
        league_allowed,
        within_season_2025_26,
        player_is_pom,
        potm_name: potm || null,
        potm_name_text: potmNameText,
        potm_id: potm?.id ?? null,
        player_rating,
        player_stats: {
          goals,
          penalty_goals: pg,
          non_penalty_goals: Math.max(0, goals - pg),
          assists: ast,
          yellow_cards: yc,
          red_cards: rc,
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
