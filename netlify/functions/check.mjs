// netlify/functions/check.mjs
// Keeps your existing FotMob logic for: POTM, FMP, assists, discovery, de-dup.
// Adds secondary source (SofaScore) ONLY to improve: Penalty goals (PG) & Yellow/Red cards.
// Also removes all "??" usage to avoid bundler error with "||".

// ======= CONFIG =======
const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const SEASON_START = new Date(Date.UTC(2025, 6, 1));                // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));   // 2026-06-30
const NOW          = new Date();

// helper to replace nullish coalescing (a ?? b)
const nz = (v, fallback) => (v === null || v === undefined ? fallback : v);

// Turn SofaScore augmentation on/off via env; defaults ON
const USE_SOFASCORE = (nz(process.env.USE_SOFASCORE, "1") !== "0");

// Shared headers
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const COMMON_HDRS = {
  "user-agent": UA,
  "accept-language": "en-GB,en;q=0.9"
};
const FOTMOB_HDRS = {
  ...COMMON_HDRS,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  referer: "https://www.fotmob.com/"
};
const SOFA_HDRS = {
  ...COMMON_HDRS,
  accept: "application/json,text/plain,*/*",
  referer: "https://www.sofascore.com/"
};

const resp = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clampInt = (v) => Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;

// ======= UTILS =======
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

