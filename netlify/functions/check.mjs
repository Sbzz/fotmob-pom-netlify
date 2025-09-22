// =============================
// netlify/functions/check.mjs
// =============================
// Fixes PG/NPG and RC via event dedup + strict penalty detection + sane clamps.
// Adds minutes_played + player_did_play flag. Leaves discovery, POTM, FMP, league/season filters, fixture key, and UI contract unchanged.

const TOP5_LEAGUE_IDS_C = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START_C = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END_C   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30
const NOW_C          = new Date();

const nz = (v, d) => (v === null || v === undefined ? d : v);
const asNumC = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clampInt = (v) => Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;

const UA_C = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const HDRS_C = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": UA_C,
  referer: "https://www.fotmob.com/",
  "accept-language": "en-GB,en;q=0.9"
};

const respC = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

function toISOC(v){
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (Number.isFinite(n)) {
    const d = new Date(n > 1e12 ? n : n * 1000);
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
function inSeasonC(iso){
  if(!iso) return false;
  const d = new Date(iso);
  return d >= SEASON_START_C && d <= SEASON_END_C && d <= NOW_C;
}

async function fetchTextC(url){
  const r = await fetch(url, { headers: HDRS_C, redirect: "follow" });
  const html = await r.text();
  if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  if(!html) throw new Error("Empty HTML");
  return { html, finalUrl: r.url || url };
}
function nextDataStrC(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : null;
}
function safeJSONC(s){ try{ return JSON.parse(s); }catch{ return null; } }

function* walkC(root){
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
    if(home){ hId = (hId!==null && hId!==undefined) ? hId : asNumC(home.id); hName = hName || (home.name || home.teamName || home.shortName || null); }
    if(away){ aId = (aId!==null && aId!==undefined) ? aId : asNumC(away.id); aName = aName || (away.name || away.teamName || away.shortName || null); }
  };

  for(const node of walkC(root)){
    const g = node?.general || node?.overview?.general || node?.match?.general || null;
    if(!g) continue;
    leagueId   = (leagueId!==null && leagueId!==undefined) ? leagueId : asNumC(g.leagueId || g.tournamentId || g.competitionId);
    leagueName = leagueName || (g.leagueName || g.tournamentName || g.competitionName || g?.league?.name || g?.tournament?.name || g?.competition?.name);
    iso        = iso || toISOC(g.matchTimeUTC || g.startTimeUTC || g?.kickoff?.utc || g.dateUTC);
    title      = title || (g.pageTitle || g.matchName || g.title);
    mid        = (mid!==null && mid!==undefined) ? mid : asNumC(g.matchId || g.id);
    setTeams(g);
    if(leagueId && iso && (hId||hName) && (aId||aName)) break;
  }
  if(!title){
    for(const node of walkC(root)){ if(node?.seo?.title){ title=node.seo.title; break; } }
  }
  if(!mid){
    for(const node of walkC(root)){ if(asNumC(node?.matchId)){ mid=asNumC(node.matchId); break; } }
  }
  return { leagueId, leagueName, iso, title, matchId: mid, hId, aId, hName, aName };
}

function extractPOTM(root){
  for(const node of walkC(root)){
    const potm = node?.playerOfTheMatch || node?.potm || node?.manOfTheMatch;
    if(potm && (potm.id || potm.playerId || potm.name)){
      const id = asNumC(potm.id || potm.playerId);
      const nm = (potm.name && (potm.name.fullName || potm.name)) || (potm.firstName && potm.lastName ? `${potm.firstName} ${potm.lastName}` : null);
      const ratingNum = asNumC((potm.rating && potm.rating.num) || potm.rating);
      return { id, name: nm, rating: ratingNum };
    }
  }
  // fallback: best finished rating
  let best=null;
  for(const node of walkC(root)){
    if(!node?.rating) continue;
    const isTop = node?.rating?.isTop?.isTopRating;
    const finished = node?.rating?.isTop?.isMatchFinished;
    if(!isTop || !finished) continue;
    const cand = {
      id: asNumC(node.id || node.playerId),
      name: (node?.name && (node.name.fullName || node.name)) || null,
      rating: asNumC(node?.rating?.num)
    };
    if(cand.id || cand.name){
      if(!best || (asNumC(cand.rating)||0) > (asNumC(best.rating)||0)) best = cand;
    }
  }
  return best;
}

function findPlayerNode(root, playerId, playerName){
  const targetName = normName(playerName||'');
  let exactById=null, bestByName=null, withMinutes=null;
  for(const node of walkC(root)){
    const id = asNumC(node?.id || node?.playerId);
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

// ---------- EVENTS & FALLBACKS (with dedup + sane clamps) ----------
function extractFromEvents(root, playerId, playerName){
  const acc = { goals:0, penalty_goals:0, assists:0, yellow_cards:0, red_cards:0 };
  const tName = normName(playerName||'');

  const val = (x)=> (x===null || x===undefined) ? '' : String(x).toLowerCase();
  const num = (x)=> (x===null || x===undefined) ? null : Number(x);

  const minuteOf = (e)=>{
    return num(e?.minute) ??
           num(e?.time) ??
           num(e?.clock?.minute) ??
           num(e?.timeMin) ??
           num(e?.min) ??
           null;
  };
  const secondOf = (e)=>{
    return num(e?.second) ??
           num(e?.clock?.second) ??
           num(e?.timeSec) ??
           null;
  };
  const playerIdOf = (e)=>{
    return asNumC(
      e?.player?.id || e?.playerId || e?.actor?.id || e?.participant?.id ||
      e?.subject?.id || e?.player1Id || e?.playerId1
    );
  };
  const playerNameOf = (e)=>{
    return e?.player?.name?.fullName || e?.playerName || e?.player || e?.actor?.name || e?.name || e?.subject?.name || e?.player1Name || '';
  };
  const sideOf = (e)=>{
    const t = e?.team || e?.teamId || e?.side || e?.isHomeTeam;
    if(typeof t === 'boolean') return t ? 'home' : 'away';
    return String(t||'');
  };

  const isShootout = (e)=>{
    const s = [
      e?.period, e?.phase, e?.stage, e?.description, e?.detail, e?.subType, e?.result
    ].map(val).join('|');
    return /shoot-?out|penalty shootout|penalties shootout/.test(s);
  };

  const matchByPlayer = (e)=>{
    const pid = playerIdOf(e);
    const nm  = playerNameOf(e);
    if(playerId && pid === playerId) return true;
    if(!playerId && nm && normName(nm)===tName) return true;
    if(Array.isArray(e?.players)){
      for(const p of e.players){
        const id = asNumC(p?.id);
        const fn = p?.name?.fullName || p?.name;
        if(playerId && id===playerId) return true;
        if(!playerId && fn && normName(fn)===tName) return true;
      }
    }
    return false;
  };

  const isGoalEvent = (e) => {
    const t = [e?.type, e?.eventType, e?.incidentType, e?.key, e?.code, e?.kind, e?.result, e?.action].map(val).join('|');
    const d = [e?.detail, e?.subType, e?.scoringType, e?.goalType, e?.outcome, e?.description].map(val).join('|');
    return t.includes('goal') || d.includes('goal') || t.includes('score') || t.includes('scored') ||
           d.includes('scored') || (t.includes('penalty') && d.includes('scored')) || e?.isGoal === true;
  };
  const isOwnGoal = (e) => {
    const s = [e?.detail, e?.subType, e?.scoringType, e?.goalType, e?.description, e?.result].map(val).join('|');
    return s.includes('own') || s.includes('og') || e?.isOwnGoal === true;
  };
  const isPenaltyGoal = (e) => {
    // only evaluated on confirmed goals; detects multiple penalty wordings
    const s = [
      e?.type, e?.eventType, e?.scoringType, e?.goalType, e?.detail, e?.subType, e?.situation, e?.description,
      e?.shotType && e.shotType.name, e?.code, e?.result
    ].map(val).join('|');
    return s.includes('penalty') || s.includes(' pen') || s.includes('pen ') || s.includes('pen_') ||
           s.includes('from penalty') || s.includes('penalty kick') || s.includes('penaltykick') ||
           s.includes('penaltyscored') || e?.isPenalty === true || e?.penalty === true;
  };

  const isYellow = (e) => {
    const cardObj = e?.card || e?.booking || e?.bookingCard || null;
    const cardColor = cardObj && (cardObj.color || cardObj.type || cardObj.name) ? String(cardObj.color || cardObj.type || cardObj.name).toLowerCase() : '';
    const s = [
      e?.type, e?.eventType, e?.key, e?.card, e?.cardType, e?.kind, e?.incidentType, e?.description, e?.color, e?.code,
      e?.detail, e?.subType, cardColor
    ].map(val).join('|');
    return s.includes('yellow') || s.includes('yellowcard') || s.includes('yc');
  };
  const isRed = (e) => {
    const cardObj = e?.card || e?.booking || e?.bookingCard || null;
    const cardColor = cardObj && (cardObj.color || cardObj.type || cardObj.name) ? String(cardObj.color || cardObj.type || cardObj.name).toLowerCase() : '';
    const s = [
      e?.type, e?.eventType, e?.key, e?.card, e?.cardType, e?.kind, e?.incidentType, e?.description, e?.color, e?.code,
      e?.detail, e?.subType, cardColor
    ].map(val).join('|');
    return s.includes('red') || s.includes('redcard') || s.includes('rc') || s.includes('second yellow');
  };

  const eventId = (e)=>{
    return String(
      nz(asNumC(e?.id), '') ||
      nz(asNumC(e?.eventId), '') ||
      nz(asNumC(e?.incidentId), '') ||
      ''
    );
  };
  const goalKey = (e, isPen)=>{
    const m = nz(minuteOf(e), -1);
    const s = nz(secondOf(e), -1);
    const pid = nz(playerIdOf(e), -1);
    const nm  = normName(playerNameOf(e));
    const side = sideOf(e);
    const id = eventId(e);
    return id ? `G#${id}` : `G|m${m}|s${s}|p${pid}|n:${nm}|pen:${isPen?'1':'0'}|sd:${side}`;
  };
  const cardKey = (e, kind)=>{
    const m = nz(minuteOf(e), -1);
    const s = nz(secondOf(e), -1);
    const pid = nz(playerIdOf(e), -1);
    const nm  = normName(playerNameOf(e));
    const side = sideOf(e);
    const id = eventId(e);
    return id ? `C#${id}` : `C|${kind}|m${m}|s${s}|p${pid}|n:${nm}|sd:${side}`;
  };

  // flatten & dedup across all event-like arrays
  const arrays = new Set();
  for(const node of walkC(root)){
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

  const seenGoals = new Set();
  const seenCards = new Set();
  let sawSecondYellowText = false;

  for(const arr of arrays){
    for(const e of arr){
      if(!e || typeof e!=='object') continue;
      if(isShootout(e)) continue; // ignore penalty shootouts

      // GOALS
      if(isGoalEvent(e) && matchByPlayer(e) && !isOwnGoal(e)){
        const pen = isPenaltyGoal(e);
        const k = goalKey(e, pen);
        if(!seenGoals.has(k)){
          seenGoals.add(k);
          acc.goals += 1;
          if(pen) acc.penalty_goals += 1;
        }
      }

      // ASSISTS (fallback only)
      const hasGoalShape = isGoalEvent(e) && !isOwnGoal(e);
      if(hasGoalShape){
        const aIds = [];
        const aNames = [];
        if (e?.assist) { aIds.push(asNumC(e.assist.id)); aNames.push(e.assist?.name?.fullName || e.assistName); }
        if (e?.assistId!=null) aIds.push(asNumC(e.assistId));
        if (e?.assisterId!=null) aIds.push(asNumC(e.assisterId));
        if (e?.assistPlayerId!=null) aIds.push(asNumC(e.assistPlayerId));
        if (e?.secondaryPlayerId!=null) aIds.push(asNumC(e.secondaryPlayerId));
        if (Array.isArray(e?.assists)) for(const a of e.assists){ aIds.push(asNumC(a?.id)); aNames.push(a?.name?.fullName||a?.name); }
        if (Array.isArray(e?.assistPlayers)) for(const a of e.assistPlayers){ aIds.push(asNumC(a?.id)); aNames.push(a?.name?.fullName||a?.name); }
        const scorerIsMe = matchByPlayer(e);
        if(!scorerIsMe){
          const meById = (playerId && aIds.some(id => id===playerId));
          const meByName = (!playerId && aNames.some(nm => nm && normName(nm)===tName));
          if(meById || meByName) acc.assists += 1;
        }
      }

      // CARDS
      if(matchByPlayer(e)){
        if(isYellow(e)){
          const k = cardKey(e, 'Y');
          if(!seenCards.has(k)){
            seenCards.add(k);
            acc.yellow_cards += 1;
          }
        }
        if(isRed(e)){
          const k = cardKey(e, 'R');
          if(!seenCards.has(k)){
            seenCards.add(k);
            acc.red_cards += 1;
          }
          const det = String(nz(e.detail,'') + ' ' + nz(e.description,'')).toLowerCase();
          if(det.includes('second yellow')) sawSecondYellowText = true;
        }
      }
    }
  }

  if(sawSecondYellowText && acc.yellow_cards===0) acc.yellow_cards = 1;

  return acc;
}

// Fallback just for cards if timeline is sparse (facts/bookings/cards blocks)
function extractCardsFromFacts(root, playerId, playerName){
  const out = { yellow:0, red:0 };
  const tName = normName(playerName||'');

  const isMe = (obj)=>{
    const id = asNumC(obj?.playerId || obj?.id || obj?.player?.id || obj?.personId);
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

  for(const node of walkC(root)){
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

  for(const node of walkC(root)){
    const id   = asNumC(node?.id || node?.playerId);
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
  const league_id   = asNumC(general.leagueId);
  const league_name = general.leagueName || null;
  const iso         = general.iso || null;

  // 1) Base stats block
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

  // PG: prefer events; then shotmap; then stats
  let pg = (ev.penalty_goals > 0 ? ev.penalty_goals :
           (sm.penalty_goals > 0 ? sm.penalty_goals :
           (Number.isFinite(pg_stat) ? pg_stat : 0)));

  // Ensure PG never exceeds goals
  if(pg > goals) pg = goals;

  // Assists: keep stats unless missing -> use events
  let assists = ast || ev.assists || 0;

  // Cards: prefer events; then facts/bookings; then stats
  const facts = extractCardsFromFacts(next, playerId, playerName);
  let yc = (ev.yellow_cards > 0 ? ev.yellow_cards : (facts.yellow > 0 ? facts.yellow : (Number.isFinite(yc_stat) ? yc_stat : 0)));
  let rc = (ev.red_cards    > 0 ? ev.red_cards    : (facts.red    > 0 ? facts.red    : (Number.isFinite(rc_stat) ? rc_stat : 0)));

  // Clamp RC to max 1 (sent off once)
  if(rc > 1) rc = 1;

  // Minutes → FMP
  const fmp = clampInt(mins) >= 90;

  // POTM flag
  const pid = asNumC(playerId);
  const player_is_pom =
    !!potm && ((pid && potm.id && pid === potm.id) || (!pid && potm.name && normName(potm.name) === normName(playerName||'')));

  const fixture_key = mkFixtureKey(
    league_id, iso,
    general.hId, general.aId,
    general.hName, general.aName
  );

  // Appearance flag (useful for frontend DNP filter)
  const appeared = (clampInt(mins) > 0) ||
                   (Number.isFinite(rating)) ||
                   ((goals+assists+yc+rc+pg) > 0);

  return {
    match_url: matchUrl,
    resolved_match_id: general.matchId ? String(general.matchId) : ((matchUrl.match(/\/match\/(\d+)/) || [])[1] || null),
    match_title: general.title || "match",
    league_id,
    league_label: league_name,
    match_datetime_utc: iso,
    league_allowed: (league_id !== null && league_id !== undefined) && TOP5_LEAGUE_IDS_C.has(league_id),
    within_season_2025_26: !!iso && inSeasonC(iso),

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
      full_match_played: !!fmp,
      minutes_played: clampInt(mins)
    },
    player_did_play: appeared,
    echo_player_name: (playerNode && playerNode.name && (playerNode.name.fullName || playerNode.name)) || playerName || null,
    source: "fotmob_html+events_dedup"
  };
}

// ---------- Handler ----------
export async function handler(event){
  try{
    if(event.httpMethod!=="POST"){
      return respC(400, { error:"POST required" });
    }
    let body={};
    try{ body = JSON.parse(event.body||"{}"); }catch{ return respC(400,{ error:"Bad JSON" }); }

    const matchUrl = String(body.matchUrl||"").trim();
    const playerId = asNumC(body.playerId);
    const playerName = String(body.playerName||"").trim();
    if(!/\/match\/(\d+)/.test(matchUrl)) return respC(200,{ error:"Provide matchUrl like https://www.fotmob.com/match/123456" });

    const { html } = await fetchTextC(matchUrl);
    const s = nextDataStrC(html);
    if(!s) return respC(200, { error:"NEXT_DATA not found" });
    const next = safeJSONC(s);
    if(!next) return respC(200, { error:"NEXT_DATA JSON parse failed" });

    const general = extractGeneral(next);
    const potm = extractPOTM(next) || null;
    const node = (playerId || playerName) ? findPlayerNode(next, playerId||null, playerName||null) : null;

    const out = buildResult({ matchUrl, general, potm, playerNode: node, playerId, playerName, next });
    return respC(200, out);

  }catch(e){
    return respC(200, { error:String(e) });
  }
}
