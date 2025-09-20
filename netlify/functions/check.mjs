// netlify/functions/check.mjs
// Keep: discovery inputs, league/season filters, POTM, FMP, Assists, fixture_key, UI contract.
// Fix: PG vs NPG (events/shotmap override stats=0), YC/RC (booking/card object variants + facts fallback).
// No "??" operator (uses nz()) so bundling is happy.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30
const NOW          = new Date();

const nz = (v, dflt) => (v === null || v === undefined ? dflt : v);
const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clampInt = (v) => Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
  "accept-language": "en-GB,en;q=0.9"
};

const resp = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

function toISO(v){
  if (v === null || v === undefined) return null;
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
  return d >= SEASON_START && d <= SEASON_END && d <= NOW;
}

async function fetchText(url){
  const r = await fetch(url, { headers: HDRS, redirect: "follow" });
  const html = await r.text();
  if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  if(!html) throw new Error("Empty HTML");
  return { html, finalUrl: r.url || url };
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

function mkFixtureKey(leagueId, iso, hId, aId, hName, aName){
  const lid = nz(leagueId, 'X');
  const t   = (iso || '').slice(0,16); // YYYY-MM-DDTHH:MM
  const H   = (hId !== null && hId !== undefined) ? `H#${hId}` : `H@${(hName||'').toLowerCase()}`;
  const A   = (aId !== null && aId !== undefined) ? `A#${aId}` : `A@${(aName||'').toLowerCase()}`;
  return `L${lid}|${t}|${H}|${A}`;
}

// ---------- FotMob general / potm / player node ----------
function extractGeneral(root){
  let leagueId=null, leagueName=null, iso=null, title=null, mid=null;
  let hId=null, aId=null, hName=null, aName=null;

  const setTeams = (g)=>{
    const home = g?.homeTeam || g?.home || null;
    const away = g?.awayTeam || g?.away || null;
    if(home){ hId = (hId!==null && hId!==undefined) ? hId : asNum(home.id); hName = hName || (home.name || home.teamName || home.shortName || null); }
    if(away){ aId = (aId!==null && aId!==undefined) ? aId : asNum(away.id); aName = aName || (away.name || away.teamName || away.shortName || null); }
  };

  for(const node of walk(root)){
    const g = node?.general || node?.overview?.general || node?.match?.general || null;
    if(!g) continue;
    leagueId   = (leagueId!==null && leagueId!==undefined) ? leagueId : asNum(g.leagueId || g.tournamentId || g.competitionId);
    leagueName = leagueName || (g.leagueName || g.tournamentName || g.competitionName || g?.league?.name || g?.tournament?.name || g?.competition?.name);
    iso        = iso || toISO(g.matchTimeUTC || g.startTimeUTC || g?.kickoff?.utc || g.dateUTC);
    title      = title || (g.pageTitle || g.matchName || g.title);
    mid        = (mid!==null && mid!==undefined) ? mid : asNum(g.matchId || g.id);
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
  for(const node of walk(root)){
    const potm = node?.playerOfTheMatch || node?.potm || node?.manOfTheMatch;
    if(potm && (potm.id || potm.playerId || potm.name)){
      const id = asNum(potm.id || potm.playerId);
      const nm = (potm.name && (potm.name.fullName || potm.name)) || (potm.firstName && potm.lastName ? `${potm.firstName} ${potm.lastName}` : null);
      const ratingNum = asNum((potm.rating && potm.rating.num) || potm.rating);
      return { id, name: nm, rating: ratingNum };
    }
  }
  // fallback: best finished rating
  let best=null;
  for(const node of walk(root)){
    if(!node?.rating) continue;
    const isTop = node?.rating?.isTop?.isTopRating;
    const finished = node?.rating?.isTop?.isMatchFinished;
    if(!isTop || !finished) continue;
    const cand = {
      id: asNum(node.id || node.playerId),
      name: (node?.name && (node.name.fullName || node.name)) || null,
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
  let exactById=null, bestByName=null, withMinutes=null;
  for(const node of walk(root)){
    const id = asNum(node?.id || node?.playerId);
    const full = (node?.name && (node.name.fullName || node.name)) || null;

    if(node?.minutesPlayed!=null && (id===playerId || (full && normName(full)===targetName))){
      withMinutes = withMinutes || node;
    }

    const hasStats = Array.isArray(node?.stats) && node.stats.length>0;
    if(!hasStats) continue;
    if(playerId && id === playerId) return node;
    if(!bestByName && full && targetName && normName(full) === targetName) bestByName = node;
    if(!exactById && id && playerId && id === playerId) exactById = node;
  }
  return exactById || bestByName || withMinutes || null;
}

function extractStatsFromStatsBlocks(node){
  const acc = { goals:null, penalty_goals:null, assists:null, yellow_cards:null, red_cards:null, minutes_played:null, rating:null };
  if(!node) return acc;
  if(Number.isFinite(Number(node.minutesPlayed))) acc.minutes_played = Number(node.minutesPlayed);
  if(node?.rating && node.rating.num!=null && Number.isFinite(Number(node.rating.num))) acc.rating = Number(node.rating.num);

  if(!Array.isArray(node.stats)) return acc;
  const pick = (labels) => {
    for(const lab of labels){
      for(const section of node.stats){
        const m = section?.stats?.[lab];
        const v = (m && (m.stat && m.stat.value)) || (m && m.value) || m;
        if(v!=null) return Number(v);
      }
    }
    return null;
  };
  const rating = pick(["FotMob rating","Rating","Match rating"]);
  const mins   = pick(["Minutes played","Minutes","Time played"]);
  const goals  = pick(["Goals","Total goals"]);
  const pg     = pick(["Penalty goals","Penalties scored","Scored penalties","Penalty Goals","Penalty Goals Scored"]);
  const ast    = pick(["Assists","Total assists"]);
  const yc     = pick(["Yellow cards","Yellow Cards","YC","Yellow Card","Bookings"]);
  const rc     = pick(["Red cards","Red Cards","RC","Red Card","Dismissals"]);

  if(Number.isFinite(rating)) acc.rating = rating;
  if(Number.isFinite(mins))   acc.minutes_played = mins;
  if(Number.isFinite(goals))  acc.goals = goals;
  if(Number.isFinite(pg))     acc.penalty_goals = pg;
  if(Number.isFinite(ast))    acc.assists = ast;
  if(Number.isFinite(yc))     acc.yellow_cards = yc;
  if(Number.isFinite(rc))     acc.red_cards = rc;

  return acc;
}

// ---------- EVENTS & FALLBACKS ----------
function extractFromEvents(root, playerId, playerName){
  const acc = { goals:0, penalty_goals:0, assists:0, yellow_cards:0, red_cards:0 };
  const tName = normName(playerName||'');

  const matchByPlayer = (ev)=>{
    const pid = asNum(
      ev?.player?.id || ev?.playerId || ev?.actor?.id || ev?.participant?.id ||
      ev?.subject?.id || ev?.player1Id || ev?.playerId1
    );
    const nm  = ev?.player?.name?.fullName || ev?.playerName || ev?.player || ev?.actor?.name || ev?.name || ev?.subject?.name || ev?.player1Name || null;
    if(playerId && pid === playerId) return true;
    if(!playerId && nm && normName(nm)===tName) return true;
    if(Array.isArray(ev?.players)){
      for(const p of ev.players){
        const id = asNum(p?.id);
        const fn = p?.name?.fullName || p?.name;
        if(playerId && id===playerId) return true;
        if(!playerId && fn && normName(fn)===tName) return true;
      }
    }
    return false;
  };

  const assistMatch = (ev)=>{
    const ids = [];
    const names = [];
    if (ev?.assist) { ids.push(asNum(ev.assist.id)); names.push(ev.assist?.name?.fullName || ev.assistName); }
    if (ev?.assistId!=null) ids.push(asNum(ev.assistId));
    if (ev?.assisterId!=null) ids.push(asNum(ev.assisterId));
    if (ev?.assistPlayerId!=null) ids.push(asNum(ev.assistPlayerId));
    if (ev?.secondaryPlayerId!=null) ids.push(asNum(ev.secondaryPlayerId));
    if (Array.isArray(ev?.assists)) for(const a of ev.assists){ ids.push(asNum(a?.id)); names.push(a?.name?.fullName||a?.name); }
    if (Array.isArray(ev?.assistPlayers)) for(const a of ev.assistPlayers){ ids.push(asNum(a?.id)); names.push(a?.name?.fullName||a?.name); }
    if(playerId && ids.some(id => id===playerId)) return true;
    if(!playerId) for(const nm of names){ if(nm && normName(nm)===tName) return true; }
    return false;
  };

  const val = (x)=> (x===null || x===undefined) ? '' : String(x).toLowerCase();
  const isGoalEvent = (e) => {
    const t = [e.type, e.eventType, e.incidentType, e.key, e.code, e.kind, e.result, e.action].map(val).join('|');
    const d = [e.detail, e.subType, e.scoringType, e.goalType, e.outcome, e.description].map(val).join('|');
    // include "penalty" goals that may not literally say "goal" in type
    return t.includes('goal') || d.includes('goal') || t.includes('score') || t.includes('scored') ||
           d.includes('scored') || (t.includes('penalty') && d.includes('scored')) || e?.isGoal===true;
  };
  const isOwnGoal = (e) => {
    const s = [e.detail, e.subType, e.scoringType, e.goalType, e.description, e.result].map(val).join('|');
    return s.includes('own') || s.includes('og') || e?.isOwnGoal === true;
  };
  const isPenaltyGoal = (e) => {
    // catch broad variants: "penalty", "pen", "from penalty", "penalty kick", codes, shotType.name, situation
    const s = [
      e.type, e.eventType, e.scoringType, e.goalType, e.detail, e.subType, e.situation, e.description,
      e?.shotType?.name, e?.code, e?.result
    ].map(val).join('|');
    return s.includes('penalty') || s.includes('pen ') || s.includes(' pen') || s.includes('pen_') ||
           s.includes('from penalty') || s.includes('penalty kick') || s.includes('penaltykick') ||
           s.includes('penaltyscored') || e?.isPenalty === true || e?.penalty === true;
  };

  const isYellow = (e) => {
    // handle booking objects like { card: { color: "yellow" } }
    const cardObj = e?.card || e?.booking || e?.bookingCard || null;
    const cardColor = cardObj && (cardObj.color || cardObj.type || cardObj.name) ? String(cardObj.color || cardObj.type || cardObj.name).toLowerCase() : '';
    const s = [
      e.type, e.eventType, e.key, e.card, e.cardType, e.kind, e.incidentType, e.description, e.color, e.code,
      e.detail, e.subType, cardColor
    ].map(val).join('|');
    return s.includes('yellow') || s.includes('yellowcard') || s.includes('yc');
  };
  const isRed = (e) => {
    const cardObj = e?.card || e?.booking || e?.bookingCard || null;
    const cardColor = cardObj && (cardObj.color || cardObj.type || cardObj.name) ? String(cardObj.color || cardObj.type || cardObj.name).toLowerCase() : '';
    const s = [
      e.type, e.eventType, e.key, e.card, e.cardType, e.kind, e.incidentType, e.description, e.color, e.code,
      e.detail, e.subType, cardColor
    ].map(val).join('|');
    return s.includes('red') || s.includes('redcard') || s.includes('rc') || s.includes('second yellow');
  };

  // gather all arrays that look event-ish
  const arrays = new Set();
  for(const node of walk(root)){
    for (const [k,valArr] of Object.entries(node||{})){
      if(Array.isArray(valArr) && valArr.length){
        const e0 = valArr[0];
        const lk = String(k).toLowerCase();
        if(
          /event|timeline|incident|card|goal|booking|bookings/.test(lk) ||
          (e0 && typeof e0==='object' && ('type' in e0 || 'eventType' in e0 || 'card' in e0 || 'result' in e0 || 'assist' in e0 || 'player' in e0))
        ){
          arrays.add(valArr);
        }
      }
    }
  }

  let sawSecondYellow = false;

  for(const arr of arrays){
    for(const ev of arr){
      if(!ev || typeof ev!=='object') continue;

      // goals
      if(isGoalEvent(ev) && matchByPlayer(ev) && !isOwnGoal(ev)){
        acc.goals += 1;
        if(isPenaltyGoal(ev)) acc.penalty_goals += 1;
      }

      // assists
      if(isGoalEvent(ev) && assistMatch(ev) && !isOwnGoal(ev)){
        acc.assists += 1;
      }

      // cards
      if(matchByPlayer(ev)){
        if(isYellow(ev)) acc.yellow_cards += 1;
        if(isRed(ev)) {
          acc.red_cards += 1;
          const det = String(nz(ev.detail,'') + ' ' + nz(ev.description,'')).toLowerCase();
          if(det.includes('second yellow')) sawSecondYellow = true;
        }
      }
    }
  }
  if(sawSecondYellow && acc.yellow_cards===0) acc.yellow_cards = 1;

  return acc;
}

// Fallback just for cards if timeline is sparse (facts/bookings/cards blocks)
function extractCardsFromFacts(root, playerId, playerName){
  const out = { yellow:0, red:0 };
  const tName = normName(playerName||'');

  const isMe = (obj)=>{
    const id = asNum(obj?.playerId || obj?.id || obj?.player?.id || obj?.personId);
    const nm = obj?.player?.name?.fullName || obj?.playerName || obj?.name || null;
    if(playerId && id === playerId) return true;
    if(!playerId && nm && normName(nm)===tName) return true;
    return false;
  };
  const colorOf = (obj)=>{
    const cardObj = obj?.card || obj?.booking || obj?.bookingCard || null;
    const cardColor = cardObj && (cardObj.color || cardObj.type || cardObj.name) ? String(cardObj.color || cardObj.type || cardObj.name).toLowerCase() : '';
    const raw = (obj && (obj.cardType || obj.color || obj.type || obj.code || obj.description || obj.detail)) ? String(obj.cardType || obj.color || obj.type || obj.code || obj.description || obj.detail).toLowerCase() : '';
    const all = (cardColor + '|' + raw);
    if(all.includes('yellow') || all.includes('yellowcard') || all.includes('yc')) return 'yellow';
    if(all.includes('red')    || all.includes('redcard')    || all.includes('rc') || all.includes('second yellow')) return 'red';
    return null;
  };

  for(const node of walk(root)){
    const arrays = [];
    if(Array.isArray(node?.cards)) arrays.push(node.cards);
    if(Array.isArray(node?.bookings)) arrays.push(node.bookings);
    if(Array.isArray(node?.content)) arrays.push(node.content);
    for(const arr of arrays){
      for(const it of arr){
        if(!it || typeof it!=='object') continue;
        const col = colorOf(it);
        if(!col) continue;
        if(isMe(it)){
          if(col==='yellow') out.yellow += 1;
          if(col==='red')    out.red    += 1;
        }
      }
    }
  }
  return out;
}

// Shotmap fallback for goals/penalties
function extractFromShotmap(root, playerId, playerName){
  const acc = { goals:0, penalty_goals:0 };
  const tName = normName(playerName||'');

  for(const node of walk(root)){
    const id   = asNum(node?.id || node?.playerId);
    const name = node?.name?.fullName || node?.name || null;
    if(!Array.isArray(node?.shotmap)) continue;

    const isMe = (playerId && id===playerId) || (!playerId && name && normName(name)===tName);
    if(!isMe) continue;

    for(const sh of node.shotmap){
      if(!sh || typeof sh!=='object') continue;
      const result = String(nz(sh.result,'')).toLowerCase();
      const goal = sh.isGoal === true || result==='goal';
      const desc = String(nz(sh.description,'')).toLowerCase();
      const sit  = String(nz(sh.situation,'')).toLowerCase();
      const stn  = String(nz(sh?.shotType?.name,'')).toLowerCase();
      const pen  = sh.isPenalty === true || sit.includes('pen') || stn.includes('pen') || desc.includes('penalty');
      const own  = sh.isOwnGoal === true || desc.includes('own');
      if(goal && !own){ acc.goals += 1; if(pen) acc.penalty_goals += 1; }
    }
  }
  return acc;
}

// ---------- Build per match ----------
function buildResult({ matchUrl, general, potm, playerNode, playerId, playerName, next }){
  const league_id   = asNum(general.leagueId);
  const league_name = general.leagueName || null;
  const iso         = general.iso || null;

  // 1) Base stats block (can be incomplete/zero)
  const base = extractStatsFromStatsBlocks(playerNode);
  let goals_stat = Number.isFinite(base.goals) ? base.goals : null;
  let pg_stat    = Number.isFinite(base.penalty_goals) ? base.penalty_goals : null;
  let ast        = Number.isFinite(base.assists) ? base.assists : 0;
  let yc_stat    = Number.isFinite(base.yellow_cards) ? base.yellow_cards : null;
  let rc_stat    = Number.isFinite(base.red_cards) ? base.red_cards : null;
  let mins       = Number.isFinite(base.minutes_played) ? base.minutes_played : 0;
  let rating     = Number.isFinite(base.rating) ? base.rating : null;

  // 2) Events (authoritative for PG + cards), 3) Shotmap fallback (PG/goals)
  const ev = extractFromEvents(next, playerId, playerName);
  const sm = extractFromShotmap(next, playerId, playerName);

  // ---- Merge policy ----
  // Goals overall
  let goals = Number.isFinite(goals_stat) ? goals_stat : (ev.goals || sm.goals || 0);

  // PG: prefer events; if 0 there, prefer shotmap; if still 0, accept stats; finally 0.
  let pg = (ev.penalty_goals > 0 ? ev.penalty_goals :
           (sm.penalty_goals > 0 ? sm.penalty_goals :
           (Number.isFinite(pg_stat) ? pg_stat : 0)));

  // Assists: keep stats unless missing -> use events
  let assists = ast || ev.assists || 0;

  // Cards: prefer events; then facts/bookings; then stats
  const facts = extractCardsFromFacts(next, playerId, playerName);
  const yc = (ev.yellow_cards > 0 ? ev.yellow_cards : (facts.yellow > 0 ? facts.yellow : (Number.isFinite(yc_stat) ? yc_stat : 0)));
  const rc = (ev.red_cards    > 0 ? ev.red_cards    : (facts.red    > 0 ? facts.red    : (Number.isFinite(rc_stat) ? rc_stat : 0)));

  // Minutes → FMP
  const fmp = clampInt(mins) >= 90;

  // POTM flag
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
    resolved_match_id: general.matchId ? String(general.matchId) : ((matchUrl.match(/\/match\/(\d+)/) || [])[1] || null),
    match_title: general.title || "match",
    league_id,
    league_label: league_name,
    match_datetime_utc: iso,
    league_allowed: (league_id !== null && league_id !== undefined) && TOP5_LEAGUE_IDS.has(league_id),
    within_season_2025_26: !!iso && inSeason(iso),

    player_is_pom,
    player_rating: (rating!=null ? Number(rating) : null),
    potm_name: potm && potm.name ? { fullName: potm.name } : null,
    potm_id: potm ? potm.id : null,

    home_team_id: (general.hId !== undefined ? general.hId : null),
    home_team_name: general.hName || null,
    away_team_id: (general.aId !== undefined ? general.aId : null),
    away_team_name: general.aName || null,
    fixture_key,

    player_stats: {
      goals: clampInt(goals),
      penalty_goals: clampInt(pg),
      assists: clampInt(assists),
      yellow_cards: clampInt(yc),
      red_cards: clampInt(rc),
      full_match_played: !!fmp
    },
    echo_player_name: (playerNode && playerNode.name && (playerNode.name.fullName || playerNode.name)) || playerName || null,
    source: "fotmob_html+events"
  };
}

// ---------- Handler ----------
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
    const node = (playerId || playerName) ? findPlayerNode(next, playerId||null, playerName||null) : null;

    const out = buildResult({ matchUrl, general, potm, playerNode: node, playerId, playerName, next });
    return resp(200, out);

  }catch(e){
    return resp(200, { error:String(e) });
  }
}
