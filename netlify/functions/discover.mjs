// netlify/functions/discover.mjs
// Given player profile URLs, discover 2025–26 Top-5 domestic league match URLs.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30 23:59:59

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_HTML = { accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "user-agent":UA, referer:"https://www.fotmob.com/" };

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const asNum=(v)=>Number.isFinite(Number(v))?Number(v):null;

async function fetchText(url, retry=2){
  let last; for(let i=0;i<=retry;i++){
    try{ const r=await fetch(url,{headers:HDRS_HTML,redirect:"follow"}); const t=await r.text(); if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`); if(!t) throw new Error("Empty HTML"); return { finalUrl:r.url||url, html:t }; }
    catch(e){ last=e; await sleep(180+250*i); }
  } throw last||new Error("fetch failed (html)");
}

function nextDataStr(html){ const m=html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i); return m?m[1]:null; }
function safeJSON(s){ try{ return JSON.parse(s); }catch{ return null; } }
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
function unique(arr){ return Array.from(new Set(arr)); }
function toISO(d){ try{ return new Date(d).toISOString(); }catch{ return null; } }
function inSeason(d){ if(!d) return false; const dt=new Date(d); return dt>=SEASON_START && dt<=SEASON_END; }

function discoverFromNextData(root){
  const matches=[];
  let playerId=null, playerName=null, teamId=null, teamSlug=null;

  for(const node of walk(root)){
    if(playerId==null && (node?.playerId!=null || node?.id!=null) && (node?.firstName || node?.name || node?.fullName)){
      // best-effort id/name (non-authoritative)
      playerName = playerName || (node?.fullName || node?.name || null);
      playerId   = playerId ?? asNum(node?.playerId ?? node?.id);
    }
    if(teamId==null && (node?.teamId!=null || (node?.team && node.team.id!=null))){
      teamId = asNum(node?.teamId ?? node?.team?.id);
      teamSlug = node?.team?.name ? String(node.team.name).toLowerCase().replace(/\s+/g,'-') : null;
    }

    // collect arrays of "matches" with matchId & metadata
    for(const [k,v] of Object.entries(node)){
      if(!Array.isArray(v) || !v.length) continue;
      const key=String(k).toLowerCase();
      // heuristic: entries with a numeric match id and optional league id/time
      if(/match|fixture|games|recent|last|upcoming/.test(key)){
        for(const it of v){
          if(!it || typeof it!=="object") continue;
          const mid = asNum(it?.matchId ?? it?.id);
          if(!mid) continue;
          const lid = asNum(it?.leagueId ?? it?.tournamentId ?? it?.competitionId);
          const t   = it?.matchTimeUTC || it?.startTimeUTC || it?.utcStart || it?.dateUTC || it?.date || it?.startDate || null;
          matches.push({ matchId: mid, leagueId: lid ?? null, iso: toISO(t) });
        }
      }
    }
  }

  // also scrape raw /match/ids from HTML-driven lists (last resort)
  // (We'll filter by season later in the checker anyway if date missing)
  return { playerId, playerName, teamId, teamSlug, matches };
}

function filterTop5Season(list){
  const out=[];
  for(const m of list){
    if(m.leagueId!=null && !TOP5_LEAGUE_IDS.has(Number(m.leagueId))) continue;
    if(m.iso && !inSeason(m.iso)) continue;
    out.push(m);
  }
  return out;
}

function buildMatchUrls(list){
  const ids = unique(list.map(x=>String(x.matchId))).filter(Boolean);
  return ids.map(id => `https://www.fotmob.com/match/${id}`);
}

function parsePlayerIdFromUrl(u){ try{ const m=new URL(u).pathname.match(/\/players\/(\d+)/); return m?Number(m[1]):null; }catch{ return null; } }

export async function handler(event){
  try{
    let payload={};
    if(event.httpMethod==="POST"){ try{ payload=JSON.parse(event.body||"{}"); }catch{ return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide { urls: [...] }" }) }; } }
    else { return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide { urls: [...] }" }) }; }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    if(!urls.length){
      return { statusCode:200, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:"Provide { urls: [...] }" }) };
    }

    const playersOut = [];

    for(const playerUrl of urls){
      const debug = { anchors_found:0, next_ids:0, used:'next', errors:[] };
      let player_id = parsePlayerIdFromUrl(playerUrl);
      let player_name=null;
      let match_urls=[];

      try{
        // 1) Player page → __NEXT_DATA__ → matches
        const { html } = await fetchText(playerUrl);
        const s = nextDataStr(html);
        if(!s) throw new Error("NEXT_DATA not found");
        const obj = safeJSON(s);
        if(!obj) throw new Error("NEXT_DATA JSON parse failed");

        const found = discoverFromNextData(obj);
        if(found.playerId) player_id = player_id ?? found.playerId;
        if(found.playerName) player_name = found.playerName;
        debug.next_ids = found.matches.length;

        const kept = filterTop5Season(found.matches);
        match_urls = buildMatchUrls(kept);

        // 2) Fallback: if zero URLs, try raw anchors from HTML
        if(match_urls.length === 0){
          debug.used = 'anchors';
          const ids = Array.from(html.matchAll(/\/match\/(\d{5,10})/g)).map(m=>m[1]);
          debug.anchors_found = ids.length;
          match_urls = buildMatchUrls(ids.map(id => ({ matchId:Number(id) })));
        }

      }catch(e){
        debug.errors.push(String(e));
      }

      playersOut.push({
        player_url: playerUrl,
        player_id,
        player_name: player_name || null,
        match_urls,
        debug
      });
    }

    return {
      statusCode:200,
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ ok:true, players: playersOut })
    };
  }catch(e){
    return { statusCode:500, headers:{ "content-type":"application/json" }, body: JSON.stringify({ ok:false, error:String(e) }) };
  }
}
