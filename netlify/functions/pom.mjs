import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

const ALLOWED_LEAGUES = new Set([
  "premier league","bundesliga","laliga","la liga","serie a","ligue 1",
]);
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0)); // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59)); // 2026-06-30
const POM_REGEXES = [/player of the match/i, /man of the match/i, /jugador(?:a)? del partido/i, /joueur du match/i];
const EMOJI_HINTS = ["🏆","⭐"];

function norm(s=""){return s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase();}
function leagueIsAllowed(label=""){const n=norm(label); for(const a of ALLOWED_LEAGUES){ if(n.includes(a)) return true;} return false;}

async function acceptCookiesEverywhere(page){
  const names=[/Accept.*/i,/Agree.*/i,/Allow all.*/i,/Got it.*/i,/I understand.*/i,/Continue.*/i];
  for(const rx of names){try{const b=page.getByRole("button",{name:rx}); if((await b.count())>0){await b.first().click({timeout:2000});break;}}catch{}}
  for(const frame of page.frames()){for(const rx of names){try{const b=frame.getByRole("button",{name:rx}); if((await b.count())>0){await b.first().click({timeout:2000});break;}}catch{}}}
  try{const loc=page.locator("text=/accept all|accept|agree/i"); if((await loc.count())>0) await loc.first().click({timeout:1500});}catch{}
}
async function waitForMatchToLoad(page){
  try{await page.waitForSelector("time, :text-matches('Match facts'), :text-matches('Match Facts'), :text-matches('Facts')",{timeout:12000});}
  catch{await page.waitForTimeout(1500);}
}
async function clickMatchFactsTabIfPresent(page){
  const labels=[/Match facts/i,/Facts/i,/Match Facts/i];
  for(const rx of labels){
    try{const t=page.getByRole("tab",{name:rx}); if((await t.count())>0){await t.first().click({timeout:2500}); await page.waitForTimeout(400); return;}}catch{}
    try{const l=page.getByRole("link",{name:rx}); if((await l.count())>0){await l.first().click({timeout:2500}); await page.waitForTimeout(400); return;}}catch{}
  }
}

function findInObj(obj, keys){
  if(Array.isArray(obj)){for(const it of obj){const f=findInObj(it,keys); if(f) return f;}}
  else if(obj && typeof obj==="object"){for(const [k,v] of Object.entries(obj)){if(keys.has(k) && (typeof v==="string"||typeof v==="number")) return String(v); const f=findInObj(v,keys); if(f) return f;}}
  return null;
}
async function parseMatchDatetime(page){
  try{
    const scripts=page.locator('script[type="application/ld+json"]'); const cnt=await scripts.count();
    for(let i=0;i<cnt;i++){const raw=await scripts.nth(i).textContent(); if(!raw) continue;
      try{const data=JSON.parse(raw); const ts=findInObj(data,new Set(["startDate","startTime","start_date"]));
        if(ts){const d=new Date(ts); if(!Number.isNaN(d.getTime())) return d;}
      }catch{}}
  }catch{}
  try{
    const times=page.locator("time"); const c=await times.count();
    for(let i=0;i<c;i++){const dt=await times.nth(i).getAttribute("datetime"); if(dt){const d=new Date(dt); if(!Number.isNaN(d.getTime())) return d;}}
  }catch{}
  try{
    const t=await page.title(); const body=await page.evaluate(()=>document.body.innerText||"");
    for(const s of [t,body]){ if(!s) continue; const d=new Date(s); if(!Number.isNaN(d.getTime())) return d; }
  }catch{}
  return null;
}
async function parseMatchCompetition(page){
  try{
    const texts=await page.locator('a[href*="/league"], a[href*="/leagues"], a[href*="/table"], a[href*="/tournament"]').allTextContents();
    for(const t of texts){ if(leagueIsAllowed(t)) return t.trim(); }
  }catch{}
  try{
    const scripts=page.locator('script[type="application/ld+json"]'); const cnt=await scripts.count();
    for(let i=0;i<cnt;i++){const raw=await scripts.nth(i).textContent(); if(!raw) continue;
      try{const data=JSON.parse(raw); const name=findInObj(data,new Set(["name"])); if(name && leagueIsAllowed(name)) return name.trim();}catch{}}
  }catch{}
  try{
    const body=await page.evaluate(()=>document.body.innerText||"");
    for(const a of ALLOWED_LEAGUES){ if(norm(body).includes(a)) return a; }
  }catch{}
  return null;
}
async function findPomBlockAndCheckPlayer(page, playerName){
  let label=page.locator('[aria-label*="player of the match" i], [aria-label*="man of the match" i]');
  if((await label.count())===0){
    label=null;
    for(const rx of POM_REGEXES){const loc=page.locator(`text=/${rx.source}/i`); if((await loc.count())>0){label=loc; break;}}
  }
  if(!label){
    for(const em of EMOJI_HINTS){const loc=page.locator(`text=${em}`); if((await loc.count())>0){label=loc; break;}}
  }
  if(!label) return {found:false, rating:null, isPom:false};

  let containerText="";
  try{
    containerText=await label.first().evaluate(el=>{const host=el.closest("section,article,div")||el; return host.innerText||"";});
  }catch{
    try{containerText=await page.evaluate(()=>document.body.innerText||"");}catch{containerText="";}
  }
  const isPom=norm(containerText).includes(norm(playerName));
  const m=containerText.match(/\b(\d{1,2}(?:\.\d)?)\b/);
  const rating=m?Number(m[1]):null;
  return {found:true, rating: Number.isNaN(rating)?null:rating, isPom};
}

