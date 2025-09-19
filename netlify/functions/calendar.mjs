// netlify/functions/calendar.mjs
// Return Top-5 domestic league match URLs for a given date window.
// Used as a fast fallback when discover returns zero.

const TOP5_LEAGUE_IDS = new Set([47, 87, 54, 55, 53]); // PL, LaLiga, Bundesliga, Serie A, Ligue 1
const BASE = "https://www.fotmob.com/api/matches?date=";
const EXTRA = "&timezone=UTC";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS = {
  accept: "application/json",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function yyyymmdd(d){const y=d.getUTCFullYear();const m=String(d.getUTCMonth()+1).padStart(2,"0");const day=String(d.getUTCDate()).padStart(2,"0");return `${y}${m}${day}`;}
function* dateRangeUTC(from,to){const c=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth(),from.getUTCDate()));const e=new Date(Date.UTC(to.getUTCFullYear(),to.getUTCMonth(),to.getUTCDate()));for(;c<=e;c.setUTCDate(c.getUTCDate()+1)) yield new Date(c);}

async function fetchJSON(url, retry=2){
  let last;
  for(let i=0;i<=retry;i++){
    try{
      const res = await fetch(url, { headers: HDRS });
      const txt = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200)||""}`);
      return JSON.parse(txt);
    }catch(e){ last=e; await sleep(250+300*i); }
  }
  throw last || new Error("fetch failed");
}

async function getMatches(fromStr,toStr,concurrency=2){
  const fromUTC = new Date(Date.UTC(+fromStr.slice(0,4), +fromStr.slice(4,6)-1, +fromStr.slice(6,8)));
  const toUTC   = new Date(Date.UTC(+toStr.slice(0,4), +toStr.slice(4,6)-1, +toStr.slice(6,8)));
  const dates = Array.from(dateRangeUTC(fromUTC,toUTC));
  let idx=0;
  const ids = new Set();
  const fails = [];

  async function worker(){
    while(idx<dates.length){
      const i = idx++;
      const d = dates[i];
      const key = yyyymmdd(d);
      try{
        const data = await fetchJSON(`${BASE}${key}${EXTRA}`);
        for(const lg of data?.leagues ?? []){
          const lid = Number(lg?.primaryId);
          if(!TOP5_LEAGUE_IDS.has(lid)) continue;
          for(const m of lg?.matches ?? []){
            const id = String(m?.id ?? "").trim();
            if(id) ids.add(id);
          }
        }
      }catch(e){
        if(fails.length<6) fails.push({ date:key, error:String(e).slice(0,200) });
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency, dates.length)}, worker));
  return { urls: Array.from(ids).map(id => `https://www.fotmob.com/match/${id}`), fails };
}

export async function handler(event){
  try{
    let payload = {};
    if(event.httpMethod === "POST"){
      try{ payload = JSON.parse(event.body||"{}"); }
      catch{ return { statusCode:400, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:"Invalid JSON body" }) }; }
    }else{
      payload = { from: event.queryStringParameters?.from, to: event.queryStringParameters?.to };
    }

    const fromStr = payload.from || "20250701";
    const now = new Date();
    const toDefault = yyyymmdd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    const toStr = payload.to || toDefault;

    const { urls, fails } = await getMatches(fromStr, toStr, 2);

    return { statusCode:200, headers:{ "content-type":"application/json" },
      body: JSON.stringify({ ok:true, match_urls: urls, debug:{ window_from:fromStr, window_to:toStr, failed_days:fails } }) };
  }catch(e){
    return { statusCode:500, headers:{ "content-type":"application/json" }, body: JSON.stringify({ error:String(e) }) };
  }
}
