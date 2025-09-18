import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

// ----- CONFIG -----
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

// ----- HELPERS -----
function norm(s = "") {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function leagueIsAllowed(label = "") {
  const n = norm(label);
  for (const allowed of ALLOWED_LEAGUES) if (n.includes(allowed)) return true;
  return false;
}

// Consent & hydration
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
    await page.waitForTimeout(1500);
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

// JSON-LD helpers
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
  // JSON-LD
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
  // <time datetime=...>
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
  // Fallback: title/body
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

  // pull nearby text
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

// Player page helpers
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
async function collectMatchLinksWithScroll(page, maxLinks, maxScrolls = 12) {
  const seen = new Set();
  for (let i = 0; i < maxScrolls; i++) {
    const links = await page.locator('a[href*="/match/"]').evaluateAll((els) => els.map((e) => e.href));
    for (const href of links) {
      if (!seen.has(href)) {
        seen.add(href);
        if (seen.size >= maxLinks) return Array.from(seen).slice(0, maxLinks);
      }
    }
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return Array.from(seen).slice(0, maxLinks);
}

// Core scraping
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
  try {
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookiesEverywhere(page);
    playerName = (await extractPlayerName(page)) || "Unknown";

    const matchLinks = await collectMatchLinksWithScroll(page, maxLinks, 12);
    for (const href of matchLinks) {
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
  };
}

// CSV
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

// ----- HANDLER -----
export async function handler(event) {
  try {
    // Safe body parse; also allow GET with query string for testing
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
        maxMatches: Number(event.queryStringParameters?.maxMatches || 40),
        delay: Number(event.queryStringParameters?.delay || 1.5),
      };
    }

    const { urls = [], maxMatches = 40, delay = 1.5 } = payload;
    if (!Array.isArray(urls) || urls.length === 0) {
      return { statusCode: 400, headers: {"content-type":"application/json"},
        body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    // Launch Lambda-compatible Chromium for Playwright (BOOLEAN headless)
    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({
      executablePath: execPath,
      args: chromium.args,
      headless: true, // <- must be boolean
    });
    const context = await browser.newContext();

    const allResults = [];
    for (const url of urls) {
      try {
        allResults.push(await processPlayer(context, url, Number(maxMatches) || 40, Number(delay) || 1.5));
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
      total_pom_hits_2025_26_domestic: allResults.reduce((a, b) => a + (b.pom_2025_26_domestic_count || 0), 0),
    };
    const csv = toCsv(allResults);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results: allResults, totals, summary, csv }),
    };
  } catch (e) {
    // ALWAYS return JSON on failures
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: String(e) }),
    };
  }
}