async function extractPlayerName(page){
  try{const h1=page.getByRole("heading",{level:1}); if((await h1.count())>0){const t=(await h1.first().textContent())?.trim(); if(t) return t;}}catch{}
  try{const tt=await page.title(); return tt.split(" - ")[0].trim()||tt.trim();}catch{ return ""; }
}
async function collectMatchLinksWithScroll(page, maxLinks, maxScrolls=12){
  const seen=new Set();
  for(let i=0;i<maxScrolls;i++){
    const links=await page.locator('a[href*="/match/"]').evaluateAll(els=>els.map(e=>e.href));
    for(const href of links){ if(!seen.has(href)){ seen.add(href); if(seen.size>=maxLinks) return Array.from(seen).slice(0,maxLinks); } }
    try{await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));}catch{}
    await new Promise(r=>setTimeout(r,800));
  }
  return Array.from(seen).slice(0,maxLinks);
}

async function processMatch(context, matchUrl, playerName, politeDelay){
  const page=await context.newPage();
  const out={match_url:matchUrl, match_title:null, league_label:null, match_datetime_utc:null, within_season_2025_26:false, league_allowed:false, player_of_the_match_block_found:false, player_is_pom:false, rating:null, error:null};
  try{
    await page.goto(matchUrl,{waitUntil:"domcontentloaded",timeout:60000});
    await acceptCookiesEverywhere(page);
    await waitForMatchToLoad(page);
    await clickMatchFactsTabIfPresent(page);

    out.match_title=await page.title();
    const league=await parseMatchCompetition(page); out.league_label=league; out.league_allowed=Boolean(league && leagueIsAllowed(league));
    const mdt=await parseMatchDatetime(page);
    if(mdt){ out.match_datetime_utc=mdt.toISOString(); out.within_season_2025_26=(mdt>=SEASON_START && mdt<=SEASON_END); }

    const {found, rating, isPom}=await findPomBlockAndCheckPlayer(page, playerName);
    out.player_of_the_match_block_found=found; out.player_is_pom=isPom; out.rating=rating;

    await new Promise(r=>setTimeout(r, politeDelay*1000));
  }catch(e){ out.error=String(e); }
  finally{ await page.close(); }
  return out;
}

async function processPlayer(context, playerUrl, maxLinks, delay){
  const page=await context.newPage();
  let playerName="Unknown";
  const results=[];
  try{
    await page.goto(playerUrl,{waitUntil:"domcontentloaded",timeout:60000});
    await acceptCookiesEverywhere(page);
    playerName=(await extractPlayerName(page))||"Unknown";
    const matchLinks=await collectMatchLinksWithScroll(page, maxLinks, 12);
    for(const href of matchLinks){ results.push(await processMatch(context, href, playerName, delay)); }
  } finally { await page.close(); }

  const filtered=results.filter(r=>r.league_allowed && r.within_season_2025_26 && r.player_is_pom);
  return { player_url:playerUrl, player_name:playerName, checked_matches:results.length, pom_2025_26_domestic_count:filtered.length, pom_2025_26_domestic:filtered, raw:results };
}

function toCsv(bundles){
  const headers=["player_name","player_url","match_url","match_title","league_label","match_datetime_utc","rating"];
  const lines=[headers.join(",")];
  for(const b of bundles){
    const pname=(b.player_name||"").replace(/,/g," ");
    const purl=b.player_url||"";
    for(const r of b.pom_2025_26_domestic||[]){
      lines.push([pname,purl,r.match_url||"", (r.match_title||"").replace(/,/g," "), (r.league_label||"").replace(/,/g," "), r.match_datetime_utc||"", (r.rating==null?"":String(r.rating))].join(","));
    }
  }
  return lines.join("\n");
}

export async function handler(event){
  try{
    const { urls=[], maxMatches=60, delay=1.5 } = event.httpMethod==="POST" ? JSON.parse(event.body||"{}") : (event.queryStringParameters||{});
    if(!urls.length || !Array.isArray(urls)) return { statusCode:400, body: JSON.stringify({ error:"Provide body { urls: [ ... ] }" }) };

    // Launch Lambda-compatible Chromium for Playwright
    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: chromium.headless,
    });
    const context = await browser.newContext();

    const allResults=[];
    for(const url of urls){
      try{
        allResults.push(await processPlayer(context, url, Number(maxMatches)||60, Number(delay)||1.5));
      }catch(e){
        allResults.push({ player_url:url, player_name:"Unknown", checked_matches:0, pom_2025_26_domestic_count:0, pom_2025_26_domestic:[], error:String(e) });
      }
    }
    await browser.close();

    // Per-player totals (for convenience in the response)
    const totals = allResults.map(b=>({ player_name:b.player_name, total:b.pom_2025_26_domestic_count }));
    const summary = {
      players_processed: allResults.length,
      total_pom_hits_2025_26_domestic: allResults.reduce((a,b)=>a+(b.pom_2025_26_domestic_count||0),0),
    };

    // Optional CSV (inline as string)
    const csv = toCsv(allResults);

    return {
      statusCode: 200,
      headers: { "content-type":"application/json" },
      body: JSON.stringify({ results: allResults, totals, summary, csv })
    };
  }catch(e){
    return { statusCode:500, body: JSON.stringify({ error: String(e) }) };
  }
}