async function fetchText(url, headers){
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  if (!text) throw new Error("Empty response");
  return { finalUrl: res.url || url, text };
}
async function fetchJSON(url, headers){
  const res = await fetch(url, { headers, redirect: "follow" });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  if (!txt) throw new Error("Empty response");
  try { return { finalUrl: res.url || url, json: JSON.parse(txt) }; }
  catch { throw new Error("Bad JSON from " + url); }
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

// ======= FOTMOB PARSERS =======
function extractGeneral(root){
  let leagueId=null, leagueName=null, iso=null, title=null, mid=null;
  let hId=null, aId=null, hName=null, aName=null;

  const setTeams = (g)=>{
    const home = g?.homeTeam || g?.home || null;
    const away = g?.awayTeam || g?.away || null;
    if(home){ hId = hId !== null && hId !== undefined ? hId : asNum(home.id); hName = hName || (home.name || home.teamName || home.shortName || null); }
    if(away){ aId = aId !== null && aId !== undefined ? aId : asNum(away.id); aName = aName || (away.name || away.teamName || away.shortName || null); }
  };

  for(const node of walk(root)){
    const g = node?.general || node?.overview?.general || node?.match?.general || null;
    if(!g) continue;
    leagueId   = leagueId !== null && leagueId !== undefined ? leagueId : asNum(g.leagueId || g.tournamentId || g.competitionId);
    leagueName = leagueName || (g.leagueName || g.tournamentName || g.competitionName || (g?.league && g.league.name) || (g?.tournament && g.tournament.name) || (g?.competition && g.competition.name));
    iso        = iso || toISO(g.matchTimeUTC || g.startTimeUTC || (g.kickoff && g.kickoff.utc) || g.dateUTC);
    title      = title || (g.pageTitle || g.matchName || g.title);
    mid        = mid !== null && mid !== undefined ? mid : asNum(g.matchId || g.id);
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
  let best = null;
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

// ======= SOFASCORE AUGMENT (only PG + cards) =======
function cleanTeam(s){
  return normName(s).replace(/\b(cf|fc|sc|ac|club|cd|ud|sd|de|real|athletic|atletico)\b/g,'').replace(/[^a-z ]/g,'').replace(/\s+/g,' ').trim();
}
function approxSameTeam(a,b){
  a = cleanTeam(a); b = cleanTeam(b);
  if(a===b) return true;
  return a.includes(b) || b.includes(a);
}

async function findSofaEventId({ homeName, awayName, iso }){
  const q = encodeURIComponent(`${homeName} ${awayName}`);
  const url = `https://api.sofascore.com/api/v1/search/all?q=${q}`;
  const { json } = await fetchJSON(url, SOFA_HDRS);
  const ts = Math.floor(new Date(iso).getTime()/1000);
  const lo = ts - 12*3600, hi = ts + 12*3600;

  const events = (json && (json.events || (json.results && json.results.events))) || [];
  let best = null, bestScore = -1;

  for(const ev of events){
    const start = asNum(ev && ev.startTimestamp);
    if(!start || start < lo || start > hi) continue;

    const hn = (ev && ev.homeTeam && (ev.homeTeam.name || ev.homeTeam.shortName)) || '';
    const an = (ev && ev.awayTeam && (ev.awayTeam.name || ev.awayTeam.shortName)) || '';
    if(!hn || !an) continue;

    const teamHit = (approxSameTeam(hn, homeName) && approxSameTeam(an, awayName)) ||
                    (approxSameTeam(hn, awayName) && approxSameTeam(an, homeName));
    if(!teamHit) continue;

    let score = 0;
    score += 10 - Math.min(10, Math.abs(start - ts)/600);
    if(approxSameTeam(hn, homeName)) score += 2;
    if(approxSameTeam(an, awayName)) score += 2;

    if(score > bestScore){ bestScore = score; best = ev; }
  }

  return best && best.id ? best.id : null;
}

async function sofaIncidentsToCounts(sofaEventId, playerName){
  const { json } = await fetchJSON(`https://api.sofascore.com/api/v1/event/${sofaEventId}/incidents`, SOFA_HDRS);
  const tName = normName(playerName);

  const matchPlayer = (obj)=>{
    const nm = (obj && (obj.player && obj.player.name)) || obj?.playerName || obj?.playerShortName || obj?.playerSlug || obj?.player || null;
    if(nm && normName(nm)===tName) return true;
    const a = obj?.assistant || obj?.assistPlayer;
    if(a && normName((a && a.name) || a)===tName) return true;
    return false;
  };

  let goals=0, pg=0, yc=0, rc=0;

  const all = []
    .concat((json && json.incidents) || [])
    .concat((json && json.events) || [])
    .concat((json && json.timeline) || [])
    .filter(Boolean);

  for(const ev of all){
    const type = String(ev?.type || ev?.incidentType || ev?.category || '').toLowerCase();

    // goals
    if((type.includes('goal') || ev?.isGoal === true) && matchPlayer(ev)){
      goals += 1;
      const pen = (ev && ev.isPenalty === true) ||
                  /pen/.test(String(ev?.goalType||ev?.shotType||ev?.description||'').toLowerCase());
      if(pen) pg += 1;
    }

    // cards
    if((type.includes('card') || ev?.card) && matchPlayer(ev)){
      const color = String(ev?.color || ev?.card || ev?.cardType || '').toLowerCase();
      const desc  = String(ev?.description || ev?.detail || '').toLowerCase();
      if(color.includes('yellow') || ev?.code === 'yellowCard') yc += 1;
      if(color.includes('red')    || ev?.code === 'redCard' || desc.includes('second yellow')) rc += 1;
    }
  }

  return { goals, pg, yc, rc };
}

// ======= BUILD PER-MATCH RESULT =======
function buildFotmobOnly({ matchUrl, general, potm, playerNode, playerId, playerName, next }){
  const league_id   = asNum(general.leagueId);
  const league_name = general.leagueName || null;
  const iso         = general.iso || null;

  const base = extractStatsFromStatsBlocks(playerNode);
  let goals  = clampInt(nz(base.goals, 0));
  let pg     = clampInt(nz(base.penalty_goals, 0));
  let ast    = clampInt(nz(base.assists, 0));
  let yc     = Number.isFinite(base.yellow_cards) ? clampInt(base.yellow_cards) : 0;
  let rc     = Number.isFinite(base.red_cards) ? clampInt(base.red_cards) : 0;
  let mins   = clampInt(nz(base.minutes_played, 0));
  const rating = (base.rating!=null ? Number(base.rating) : null);
  const fmp = mins >= 90;

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
    player_rating: rating,
    potm_name: potm && potm.name ? { fullName: potm.name } : null,
    potm_id: potm ? potm.id : null,

    home_team_id: (general.hId !== undefined ? general.hId : null),
    home_team_name: general.hName || null,
    away_team_id: (general.aId !== undefined ? general.aId : null),
    away_team_name: general.aName || null,
    fixture_key,

    player_stats: {
      goals,
      penalty_goals: pg,
      assists: ast,
      yellow_cards: yc,
      red_cards: rc,
      full_match_played: !!fmp
    },
    echo_player_name: (playerNode && playerNode.name && (playerNode.name.fullName || playerNode.name)) || playerName || null,
    source: "fotmob_html"
  };
}

// ======= MAIN HANDLER =======
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

    // 1) Fetch FotMob HTML + __NEXT_DATA__
    const { text: html } = await fetchText(matchUrl, FOTMOB_HDRS);
    const s = nextDataStr(html);
    if(!s) return resp(200, { error:"NEXT_DATA not found" });
    const next = safeJSON(s);
    if(!next) return resp(200, { error:"NEXT_DATA JSON parse failed" });

    const general = extractGeneral(next);
    const potm = extractPOTM(next) || null;
    const node = (playerId || playerName) ? findPlayerNode(next, playerId||null, playerName||null) : null;

    // 2) Build baseline result from FotMob (keeps your POTM/FMP/assists, etc.)
    const out = buildFotmobOnly({ matchUrl, general, potm, playerNode: node, playerId, playerName, next });

    // 3) Augment PG + YC/RC using SofaScore incidents for valid domestic 2025-26 matches
    if (USE_SOFASCORE && out.league_allowed && out.within_season_2025_26 && out.match_datetime_utc && out.home_team_name && out.away_team_name) {
      try{
        const sofaId = await findSofaEventId({
          homeName: out.home_team_name,
          awayName: out.away_team_name,
          iso: out.match_datetime_utc
        });

        if(sofaId){
          const agg = await sofaIncidentsToCounts(sofaId, out.echo_player_name || playerName);
          // Merge (prefer SofaScore when it finds positive counts)
          if(agg.pg > 0 || out.player_stats.penalty_goals === 0){
            out.player_stats.penalty_goals = clampInt(agg.pg);
          }
          if((agg.goals > 0 && out.player_stats.goals === 0) || agg.goals >= out.player_stats.goals){
            out.player_stats.goals = clampInt(agg.goals);
          }
          if(agg.yc > 0 || out.player_stats.yellow_cards === 0){
            out.player_stats.yellow_cards = clampInt(agg.yc);
          }
          if(agg.rc > 0 || out.player_stats.red_cards === 0){
            out.player_stats.red_cards = clampInt(agg.rc);
          }
          out.source = (out.source || "") + "+sofa_incidents";
        }
      }catch(e){
        out.sofa_error = String(e).slice(0,180); // soft-fail
      }
    }

    return resp(200, out);

  }catch(e){
    return resp(200, { error:String(e) });
  }
}
