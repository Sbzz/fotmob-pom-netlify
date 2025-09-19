// netlify/functions/check.mjs
// Works for ANY player (not only those with a ratings row):
//  • POTM (unchanged)
//  • Goals / Penalty goals / Non-penalty goals
//  • Assists
//  • Yellow / Red (2nd yellow ⇒ +1 RC, +1 YC)
//  • FMP (>=90) from minutes or inferred from lineups
// Robust to both API payloads and __NEXT_DATA__ (dehydratedState) HTML fallback.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const LEAGUE_LABELS = { 47: "Premier League", 87: "LaLiga", 54: "Bundesliga", 55: "Serie A", 53: "Ligue 1" };
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0));
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS_JSON = { accept:"application/json","accept-language":"en-GB,en;q=0.9","user-agent":UA,referer:"https://www.fotmob.com/" };
const HDRS_HTML = { accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","user-agent":UA,referer:"https://www.fotmob.com/" };

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const norm = (s)=>String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const asNum = (v)=>Number.isFinite(Number(v)) ? Number(v) : null;
const asStr = (v)=>typeof v==="string" ? v : (v?.name || v?.fullName || null);

const parseMinuteStr = (s)=>{
  if (s == null) return null;
  if (typeof s === "number") return s;
  const m = String(s).match(/^(\d{1,3})(?:\+(\d{1,2}))?/);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) : 0) : null;
};

// ---------------- fetchers ----------------
async function fetchJSON(url, retry=2){
  let last;
  for(let i=0;i<=retry;i++){
    try{
      const res = await fetch(url,{ headers:HDRS_JSON, redirect:"follow" });
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
      const res = await fetch(url,{ headers:HDRS_HTML, redirect:"follow" });
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if(!txt) throw new Error("Empty HTML");
      return { finalUrl: res.url || url, html: txt };
    }catch(e){ last=e; await sleep(200+300*i); }
  }
  throw last || new Error("fetch failed (html)");
}

function extractFirstNumericIdFromPath(path=""){ const m=path.match(/\/match\/(\d{5,10})(?:\/|$)/i); return m?m[1]:null; }
async function resolveMatchIdFromUrl(urlStr){
  try{
    const u = new URL(urlStr);
    const id = extractFirstNumericIdFromPath(u.pathname);
    if (id) return { matchId:id, finalUrl:urlStr, html:null };
    const { finalUrl, html } = await fetchText(urlStr);
    const id2 = extractFirstNumericIdFromPath(new URL(finalUrl).pathname);
    if (id2) return { matchId:id2, finalUrl, html };
    let m = html.match(/"matchId"\s*:\s*(\d{5,10})/i);
    if (m) return { matchId:m[1], finalUrl, html };
    m = html.match(/\/match\/(\d{5,10})/i);
    if (m) return { matchId:m[1], finalUrl, html };
    return { matchId:null, finalUrl, html };
  }catch{
    return { matchId:null, finalUrl:urlStr, html:null };
  }
}

// ---------------- walkers/pickers ----------------
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
    if (p?.rating != null) rating=Number(p.rating);
    else if (p?.stats?.rating != null) rating=Number(p.stats.rating);
    else if (p?.playerRating != null) rating=Number(p.playerRating);
    return (name || id!=null) ? { id, name, rating, raw:p } : null;
  }
  const out=[];
  const pushArr=(arr)=>{ if(!Array.isArray(arr)) return; for(const it of arr){ const row=coerce(it); if(row) out.push(row); } };
  pushArr(json?.content?.playerRatings?.home?.players);
  pushArr(json?.content?.playerRatings?.away?.players);
  pushArr(json?.playerRatings?.home?.players);
  pushArr(json?.playerRatings?.away?.players);
  for(const n of walkObjects(json)){
    for(const [k,v] of Object.entries(n)){
      if(Array.isArray(v) && v.length && v.some(x => x && typeof x==="object" && (("rating" in x) || ("playerRating" in x) || (x.stats && typeof x.stats==="object" && "rating" in x.stats))))
        pushArr(v);
    }
  }
  return out;
}

