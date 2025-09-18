import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

const ALLOWED_LEAGUES = new Set(["premier league", "bundesliga", "laliga", "la liga", "serie a", "ligue 1"]);
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0));      // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));  // 2026-06-30
const POM_REGEXES = [/player of the match/i, /man of the match/i, /jugador(?:a)? del partido/i, /joueur du match/i];
const EMOJI_HINTS = ["🏆", "⭐"];

function norm(s = "") { return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function leagueIsAllowed(label = "") { const n = norm(label); for (const a of ALLOWED_LEAGUES) if (n.includes(a)) return true; return false; }

async function acceptCookies(page) {
  const names = [/Accept.*/i, /Agree.*/i, /Allow all.*/i, /Got it.*/i, /I understand.*/i, /Continue.*/i];
  for (const rx of names) { try { const b = page.getByRole("button", { name: rx }); if ((await b.count()) > 0) { await b.first().click({ timeout: 1500 }); break; } } catch {} }
  for (const f of page.frames()) { for (const rx of names) { try { const b = f.getByRole("button", { name: rx }); if ((await b.count()) > 0) { await b.first().click({ timeout: 1500 }); break; } } catch {} } }
  try { const t = page.locator("text=/accept all|accept|agree/i"); if ((await t.count()) > 0) await t.first().click({ timeout: 1200 }); } catch {}
}
function findInObj(obj, keys) {
  if (Array.isArray(obj)) { for (const it of obj) { const f = findInObj(it, keys); if (f) return f; } }
  else if (obj && typeof obj === "object") { for (const [k, v] of Object.entries(obj)) { if (keys.has(k) && (typeof v === "string" || typeof v === "number")) return String(v); const f = findInObj(v, keys); if (f) return f; } }
  return null;
}
async function parseMatchDatetime(page) {
  try {
    const scripts = page.locator('script[type="application/ld+json"]'); const cnt = await scripts.count();
    for (let i = 0; i < cnt; i++) { const raw = await scripts.nth(i).textContent(); if (!raw) continue; try { const data = JSON.parse(raw); const ts = findInObj(data, new Set(["startDate","startTime","start_date"])); if (ts) { const d = new Date(ts); if (!Number.isNaN(d.getTime())) return d; } } catch {} }
  } catch {}
  try {
    const times = page.locator("time"); const c = await times.count();
    for (let i = 0; i < c; i++) { const dt = await times.nth(i).getAttribute("datetime"); if (dt) { const d = new Date(dt); if (!Number.isNaN(d.getTime())) return d; } }
  } catch {}
  try {
    const t = await page.title(); const body = await page.evaluate(() => document.body.innerText || "");
    for (const s of [t, body]) { if (!s) continue; const d = new Date(s); if (!Number.isNaN(d.getTime())) return d; }
  } catch {}
  return null;
}
async function parseMatchCompetition(page) {
  try {
    const texts = await page.locator('a[href*="/league"], a[href*="/leagues"], a[href*="/table"], a[href*="/tournament"]').allTextContents();
    for (const t of texts) if (leagueIsAllowed(t)) return t.trim();
  } catch {}
  try {
    const scripts = page.locator('script[type="application/ld+json"]'); const cnt = await scripts.count();
    for (let i = 0; i < cnt; i++) { const raw = await scripts.nth(i).textContent(); if (!raw) continue; try { const data = JSON.parse(raw); const name = findInObj(data, new Set(["name"])); if (name && leagueIsAllowed(name)) return name.trim(); } catch {} }
  } catch {}
  try {
    const body = await page.evaluate(() => document.body.innerText || "");
    for (const a of ALLOWED_LEAGUES) if (norm(body).includes(a)) return a;
  } catch {}
  return null;
}
async function findPom(page, playerName) {
  let label = page.locator('[aria-label*="player of the match" i], [aria-label*="man of the match" i]');
  if ((await label.count()) === 0) {
    label = null;
    for (const rx of POM_REGEXES) {
      const loc = page.locator(`text=/${rx.source}/i`);
      if ((await loc.count()) > 0) { label = loc; break; }
    }
  }
  if (!label) {
    for (const em of EMOJI_HINTS) {
      const loc = page.locator(`text=${em}`);
      if ((await loc.count()) > 0) { label = loc; break; }
    }
  }
  if (!label) return { found: false, rating: null, isPom: false };
  let text = "";
  try {
    text = await label.first().evaluate(el => { const host = el.closest("section,article,div") || el; return host.innerText || ""; });
  } catch {
    try { text = await page.evaluate(() => document.body.innerText || ""); } catch { text = ""; }
  }
  const isPom = norm(text).includes(norm(playerName));
  const m = text.match(/\b(\d{1,2}(?:\.\d)?)\b/);
  const rating = m ? Number(m[1]) : null;
  return { found: true, rating: Number.isNaN(rating) ? null : rating, isPom };
}

export async function handler(event) {
  try {
    const payload = event.httpMethod === "POST"
      ? JSON.parse(event.body || "{}")
      : { playerName: event.queryStringParameters?.playerName, matchUrl: event.queryStringParameters?.matchUrl };

    const { playerName, matchUrl } = payload;
    if (!playerName || !matchUrl) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { playerName, matchUrl }" }) };
    }

    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({ executablePath: execPath, args: chromium.args, headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 1600 },
      locale: "en-US",
    });
    const page = await context.newPage();

    const out = { match_url: matchUrl, match_title: null, league_label: null, match_datetime_utc: null, within_season_2025_26: false, league_allowed: false, player_of_the_match_block_found: false, player_is_pom: false, rating: null, error: null };
    try {
      await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await acceptCookies(page);
      await page.waitForSelector("time, :text-matches('Match facts'), :text-matches('Match Facts'), :text-matches('Facts')", { timeout: 12000 }).catch(() => {});
      out.match_title = await page.title();

      const league = await parseMatchCompetition(page); out.league_label = league; out.league_allowed = Boolean(league && leagueIsAllowed(league));
      const mdt = await parseMatchDatetime(page); if (mdt) { out.match_datetime_utc = mdt.toISOString(); out.within_season_2025_26 = mdt >= SEASON_START && mdt <= SEASON_END; }
      const { found, rating, isPom } = await findPom(page, playerName); out.player_of_the_match_block_found = found; out.player_is_pom = isPom; out.rating = rating;
    } catch (e) {
      out.error = String(e);
    } finally {
      await page.close();
      await browser.close();
    }

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
