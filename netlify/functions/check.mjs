// netlify/functions/check.mjs
// Check one match URL for a given player (POTM + key stats) and emit a stable fixture fingerprint.
// Fixes: accurate NPG/PG (multi-source), YC/RC from events + facts fallback, robust minutes fallback.

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

// Stable key for a fixture (minute precision)
function mkFixtureKey(leagueId, iso, hId, aId, hName, aName){
  const lid = leagueId ?? 'X';
  const t   = (iso||'').slice(0,16); // YYYY-MM-DDTHH:MM
  const H   = (hId!=null ? `H#${hId}` : `H@${(hName||'').toLowerCase()}`);
  const A   = (aId!=null ? `A#${aId}` : `A@${(aName||'').toLowerCase()}`);
  return `L${lid}|${t}|${H}|${A}`;
}

// ---- General from match __NEXT_DATA__ ----
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
  let exactById=null, bestByName=null, withMinutes=null;
  for(const node of walk(root)){
    const id = asNum(node?.id ?? node?.playerId);
    const full = node?.name?.fullName || node?.name || null;

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
  // direct fields first
  if(Number.isFinite(Number(node.minutesPlayed))) acc.minutes_played = Number(node.minutesPlayed);
  if(node?.rating?.num!=null && Number.isFinite(Number(node.rating.num))) acc.rating = Number(node.rating.num);

  if(!Array.isArray(node.stats)) return acc;

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

// ---------- EVENTS extraction (goals/penalties/assists/cards) ----------
function extractFromEvents(root, playerId, playerName){
  const acc = { goals:0, penalty_goals:0, assists:0, yellow_cards:0, red_cards:0 };
  const tName = normName(playerName||'');

  const matchId = (ev) => {
    const pid = asNum(
      ev?.player?.id ?? ev?.playerId ?? ev?.actor?.id ?? ev?.participant?.id ??
      ev?.subject?.id ?? ev?.player1Id ?? ev?.playerId1
    );
    const nm  = ev?.player?.name?.fullName || ev?.playerName || ev?.player || ev?.actor?.name || ev?.name || ev?.subject?.name || ev?.player1Name || null;
    if(playerId && pid === playerId) return true;
    if(!playerId && nm && normName(nm)===tName) return true;
    if(Array.isArray(ev?.players)){ // some feeds list players array
      for(const pl of ev.players){
        const id = asNum(pl?.id);
        const fn = pl?.name?.fullName || pl?.name;
        if(playerId && id===playerId) return true;
        if(!playerId && fn && normName(fn)===tName) return true;
      }
    }
    return false;
  };

  const assistMatch = (ev) => {
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
    if(!playerId){
      for(const nm of names){ if(nm && normName(nm)===tName) return true; }
    }
    return false;
  };

  const text = (...xs)=> String(xs.find(v=>v!=null) ?? '').toLowerCase();
  const isGoalEvent = (ev) => {
    const t = text(ev.type, ev.eventType, ev.incidentType, ev.key, ev.code, ev.kind, ev.result, ev.action);
    const d = text(ev.detail, ev.subType, ev.scoringType, ev.goalType, ev.outcome, ev.description);
    return t.includes('goal') || d.includes('goal') || t==='score' || t==='scored' || ev?.isGoal===true;
  };
  const isOwnGoal = (ev) => {
    const t = text(ev.detail, ev.subType, ev.scoringType, ev.goalType, ev.description, ev.result);
    return t.includes('own') || ev?.isOwnGoal === true || t.includes('og');
  };
  const isPenaltyGoal = (ev) => {
    const t = text(ev.type, ev.eventType, ev.scoringType, ev.goalType, ev.detail, ev.subType, ev.situation, ev.description, ev.shotType?.name);
    return /pen/.test(t) || ev?.isPenalty === true || ev?.penalty === true || ev?.code === 'penaltyScored';
  };
  const isYellow = (ev) => {
    const t = text(ev.type, ev.eventType, ev.key, ev.card, ev.cardType, ev.kind, ev.incidentType, ev.description, ev.color, ev.code);
    const d = text(ev.detail, ev.subType);
    return t.includes('yellow') || d.includes('yellow') || ev?.card === 'yellow' || ev?.color === 'yellow' || ev?.cardType === 'YELLOW' || ev?.code === 'yellowCard';
  };
  const isRed = (ev) => {
    const t = text(ev.type, ev.eventType, ev.key, ev.card, ev.cardType, ev.kind, ev.incidentType, ev.description, ev.color, ev.code);
    const d = text(ev.detail, ev.subType);
    return t.includes('red') || d.includes('red') || ev?.card === 'red' || ev?.color === 'red' || ev?.cardType === 'RED' || ev?.code === 'redCard' || d.includes('second yellow');
  };

  // Collect arrays that look event-ish
  const arrays = new Set();
  for(const node of walk(root)){
    for (const [k,val] of Object.entries(node||{})){
      if(Array.isArray(val) && val.length){
        const e0 = val[0];
        const lowerKey = String(k).toLowerCase();
        if(
          /event|timeline|incident|card|goal|booking/.test(lowerKey) ||
          (e0 && typeof e0==='object' && (
            'type' in e0 || 'eventType' in e0 || 'key' in e0 || 'card' in e0 ||
            'isGoal' in e0 || 'result' in e0 || 'assist' in e0 || 'player' in e0
          ))
        ){
          arrays.add(val);
        }
      }
    }
  }

  let sawYellowAsSecond = false;
  for(const arr of arrays){
    for(const ev of arr){
      if(!ev || typeof ev!=='object') continue;

      // Goals (exclude own goals)
      if(isGoalEvent(ev) && matchId(ev) && !isOwnGoal(ev)){
        acc.goals += 1;
        if(isPenaltyGoal(ev)) acc.penalty_goals += 1;
      }

      // Assists (on the scoring event)
      if(isGoalEvent(ev) && assistMatch(ev) && !isOwnGoal(ev)){
        acc.assists += 1;
      }

      // Cards
      if(matchId(ev)){
        if(isYellow(ev)) acc.yellow_cards += 1;
        if(isRed(ev)) {
          acc.red_cards += 1;
          if(text(ev.detail).includes('second yellow')) sawYellowAsSecond = true;
        }
      }
    }
  }
  if(sawYellowAsSecond && acc.yellow_cards===0) acc.yellow_cards = 1;

  return acc;
}

// ---- EXTRA FALLBACK just for cards (facts/bookings style blocks) ----
function extractCardsFromFacts(root, playerId, playerName){
  const out = { yellow:0, red:0 };
  const tName = normName(playerName||'');

  const isMe = (obj)=>{
    const id = asNum(obj?.playerId ?? obj?.id ?? obj?.player?.id ?? obj?.personId);
    const nm = obj?.player?.name?.fullName || obj?.playerName || obj?.name || null;
    if(playerId && id === playerId) return true;
    if(!playerId && nm && normName(nm)===tName) return true;
    return false;
  };
  const colorOf = (obj)=>{
    const raw = String(obj?.card ?? obj?.cardType ?? obj?.color ?? obj?.type ?? obj?.code ?? '').toLowerCase();
    if(raw.includes('yellow') || raw==='yc' || raw==='yellowcard' || raw==='yellow_card') return 'yellow';
    if(raw.includes('red')    || raw==='rc' || raw==='redcard'    || raw==='red_card'    || raw==='secondyellow') return 'red';
    if(String(obj?.description||'').toLowerCase().includes('second yellow')) return 'red';
    return null;
  };

  for(const node of walk(root)){
    // common places: matchFacts.cards, facts.bookings, content blocks
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

// ---- Fallback: derive from SHOTMAP if events missing ----
function extractFromShotmap(root, playerId, playerName){
  const acc = { goals:0, penalty_goals:0 };
  const tName = normName(playerName||'');

  for(const node of walk(root)){
    const id   = asNum(node?.id ?? node?.playerId);
    const name = node?.name?.fullName || node?.name || null;

    if(!Array.isArray(node?.shotmap)) continue;
    const isMe = (playerId && id===playerId) || (!playerId && name && normName(name)===tName);
    if(!isMe) continue;

    for(const sh of node.shotmap){
      if(!sh || typeof sh!=='object') continue;
      const goal = sh.isGoal === true || String(sh?.result||'').toLowerCase()==='goal';
      const pen  = sh.isPenalty === true || String(sh?.situation||'').toLowerCase().includes('pen') ||
                   String(sh?.shotType?.name||'').toLowerCase().includes('pen');
      const own  = sh.isOwnGoal === true || String(sh?.description||'').toLowerCase().includes('own');
      if(goal && !own){ acc.goals += 1; if(pen) acc.penalty_goals += 1; }
    }
  }
  return acc;
}

function buildResult(payload){
  const { matchUrl, general, potm, playerNode, playerId, playerName, next } = payload;
  const league_id   = asNum(general.leagueId);
  const league_name = general.leagueName || null;
  const iso         = general.iso || null;
  const allowed     = league_id!=null && TOP5_LEAGUE_IDS.has(league_id);
  const within      = !!iso && inSeason(iso) && (new Date(iso) <= NOW);

  // 1) Base from stats block (may be partial)
  const base = extractStatsFromStatsBlocks(playerNode);
  let goals  = Number.isFinite(base.goals) ? base.goals : null;
  let pg     = Number.isFinite(base.penalty_goals) ? base.penalty_goals : null;
  let ast    = Number.isFinite(base.assists) ? base.assists : 0;
  let yc     = Number.isFinite(base.yellow_cards) ? base.yellow_cards : null;
  let rc     = Number.isFinite(base.red_cards) ? base.red_cards : null;
  let mins   = Number.isFinite(base.minutes_played) ? base.minutes_played : null;
  let rating = Number.isFinite(base.rating) ? base.rating : null;

  // 2) Events (most reliable)
  const evAgg = extractFromEvents(next, playerId, playerName);
  if(!Number.isFinite(goals)) goals = evAgg.goals;
  if(!Number.isFinite(pg))    pg    = evAgg.penalty_goals;
  if(!Number.isFinite(yc))    yc    = evAgg.yellow_cards;
  if(!Number.isFinite(rc))    rc    = evAgg.red_cards;
  if(!Number.isFinite(base.assists) && Number.isFinite(evAgg.assists)) ast = evAgg.assists;

  // 3) Shotmap fallback if still null
  if(!Number.isFinite(goals) || !Number.isFinite(pg)){
    const sm = extractFromShotmap(next, playerId, playerName);
    if(!Number.isFinite(goals)) goals = sm.goals;
    if(!Number.isFinite(pg))    pg    = sm.penalty_goals;
  }

  // 4) Cards fallback from match facts/bookings
  const facts = extractCardsFromFacts(next, playerId, playerName);
  yc = clampInt(Math.max(yc ?? 0, facts.yellow ?? 0));
  rc = clampInt(Math.max(rc ?? 0, facts.red ?? 0));

  // sanitize
  goals = clampInt(goals ?? 0);
  pg    = clampInt(pg ?? 0);
  ast   = clampInt(ast ?? 0);
  mins  = clampInt(mins ?? 0);
  const fmp = mins >= 90;

  // POTM flag for the target player
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
    player_rating: rating!=null ? Number(rating) : null,
    potm_name: potm?.name ? { fullName: potm.name } : null,
    potm_id: potm?.id ?? null,

    // team identity for de-dup
    home_team_id: general.hId ?? null,
    home_team_name: general.hName ?? null,
    away_team_id: general.aId ?? null,
    away_team_name: general.aName ?? null,
    fixture_key,

    player_stats: {
      goals,
      penalty_goals: pg,
      assists: ast,
      yellow_cards: yc,
      red_cards: rc,
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
    const node = (playerId || playerName) ? findPlayerNode(next, playerId||null, playerName||null) : null;

    const out = buildResult({ matchUrl, general, potm, playerNode: node, playerId, playerName, next });
    return resp(200, out);

  }catch(e){
    return resp(200, { error:String(e) });
  }
}