function pickLeagueId(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      const kk = String(k).toLowerCase();
      if (/(leagueid|tournamentid|competitionid)$/.test(kk)) {
        const num = Number(v); if (Number.isFinite(num)) return num;
      }
    }
  }
  return null;
}
function pickLeagueName(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      const kk = String(k).toLowerCase();
      if (/(leaguename|tournamentname|competitionname)$/.test(kk) && typeof v==="string") return v;
    }
  }
  return null;
}
function pickKickoff(obj){
  for(const n of walkObjects(obj)){
    for(const [k,v] of Object.entries(n)){
      const kk = String(k).toLowerCase();
      if (/^(matchtimeutc|starttimeutc|startdate|kickoffiso|utcstart|dateutc)$/.test(kk) && typeof v === "string") {
        const d = new Date(v); if (!isNaN(d)) return d;
      }
      if (/^(matchtime|kickoff|epoch|timestamp)$/.test(kk) && Number.isFinite(Number(v))) {
        const ts = Number(v); const d = new Date(ts>1e12?ts:ts*1000); if (!isNaN(d)) return d;
      }
    }
  }
  return null;
}
function explicitPOTM(obj){
  for(const n of walkObjects(obj)){
    if (n.playerOfTheMatch && (n.playerOfTheMatch.id!=null || n.playerOfTheMatch.name || n.playerOfTheMatch.fullName)) return n.playerOfTheMatch;
    if (n.matchFacts && n.matchFacts.playerOfTheMatch){
      const p=n.matchFacts.playerOfTheMatch;
      if (p && (p.id!=null || p.name || p.fullName)) return p;
    }
  }
  return null;
}
function deriveTitle(obj, html){
  const g=obj?.general;
  if (g?.matchName) return g.matchName;
  const ht=g?.homeTeam?.name || obj?.homeTeam?.name || "";
  const at=g?.awayTeam?.name || obj?.awayTeam?.name || "";
  if (ht || at) return `${ht||"?"} vs ${at||"?"}`;
  if (html){ const m=html.match(/<title>([^<]+)<\/title>/i); if(m) return m[1].replace(/\s+/g," ").trim(); }
  return "vs";
}

