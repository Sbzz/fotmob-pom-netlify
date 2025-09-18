import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

/** =======================
 *  CONFIG
 *  ======================= */
const ALLOWED_LEAGUES = new Set([
  "premier league",
  "bundesliga",
  "laliga",
  "la liga",
  "serie a",
  "ligue 1",
]);
const SEASON_START = new Date(Date.UTC(2025, 6, 1, 0, 0, 0));      // 2025-07-01
const SEASON_END   = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));  // 2026-06-30
const POM_REGEXES = [
  /player of the match/i,
  /man of the match/i,
  /jugador(?:a)? del partido/i, // ES
  /joueur du match/i,           // FR
];
const EMOJI_HINTS = ["🏆", "⭐"];

/** =======================
 *  UTILS
 *  ======================= */
function norm(s = "") {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function leagueIsAllowed(label = "") {
  const n = norm(label);
  for (const allowed of ALLOWED_LEAGUES) if (n.includes(allowed)) return true;
  return false;
}
async function smallPause(ms = 350) {
  await new Promise(r => setTimeout(r, ms));
}

/** =======================
 *  CONSENT / HYDRATION
 *  ======================= */
async function acceptCookiesEverywhere(page) {
  const names = [/Accept.*/i, /Agree.*/i, /Allow all.*/i, /Got it.*/i, /I understand.*/i, /Continue.*/i];
  for (const rx of names) {
    try {
      const btn = page.getByRole("button", { name: rx });
      if ((await btn.count()) > 0) { await btn.first().click({ timeout: 2000 }); break; }
    } catch {}
  }
  for (const frame of page.frames()) {
    for (const rx of names) {
      try {
        const btn = frame.getByRole("button", { name: rx });
        if ((await btn.count()) > 0) { await btn.first().click({ timeout: 2000 }); break; }
      } catch {}
    }
  }
  try {
    const loc = page.locator("text=/accept all|accept|agree/i");
    if ((await loc.count()) > 0) await loc.first().click({ timeout: 1500 });
  } catch {}
}
async function waitForMatchToLoad(page) {
  try {
    await page.waitForSelector("time, :text-matches('Match facts'), :text-matches('Match Facts'), :text-matches('Facts')", { timeout: 12000 });
  } catch {
    await page.waitForTimeout(1200);
  }
}
async function clickMatchFactsTabIfPresent(page) {
  const labels = [/Match facts/i, /Facts/i, /Match Facts/i];
  for (const rx of labels) {
    try {
      const tab = page.getByRole("tab", { name: rx });
      if ((await tab.count()) > 0) { await tab.first().click({ timeout: 2500 }); await page.waitForTimeout(400); return; }
    } catch {}
    try {
      const link = page.getByRole("link", { name: rx });
      if ((await link.count()) > 0) { await link.first().click({ timeout: 2500 }); await page.waitForTimeout(400); return; }
    } catch {}
  }
}

/** =======================
 *  JSON-LD helpers
 *  ======================= */
function findInObj(obj, keys) {
  if (Array.isArray(obj)) {
    for (const it of obj) { const f = findInObj(it, keys); if (f) return f; }
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (keys.has(k) && (typeof v === "string" || typeof v === "number")) return String(v);
      const f = findInObj(v, keys); if (f) return f;
    }
  }
  return null;
}
async function parseMatchDatetime(page) {
  // JSON-LD first
  try {
    const scripts = page.locator('script[type="application/ld+json"]');
    const cnt = await scripts.count();
    for (let i = 0; i < cnt; i++) {
      const raw = await scripts.nth(i).textContent();
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        const ts = findInObj(data, new Set(["startDate", "startTime", "start_date"]));
        if (ts) {
          const d = new Date(ts);
          if (!Number.isNaN(d.getTime())) return d;
        }
      } catch {}
    }
  } catch {}
  // <time datetime="...">
  try {
    const times = page.locator("time");
    const c = await times.count();
    for (let i = 0; i < c; i++) {
      const dt = await times.nth(i).getAttribute("datetime");
      if (dt) {
        const d = new Date(dt);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  } catch {}
  // Fallback: title/body parse
  try {
    const t = await page.title();
    const body = await page.evaluate(() => document.body.innerText || "");
    for (const s of [t, body]) {
      if (!s) continue;
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {}
  return null;
}
async function parseMatchCompetition(page) {
  // Links/breadcrumbs
  try {
    const texts = await page
      .locator('a[href*="/league"], a[href*="/leagues"], a[href*="/table"], a[href*="/tournament"]')
      .allTextContents();
    for (const t of texts) {
      if (leagueIsAllowed(t)) return t.trim();
    }
  } catch {}
  // JSON-LD name
  try {
    const scripts = page.locator('script[type="application/ld+json"]');
    const cnt = await scripts.count();
    for (let i = 0; i < cnt; i++) {
      const raw = await scripts.nth(i).textContent();
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        const name = findInObj(data, new Set(["name"]));
        if (name && leagueIsAllowed(name)) return name.trim();
      } catch {}
    }
  } catch {}
  // Fallback scan
  try {
    const body = await page.evaluate(() => document.body.innerText || "");
    for (const allowed of ALLOWED_LEAGUES) {
      if (norm(body).includes(allowed)) return allowed;
    }
  } catch {}
  return null;
}
async function findPomBlockAndCheckPlayer(page, playerName) {
  // aria-label first
  let label = page.locator('[aria-label*="player of the match" i], [aria-label*="man of the match" i]');
  if ((await label.count()) === 0) {
    // visible text variants
    label = null;
    for (const rx of POM_REGEXES) {
      const loc = page.locator(`text=/${rx.source}/i`);
      if ((await loc.count()) > 0) { label = loc; break; }
    }
  }
  // emoji hint
  if (!label) {
    for (const em of EMOJI_HINTS) {
      const loc = page.locator(`text=${em}`);
      if ((await loc.count()) > 0) { label = loc; break; }
    }
  }
  if (!label) return { found: false, rating: null, isPom: false };

  let containerText = "";
  try {
    containerText = await label.first().evaluate((el) => {
      const host = el.closest("section,article,div") || el;
      return host.innerText || "";
    });
  } catch {
    try { containerText = await page.evaluate(() => document.body.innerText || ""); }
    catch { containerText = ""; }
  }
  const isPom = norm(containerText).includes(norm(playerName));
  const m = containerText.match(/\b(\d{1,2}(?:\.\d)?)\b/);
  const rating = m ? Number(m[1]) : null;
  return { found: true, rating: Number.isNaN(rating) ? null : rating, isPom };
}

/** =======================
 *  PLAYER PAGE HELPERS
 *  ======================= */
async function extractPlayerName(page) {
  try {
    const h1 = page.getByRole("heading", { level: 1 });
    if ((await h1.count()) > 0) {
      const txt = (await h1.first().textContent())?.trim();
      if (txt) return txt;
    }
  } catch {}
  try {
    const t = await page.title();
    return t.split(" - ")[0].trim() || t.trim();
  } catch { return ""; }
}

// Grab /match/<id> in multiple ways; return { urls, debug }
async function collectMatchLinksMulti(page, maxLinks, maxScrolls = 10) {
  const hrefs = new Set();
  const debug = { anchors: 0, nextData: 0, htmlRegex: 0, clickedRows: 0 };

  // 0) Try to switch to a list view of matches if there's a toggle
  try {
    const allMatches = page.getByText(/All matches|Matches|Fixtures/i).first();
    if ((await allMatches.count()) > 0) {
      await allMatches.click({ timeout: 2000 }).catch(() => {});
      await smallPause(400);
    }
  } catch {}

  // 1) Scroll and collect <a href="/match/...">
  for (let i = 0; i < maxScrolls && hrefs.size < maxLinks; i++) {
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
    await smallPause(600);

    const links = await page
      .locator('a[href*="/match/"]')
      .evaluateAll((els) => Array.from(new Set(els.map((e) => e.href))));
    debug.anchors += links.length;
    for (const h of links) {
      hrefs.add(h);
      if (hrefs.size >= maxLinks) return { urls: Array.from(hrefs).slice(0, maxLinks), debug };
    }
  }

  // 2) Parse Next.js bootstrap data for any "/match/<id>"
  try {
    const raw = await page.evaluate(() => {
      try {
        if (window.__NEXT_DATA__) return JSON.stringify(window.__NEXT_DATA__);
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : null;
      } catch { return null; }
    });
    if (raw) {
      try {
        const str = typeof raw === "string" ? raw : JSON.stringify(raw);
        const re = /\/match\/(\d+)/g;
        let m;
        const nextUrls = new Set();
        while ((m = re.exec(str)) !== null) {
          nextUrls.add(`https://www.fotmob.com/match/${m[1]}`);
        }
        debug.nextData = nextUrls.size;
        for (const u of nextUrls) {
          hrefs.add(u);
          if (hrefs.size >= maxLinks) return { urls: Array.from(hrefs).slice(0, maxLinks), debug };
        }
      } catch {}
    }
  } catch {}

  // 3) Regex over full HTML (as final fallback)
  try {
    const html = await page.content();
    const re = /href="\/match\/(\d+)"/g;
    let m; let fromHtml = 0;
    while ((m = re.exec(html)) !== null) {
      hrefs.add(`https://www.fotmob.com/match/${m[1]}`);
      fromHtml++;
      if (hrefs.size >= maxLinks) break;
    }
    debug.htmlRegex = fromHtml;
    if (hrefs.size >= maxLinks) return { urls: Array.from(hrefs).slice(0, maxLinks), debug };
  } catch {}

  // 4) As a last resort, probe-click some candidate rows/cards and record navigation
  const candidates = page.locator('a, [role="link"], [role="button"], article, li, div[tabindex], div[class*="row"], tr');
  const limit = Math.min(await candidates.count(), maxLinks * 3);
  for (let i = 0; i < limit && hrefs.size < maxLinks; i++) {
    const el = candidates.nth(i);
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 1500 });
      const nav = page.waitForNavigation({ timeout: 3500 }).catch(() => null);
      await el.click({ timeout: 1200 }).catch(() => {});
      await nav;
      const urlNow = page.url();
      if (urlNow.includes("/match/")) {
        hrefs.add(urlNow);
        debug.clickedRows++;
        await page.goBack({ timeout: 7000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await smallPause(300);
      }
    } catch {}
  }

  return { urls: Array.from(hrefs).slice(0, maxLinks), debug };
}

/** =======================
 *  CORE SCRAPERS
 *  ======================= */
async function processMatch(context, matchUrl, playerName, politeDelay) {
  const page = await context.newPage();
  const out = {
    match_url: matchUrl,
    match_title: null,
    league_label: null,
    match_datetime_utc: null,
    within_season_2025_26: false,
    league_allowed: false,
    player_of_the_match_block_found: false,
    player_is_pom: false,
    rating: null,
    error: null,
  };
  try {
    await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookiesEverywhere(page);
    await waitForMatchToLoad(page);
    await clickMatchFactsTabIfPresent(page);

    out.match_title = await page.title();

    const league = await parseMatchCompetition(page);
    out.league_label = league;
    out.league_allowed = Boolean(league && leagueIsAllowed(league));

    const mdt = await parseMatchDatetime(page);
    if (mdt) {
      out.match_datetime_utc = mdt.toISOString();
      out.within_season_2025_26 = mdt >= SEASON_START && mdt <= SEASON_END;
    }

    const { found, rating, isPom } = await findPomBlockAndCheckPlayer(page, playerName);
    out.player_of_the_match_block_found = found;
    out.player_is_pom = isPom;
    out.rating = rating;

    await new Promise((r) => setTimeout(r, politeDelay * 1000));
  } catch (e) {
    out.error = String(e);
  } finally {
    await page.close();
  }
  return out;
}

async function processPlayer(context, playerUrl, maxLinks, delay) {
  const page = await context.newPage();
  let playerName = "Unknown";
  const results = [];
  const debug = { anchors: 0, nextData: 0, htmlRegex: 0, clickedRows: 0 };
  try {
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookiesEverywhere(page);

    // Prefer desktop-like layout
    try { await page.setViewportSize({ width: 1360, height: 2200 }); } catch {}
    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}

    playerName = (await extractPlayerName(page)) || "Unknown";

    const { urls, debug: dbg } = await collectMatchLinksMulti(page, maxLinks, 12);
    Object.assign(debug, dbg);

    for (const href of urls) {
      const info = await processMatch(context, href, playerName, delay);
      results.push(info);
    }
  } finally {
    await page.close();
  }

  const filtered = results.filter(
    (r) => r.league_allowed && r.within_season_2025_26 && r.player_is_pom
  );

  return {
    player_url: playerUrl,
    player_name: playerName,
    checked_matches: results.length,
    pom_2025_26_domestic_count: filtered.length,
    pom_2025_26_domestic: filtered,
    raw: results,
    debug, // <— NEW: shows how many links each method found
  };
}

