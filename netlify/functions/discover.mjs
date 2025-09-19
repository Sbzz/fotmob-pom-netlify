// netlify/functions/discover.mjs
// Strategy: Player page -> find team link (/teams/<id>/<slug>) -> go to team fixtures -> scrape match links.
// Collects both "/match/<digits>" and "/matches/<slug>/<token>" anchors (checker handles both).

import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1360, height: 2000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePlayer(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean); // ["players","1467236","lamine-yamal"]
    const pid = Number(parts[1]);
    const slug = decodeURIComponent(parts[2] || "").replace(/-/g, " ").trim();
    return { player_id: Number.isFinite(pid) ? pid : null, player_name: slug || null };
  } catch {
    return { player_id: null, player_name: null };
  }
}

async function acceptCookies(page) {
  const names = [/Accept/i, /Agree/i, /Allow all/i, /Got it/i, /Continue/i, /I understand/i, /OK/i];
  // top page
  for (const rx of names) {
    try {
      const btn = page.getByRole("button", { name: rx });
      if ((await btn.count()) > 0) { await btn.first().click({ timeout: 1500 }); break; }
    } catch {}
  }
  // iframes
  for (const f of page.frames()) {
    for (const rx of names) {
      try {
        const b = f.getByRole("button", { name: rx });
        if ((await b.count()) > 0) { await b.first().click({ timeout: 1500 }); break; }
      } catch {}
    }
  }
}

async function findTeamHref(page) {
  // Try obvious places first (top header / bio panel)
  const selectors = [
    'a[href^="/teams/"]',
    'a[href*="/teams/"][href*="/overview"]',
  ];
  for (const sel of selectors) {
    try {
      const href = await page.locator(sel).evaluateAll(els => {
        const cand = els.map(e => e.getAttribute("href")).filter(Boolean);
        return cand.find(h => /^\/teams\/\d+\/?/i.test(h)) || null;
      });
      if (href) return href;
    } catch {}
  }
  // Last resort: search all anchors
  try {
    const all = await page.locator("a").evaluateAll(els => els.map(e => e.getAttribute("href")).filter(Boolean));
    const hit = all.find(h => /^\/teams\/\d+\/?/i.test(h));
    if (hit) return hit;
  } catch {}
  return null;
}

function normaliseTeamHref(href) {
  // /teams/8634/overview/barcelona  OR  /teams/8634/barcelona
  const parts = href.split("?")[0].split("/").filter(Boolean); // ["teams","8634",...]
  const id = Number(parts[1]);
  const slug = parts[2] && parts[2] !== "overview" ? parts.slice(2).join("-") : (parts.at(-1) || "");
  return { team_id: Number.isFinite(id) ? id : null, team_slug: slug || "team" };
}

async function scrapeTeamFixtures(page, fixturesUrl, maxScrolls = 10) {
  await page.goto(fixturesUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  const hrefs = new Set();

  for (let i = 0; i < maxScrolls; i++) {
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
    await page.waitForTimeout(600);

    // Collect both formats
    try {
      const links1 = await page.locator('a[href*="/match/"]').evaluateAll(els => Array.from(new Set(els.map(e => e.href))));
      links1.forEach(h => hrefs.add(h));
    } catch {}
    try {
      const links2 = await page.locator('a[href*="/matches/"]').evaluateAll(els => Array.from(new Set(els.map(e => e.href))));
      links2.forEach(h => hrefs.add(h));
    } catch {}

    // Try generic "Load more"
    try {
      const btn = page.getByRole("button", { name: /More|Show more|Load more/i }).first();
      if ((await btn.count()) > 0) { await btn.click({ timeout: 1500 }); await page.waitForTimeout(500); }
    } catch {}
  }
  return Array.from(hrefs);
}

async function processPlayer(context, playerUrl, cap) {
  const { player_id, player_name } = parsePlayer(playerUrl);
  const debug = { player_id, team_id: null, team_slug: null, anchors_fetched: 0, used_fixtures_url: null, errors: [] };

  if (!player_id) {
    debug.errors.push("Could not parse player_id from URL");
    return { player_url: playerUrl, player_id: null, player_name, match_urls: [], debug };
  }

  const page = await context.newPage();
  try { await page.setViewportSize(VIEWPORT); } catch {}

  try {
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await acceptCookies(page);
    await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
  } catch (e) {
    debug.errors.push(String(e));
  }

  let teamHref = null;
  try { teamHref = await findTeamHref(page); } catch (e) { debug.errors.push(String(e)); }
  await page.close();

  if (!teamHref) {
    debug.errors.push("Could not find team link on player page");
    return { player_url: playerUrl, player_id, player_name, match_urls: [], debug };
  }

  const { team_id, team_slug } = normaliseTeamHref(teamHref);
  debug.team_id = team_id;
  debug.team_slug = team_slug || "team";
  if (!team_id) {
    debug.errors.push("Failed to parse team_id");
    return { player_url: playerUrl, player_id, player_name, match_urls: [], debug };
  }

  // Team fixtures URL pattern is stable
  const fixturesUrl = `https://www.fotmob.com/teams/${team_id}/fixtures/${encodeURIComponent(team_slug)}`;
  debug.used_fixtures_url = fixturesUrl;

  const page2 = await context.newPage();
  let links = [];
  try {
    await page2.setViewportSize(VIEWPORT).catch(() => {});
    links = await scrapeTeamFixtures(page2, fixturesUrl, 10);
  } catch (e) {
    debug.errors.push(String(e));
  }
  await page2.close();

  debug.anchors_fetched = links.length;

  // Cap & return
  const match_urls = (Number(cap) > 0) ? links.slice(0, Number(cap)) : links;
  return { player_url: playerUrl, player_id, player_name, match_urls, debug };
}

export async function handler(event) {
  try {
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch {
        return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
    } else {
      payload = { urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean), maxMatches: Number(event.queryStringParameters?.maxMatches || 0) };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    const cap = Number(payload.maxMatches) || 0;
    if (!urls.length) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    // Launch headless Chromium in Netlify
    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({
      executablePath: execPath,
      args: chromium.args,
      headless: true,
    });
    const context = await browser.newContext({ userAgent: UA, viewport: VIEWPORT, locale: "en-US" });

    const players = [];
    for (const playerUrl of urls) {
      try {
        players.push(await processPlayer(context, playerUrl, cap));
      } catch (e) {
        players.push({ player_url: playerUrl, player_id: null, player_name: null, match_urls: [], debug: { errors: [String(e)] } });
      }
    }

    await browser.close();

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, players }) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