// -------------- NEXT fallback (dehydratedState aware) --------------
function extractNextDataString(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSON(s){ try{ return JSON.parse(s);}catch{ return null; } }

function mergeUnique(targetArr, addArr){
  if(!Array.isArray(addArr)||!addArr.length) return;
  const key=o=>JSON.stringify(o);
  const seen=new Set(targetArr.map(key));
  for(const o of addArr){ const k=key(o); if(!seen.has(k)){ seen.add(k); targetArr.push(o); } }
}

function buildEnrichedFromNext(root){
  const out = { general:{}, content:{ playerRatings:null, matchFacts:{ goals:[], cards:[], events:[] }, lineups:null } };
  const queries = root?.props?.pageProps?.dehydratedState?.queries;

  const harvestMF = (mf)=>{
    if(!mf || typeof mf!=="object") return;
    for(const [k,v] of Object.entries(mf)){
      const key=String(k).toLowerCase();
      if(Array.isArray(v)){
        if(/^goals?$|^scorers?$/.test(key)) mergeUnique(out.content.matchFacts.goals, v);
        else if(/^cards$|^bookings$/.test(key)) mergeUnique(out.content.matchFacts.cards, v);
        else if(/^(events|incidents|timeline|summary)$/.test(key)) mergeUnique(out.content.matchFacts.events, v);
      }
    }
  };

  if(Array.isArray(queries)){
    for(const q of queries){
      const d=q?.state?.data;
      if(!d||typeof d!=="object") continue;

      // ratings
      const r=ratingsFromJson(d);
      if(r.length){
        out.content.playerRatings = out.content.playerRatings || {home:{players:[]}, away:{players:[]}};
        mergeUnique(out.content.playerRatings.away.players, r);
      }

      // matchFacts-ish
      harvestMF(d?.content?.matchFacts || d?.matchFacts);

      // lineups
      const lu=d?.content?.lineups || d?.lineups || d?.formations || null;
      if(lu && !out.content.lineups) out.content.lineups = lu;

      // general
      out.general.playerOfTheMatch = out.general.playerOfTheMatch || d?.general?.playerOfTheMatch || d?.playerOfTheMatch || null;
      out.general.leagueId = out.general.leagueId ?? pickLeagueId(d);
      out.general.leagueName = out.general.leagueName || pickLeagueName(d) || null;
      out.general.matchTimeUTC = out.general.matchTimeUTC || (pickKickoff(d)?.toISOString?.() || null);
    }
  }

  // fallback: whole tree
  if(!out.content.playerRatings){
    const rAll=ratingsFromJson(root);
    if(rAll.length) out.content.playerRatings={home:{players:[]}, away:{players:rAll}};
  }
  harvestMF(root?.content?.matchFacts || root?.matchFacts);
  if(!out.general.playerOfTheMatch) out.general.playerOfTheMatch = explicitPOTM(root) || null;
  out.general.leagueId = out.general.leagueId ?? pickLeagueId(root);
  out.general.leagueName = out.general.leagueName || pickLeagueName(root) || null;
  out.general.matchTimeUTC = out.general.matchTimeUTC || (pickKickoff(root)?.toISOString?.() || null);

  return out;
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

// -------------- event & stat extraction --------------
function isGoalEventLike(e){
  const t = String(e?.type || e?.eventType || e?.goalType || "").toLowerCase();
  return t.includes("goal") || e?.goal === true || e?.scorer || e?.goalScorer;
}
function isCardEventLike(e){
  const t = String(e?.card || e?.cardType || e?.type || e?.eventType || "").toLowerCase();
  return t.includes("yellow") || t.includes("red");
}

function extractGoalsStrict(mf){
  const out=[];
  const push=(e)=>{
    const scorerId   = asNum(e?.scorer?.id) ?? asNum(e?.scorerId) ?? asNum(e?.playerId) ?? asNum(e?.mainPlayerId) ?? asNum(e?.player?.id) ?? asNum(e?.goalScorer?.id);
    const scorerName = asStr(e?.scorer) || asStr(e?.scorerName) || asStr(e?.player) || asStr(e?.playerName) || asStr(e?.mainPlayer) || asStr(e?.goalScorer);
    const assistId   = asNum(e?.assist?.id) ?? asNum(e?.assistId) ?? asNum(e?.assistPlayerId) ?? asNum(e?.secondaryPlayerId) ?? asNum(e?.assist1?.id);
    const assistName = asStr(e?.assist) || asStr(e?.assistName) || asStr(e?.assistPlayer) || asStr(e?.secondaryPlayer) || asStr(e?.assist1);
    const t = String(e?.type || e?.eventType || e?.goalType || "").toLowerCase();
    const d = String(e?.detail || e?.reason || e?.description || "").toLowerCase();
    const penalty = !!(e?.isPenalty || t.includes("pen") || d.includes("penalty"));
    const own = !!(e?.isOwnGoal || t.includes("own") || d.includes("own goal"));
    out.push({ scorerId, scorerName, assistId, assistName, penalty, own });
  };

  for (const [k,v] of Object.entries(mf||{})){
    if(!Array.isArray(v)) continue;
    const key=String(k).toLowerCase();
    if(/^goals?$|^scorers?$/.test(key)) v.forEach(e=>e&&push(e));
    if(/^(events|incidents|timeline|summary)$/.test(key)) v.forEach(e=>{ if(e && isGoalEventLike(e)) push(e); });
  }
  // de-dup
  return Array.from(new Map(out.map(o=>[JSON.stringify(o),o])).values());
}
function extractCardsStrict(mf){
  const out=[];
  const push=(e,kind)=>{
    const playerId   = asNum(e?.playerId) ?? asNum(e?.player?.id) ?? asNum(e?.mainPlayerId);
    const playerName = asStr(e?.player) || asStr(e?.playerName) || asStr(e?.mainPlayer);
    out.push({ playerId, playerName, kind });
  };
  for (const [k,v] of Object.entries(mf||{})){
    if(!Array.isArray(v)) continue;
    const key=String(k).toLowerCase();
    if(/^cards$|^bookings$/.test(key)){
      for(const e of v){
        const t=String(e?.card||e?.cardType||e?.type||"").toLowerCase();
        if(t.includes("yellow")) push(e, t.includes("second")?"second_yellow":"yellow");
        else if(t.includes("red")) push(e,"red");
      }
    }
    if(/^(events|incidents|timeline|summary)$/.test(key)){
      for(const e of v){
        const t=String(e?.card||e?.cardType||e?.type||e?.eventType||"").toLowerCase();
        if(t.includes("yellow")) push(e, t.includes("second")?"second_yellow":"yellow");
        else if(t.includes("red")) push(e,"red");
      }
    }
  }
  return out;
}

// NEW: generic sweep for player stats anywhere in the tree (works even if no ratings row exists)
function gatherPlayerStatsEverywhere(root, playerId, playerName){
  const nName = norm(playerName||"");
  const isMe = (id, nm)=> (playerId!=null && Number(id)===Number(playerId)) || (!!nName && nm && norm(nm)===nName);

  let goalsMax=null, penGoalsMax=null, assistsMax=null, ycMax=null, rcMax=null, minutesMax=null;

  for(const node of walkObjects(root)){
    const id = asNum(node?.playerId ?? node?.id ?? node?.player?.id);
    const nm = asStr(node?.playerName ?? node?.name ?? node?.player);
    if (!isMe(id, nm)) continue;

    // direct numeric fields
    const num = (v)=>asNum(v);
    const takeMax = (cur, val)=> (val==null ? cur : (cur==null ? val : Math.max(cur, val)));

    goalsMax    = takeMax(goalsMax,     num(node?.goals) ?? num(node?.stats?.goals) ?? num(node?.offensive?.goals) ?? num(node?.summary?.goals));
    assistsMax  = takeMax(assistsMax,   num(node?.assists) ?? num(node?.stats?.assists) ?? num(node?.offensive?.assists) ?? num(node?.summary?.assists));
    minutesMax  = takeMax(minutesMax,   num(node?.minutesPlayed) ?? num(node?.minsPlayed) ?? num(node?.playedMinutes) ?? num(node?.timeOnPitch) ?? num(node?.timePlayed) ?? num(node?.stats?.minutesPlayed) ?? num(node?.stats?.minsPlayed) ?? num(node?.performance?.minutesPlayed));
    const yc1   = num(node?.yellowCards) ?? num(node?.stats?.yellowCards) ?? num(node?.cards?.yellow) ?? num(node?.discipline?.yellow) ?? num(node?.summary?.yellowCards);
    const rc1   = num(node?.redCards) ?? num(node?.stats?.redCards) ?? num(node?.cards?.red) ?? num(node?.discipline?.red) ?? num(node?.summary?.redCards);
    const secY  = num(node?.secondYellow) ?? num(node?.stats?.secondYellow) ?? num(node?.cards?.secondYellow) ?? num(node?.discipline?.secondYellow) ?? num(node?.summary?.secondYellow);
    ycMax       = takeMax(ycMax, yc1);
    rcMax       = takeMax(rcMax, (rc1 ?? 0) + (secY ?? 0));
    // penalty goals numeric variants
    penGoalsMax = takeMax(penGoalsMax, num(node?.penaltyGoals) ?? num(node?.stats?.penaltyGoals) ?? num(node?.penalties?.scored) ?? num(node?.stats?.penaltiesScored) ?? num(node?.stats?.penaltyScored));

    // stats arrays on the row: [{title,key,stats:{ "Minutes played": {key:"minutes_played", stat:{value}} , ...}}]
    if (Array.isArray(node?.stats)) {
      for(const grp of node.stats){
        const bag = grp?.stats;
        if (!bag || typeof bag!=="object") continue;
        for (const [label,obj] of Object.entries(bag)){
          const key = String(obj?.key || "").toLowerCase();
          const lbl = String(label || "").toLowerCase();
          const val = obj?.stat?.value ?? obj?.value ?? obj?.stat ?? null;
          const valN = asNum(val);
          if (valN==null) continue;

          if (key==="minutes_played" || lbl.includes("minutes played")) minutesMax = takeMax(minutesMax, valN);
          else if (key==="goals" || lbl==="goals") goalsMax = takeMax(goalsMax, valN);
          else if (key==="assists" || lbl==="assists") assistsMax = takeMax(assistsMax, valN);
          else if (key.includes("penalty") || key==="penalties_scored" || key==="penaltygoals" || lbl.includes("penalty"))
            penGoalsMax = takeMax(penGoalsMax, valN);
          else if (key==="yellow_cards" || key==="yellowcards" || lbl.includes("yellow")) ycMax = takeMax(ycMax, valN);
          else if (key==="red_cards" || key==="redcards" || lbl.includes("red card")) rcMax = takeMax(rcMax, valN);
        }
      }
    }
  }

  return {
    goalsMax, penGoalsMax, assistsMax, ycMax, rcMax, minutesMax
  };
}

// minutes / FMP from lineups
function inferFMPFromLineups(container, playerId, playerName){
  if(!container) return null;
  const nName = norm(playerName||"");
  let started=false, subOut=null;

  const candidateLists=[];
  for(const [k,v] of Object.entries(container)){
    if(Array.isArray(v)) candidateLists.push(v);
    else if (v && typeof v==="object"){
      for(const [kk,vv] of Object.entries(v)) if(Array.isArray(vv)) candidateLists.push(vv);
    }
  }

  for(const list of candidateLists){
    for(const p of list){
      if(!p || typeof p!=="object") continue;
      const id = asNum(p?.id ?? p?.playerId ?? p?.player?.id);
      const nm = asStr(p?.name ?? p?.playerName ?? p?.player);
      const me = (playerId!=null && id===playerId) || (!!nName && nm && norm(nm)===nName);
      if(!me) continue;

      if(p?.isStarting===true || p?.starter===true || p?.isSubstitute===false || p?.position==="Starting XI") started=true;

      const outMin =
        parseMinuteStr(p?.substitutedOutExpandedTime) ??
        parseMinuteStr(p?.subbedOutExpandedTime) ??
        asNum(p?.substitutedOut) ?? asNum(p?.subbedOut) ?? asNum(p?.subOff) ??
        parseMinuteStr(p?.offTime) ?? parseMinuteStr(p?.outTime);
      if(outMin!=null) subOut = Math.max(subOut??0, outMin);
    }
  }
  if(!started) return null;
  if(subOut==null) return true;
  return subOut >= 90;
}

// ---------------- handler ----------------
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

    const playerId   = Number(payload.playerId || NaN);
    const playerName = String(payload.playerName || "").trim();
    const matchUrl   = String(payload.matchUrl || "").trim();

    if(!matchUrl || (!playerName && !Number.isFinite(playerId))){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Provide { playerId or playerName, matchUrl }" }) };
    }

    const { matchId, finalUrl, html: maybeHtml } = await resolveMatchIdFromUrl(matchUrl);
    if(!matchId){
      return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Could not resolve numeric matchId from matchUrl", matchUrl }) };
    }

    // 1) API first, 2) HTML (__NEXT_DATA__) enriched fallback
    let data=null, htmlUsed=maybeHtml, source="api";
    try{
      data = await fetchJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
    }catch{
      const fb = await nextFallbackJSON(finalUrl, maybeHtml || null);
      data = fb.data; htmlUsed = fb.html; source = fb.source || "next_html";
    }

    // --- gates ---
    const league_id = pickLeagueId(data);
    const league_label = LEAGUE_LABELS[league_id] || pickLeagueName(data) || null;
    const league_allowed = league_id!=null && TOP5_LEAGUE_IDS.has(Number(league_id));
    const dt = pickKickoff(data);
    const match_datetime_utc = dt ? dt.toISOString() : null;
    const within_season_2025_26 = dt ? (dt>=SEASON_START && dt<=SEASON_END) : false;

    // --- POTM ---
    const ratings = ratingsFromJson(data);
    const explicitP = data?.general?.playerOfTheMatch ?? data?.content?.matchFacts?.playerOfTheMatch ?? null;
    const potm = explicitP || (ratings.length ? (()=>{ const rs=[...ratings].sort((a,b)=>Number(b.rating||0)-Number(a.rating||0)); return rs[0] ? { id:rs[0].id ?? null, name:rs[0].name ?? null, fullName:rs[0].fullName ?? null, by:"max_rating_fallback", rating:rs[0].rating ?? null } : null; })() : null);
    const potmNameText = potm ? (potm.fullName || potm.name || "") : "";
    const player_is_pom = potm ? ((Number.isFinite(playerId) && Number(potm.id)===playerId) || (!!playerName && potmNameText && norm(potmNameText)===norm(playerName))) : false;

    const match_title = deriveTitle(data, htmlUsed);

    // --- stats from everywhere ---
    // A) First, a generic sweep: any node that references the player
    const sweep = gatherPlayerStatsEverywhere(data, Number.isFinite(playerId)?playerId:null, playerName);
    let goals = sweep.goalsMax, penGoals = sweep.penGoalsMax, assists = sweep.assistsMax, yc = sweep.ycMax, rc = sweep.rcMax, minutes = sweep.minutesMax;

    // B) Strict matchFacts-based events (to catch penalties/assists even if player row absent)
    const mf = (data?.content && data.content.matchFacts) ? data.content.matchFacts : (data.matchFacts || null);
    if (mf) {
      const goalsArr = extractGoalsStrict(mf);
      const cardsArr = extractCardsStrict(mf);
      const isMe = (id, nm)=> (Number.isFinite(playerId) && id!=null && Number(id)===playerId) || (!!playerName && nm && norm(nm)===norm(playerName));

      let g=0, pg=0, a=0, y=0, r=0;
      for (const e of goalsArr){
        if (e.own) continue;
        if (isMe(e.scorerId, e.scorerName)){ g++; if(e.penalty) pg++; }
        if (isMe(e.assistId, e.assistName)) a++;
      }
      for (const c of cardsArr){
        if (!isMe(c.playerId, c.playerName)) continue;
        if (c.kind==="yellow") y++;
        else if (c.kind==="second_yellow"){ y++; r++; }
        else if (c.kind==="red") r++;
      }

      // take max with sweep (avoid zeros overriding legit values)
      const takeMax = (cur, add)=> (add==null ? cur : (cur==null ? add : Math.max(cur, add)));
      goals    = takeMax(goals, g);
      penGoals = takeMax(penGoals, pg);
      assists  = takeMax(assists, a);
      yc       = takeMax(yc, y);
      rc       = takeMax(rc, r);
    }

    // C) Minutes/FMP
    if (minutes==null){
      const lineups = data?.content?.lineups || data?.lineups || data?.formations || null;
      const f = inferFMPFromLineups(lineups, Number.isFinite(playerId)?playerId:null, playerName);
      if (f != null) minutes = f ? 90 : null;
      if (minutes==null){
        // last sweep for any 'minutes' field lingering
        for(const n of walkObjects(data)){
          const id = asNum(n?.id ?? n?.playerId ?? n?.player?.id);
          const nm = asStr(n?.name ?? n?.playerName ?? n?.player);
          const ok = (Number.isFinite(playerId) && id===playerId) || (!!playerName && nm && norm(nm)===norm(playerName));
          if(!ok) continue;
          const cand =
            asNum(n?.minutesPlayed) ?? asNum(n?.minsPlayed) ?? asNum(n?.playedMinutes) ??
            asNum(n?.timeOnPitch) ?? asNum(n?.timePlayed) ??
            asNum(n?.stats?.minutesPlayed) ?? asNum(n?.stats?.minsPlayed);
          if (cand!=null){ minutes=cand; break; }
        }
      }
    }
    const full_match_played = minutes!=null ? (Number(minutes) >= 90) : false;

    const nonPenGoals = Number(goals||0) - Number(penGoals||0);

    return {
      statusCode:200,
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({
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
        source: data?.content ? "api" : "next_html"
      })
    };
  }catch(e){
    return { statusCode:500, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:String(e) }) };
  }
}