/** =======================
 *  CSV + HANDLER
 *  ======================= */
function toCsv(bundles) {
  const headers = [
    "player_name",
    "player_url",
    "match_url",
    "match_title",
    "league_label",
    "match_datetime_utc",
    "rating",
  ];
  const lines = [headers.join(",")];
  for (const b of bundles) {
    const pname = (b.player_name || "").replace(/,/g, " ");
    const purl = b.player_url || "";
    for (const r of b.pom_2025_26_domestic || []) {
      lines.push([
        pname,
        purl,
        r.match_url || "",
        (r.match_title || "").replace(/,/g, " "),
        (r.league_label || "").replace(/,/g, " "),
        r.match_datetime_utc || "",
        r.rating == null ? "" : String(r.rating),
      ].join(","));
    }
  }
  return lines.join("\n");
}

export async function handler(event) {
  try {
    // Safe body parse; allow GET for quick tests
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch {
        return { statusCode: 400, headers: {"content-type":"application/json"},
          body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
    } else {
      payload = {
        urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean),
        maxMatches: Number(event.queryStringParameters?.maxMatches || 20),
        delay: Number(event.queryStringParameters?.delay || 1.5),
      };
    }

    const { urls = [], maxMatches = 20, delay = 1.5 } = payload;
    if (!Array.isArray(urls) || urls.length === 0) {
      return { statusCode: 400, headers: {"content-type":"application/json"},
        body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    // Launch Chromium suitable for Netlify (BOOLEAN headless)
    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({
      executablePath: execPath,
      args: chromium.args,
      headless: true,
    });
    // Force a common desktop UA to avoid "lite" DOM variants
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit(537.36) Chrome/119.0.0.0 Safari/537.36",
      viewport: { width: 1360, height: 2200 },
      locale: "en-US",
    });

    const allResults = [];
    for (const url of urls) {
      try {
        allResults.push(await processPlayer(context, url, Number(maxMatches) || 20, Number(delay) || 1.5));
      } catch (e) {
        allResults.push({
          player_url: url,
          player_name: "Unknown",
          checked_matches: 0,
          pom_2025_26_domestic_count: 0,
          pom_2025_26_domestic: [],
          error: String(e),
        });
      }
    }

    await browser.close();

    const totals = allResults.map(b => ({ player_name: b.player_name, total: b.pom_2025_26_domestic_count }));
    const summary = {
      players_processed: allResults.length,
      total_pom_hits_2025_26_domestic: allResu_
