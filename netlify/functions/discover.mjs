// netlify/functions/discover.mjs
// Robust discover: get match URLs for each FotMob player URL using multiple strategies.
// 1) Capture /api/playerData?id=... XHR from the page (preferred).
// 2) Scrape anchors after switching to "Matches/Fixtures" and scrolling.
// 3) Parse __NEXT_DATA__ for /match/<id>.
// Returns match_urls per player; your /check function filters Top-5 & 2025–26 and computes POTM / Highest.

import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

// ---------- Browser profile ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1360, height: 2000 };

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePlayer(url) {
  try {
    const u = new URL(url);
    // /players/<id>/<slug>
    const parts = u.pathname.split("/").filter(Boolean);
    const pid = Number(parts[1]);
    const slug = decodeURIComponent(parts[2] || "").replace(/-/g, " ").trim();
    return { player_id: Number.isFinite(pid) ? pid : null, player_name: slug || null };
  } catch {
    return { player_id: null, player_name: null };
  }
}

// Walk JSON tree; harvest things that look like matches.
function collectMatchIdsFromPlayerData(root) {
  const ids = new Set();
  const q = [root];
  while (q.length) {
    const node = q.pop();
    if (!node || typeof node !== "object") continue;

    const id = node?.id;
    const looksLikeMatch =
      Number.isFinite(Number(id)) &&
      (node?.homeTeam || node?.awayTeam || node?.home || node?.away || node?.pageUrl || node?.status || node?.tournament || node?.league);

    if (looksLikeMatch) {
      const sid = String(id).trim();
      // FotMob match IDs are typically 6–9 digits
      if (/^\d{6,9}$/.test(sid)) ids.add(sid);
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v) continue;
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") q.push(it);
      else if (typeof v === "object") q.push(v);
    }
  }
  return Array.from(ids);
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
  // iframed CMPs
  for (const f of page.frames()) {
    for (const rx of names) {
      try {
        const b = f.getByRole("button", { name: rx });
        if ((await b.count()) > 0) { await b.first().click({ timeout: 1500 }); break; }
      } catch {}
    }
  }
}

async function clickMatchesTab(page, debug) {
  const labels = [/Matches/i, /All matches/i, /Fixtures/i, /Games/i];
  for (const rx of labels) {
    try {
      const el = page.getByText(rx, { exact: false }).first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(400);
        debug.tab_clicks = (debug.tab_clicks || 0) + 1;
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickLoadMore(page, debug) {
  const labels = [/Show more/i, /Load more/i, /More/i];
  for (const rx of labels) {
    try {
      const el = page.getByRole("button", { name: rx }).first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(400);
        debug.load_more_clicks = (debug.load_more_clicks || 0) + 1;
        return true;
      }
    } catch {}
  }
  return false;
}

async function scrollAndCollectAnchors(page, maxScrolls, debug) {
  const hrefs = new Set();
  for (let i = 0; i < maxScrolls; i++) {
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
    await page.waitForTimeout(500);
    // Collect anchors to /match/
    try {
      const links = await page.locator('a[href*="/match/"]').evaluateAll(els => Array.from(new Set(els.map(e => e.href))));
      links.forEach(h => hrefs.add(h));
    } catch {}
    debug.scroll_steps = i + 1;
    // Try "Load more" buttons if present
    const clicked = await clickLoadMore(page, debug);
    if (!clicked && i >= 2 && hrefs.size > 0) {
      // after a few scrolls with at least something, break early
      break;
    }
  }
  debug.anchors_found = hrefs.size;
  return Array.from(hrefs);
}

async function parseNextDataIds(page, debug) {
  try {
    const raw = await page.evaluate(() => {
      try {
        if (window.__NEXT_DATA__) return JSON.stringify(window.__NEXT_DATA__);
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : null;
      } catch { return null; }
    });
    const ids = new Set();
    if (raw) {
      const str = typeof raw === "string" ? raw : JSON.stringify(raw);
      const re = /\/match\/(\d{6,9})/g;
      let m;
      while ((m = re.exec(str)) !== null) ids.add(m[1]);
    }
    debug.next_ids = ids.size;
    return Array.from(ids).map(id => `https://www.fotmob.com/match/${id}`);
  } catch {
    debug.next_ids = 0;
    return [];
  }
}

async function capturePlayerData(page, playerId, debug) {
  let captured = null;

  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      // Accept both api/playerData?id=... and any future variant with "player" + "data" in path/query.
      if (!/\/api\/.*player.*data.*\?/.test(url)) return;
      const ctype = (resp.headers()["content-type"] || "").toLowerCase();
      if (!ctype.includes("application/json")) return;
      const txt = await resp.text();
      captured = JSON.parse(txt);
      debug.xhr_hit = true;
    } catch {}
  };

  page.on("response", onResponse);

  // Try the tab that tends to fire the XHR
  await clickMatchesTab(page, debug);
  await page.waitForTimeout(600);

  // Fallback: call from page context so cookies apply
  if (!captured && Number.isFinite(playerId)) {
    try {
      const result = await page.evaluate(async (pid) => {
        const r = await fetch(`https://www.fotmob.com/api/playerData?id=${pid}`, {
          headers: { "accept": "application/json" },
          credentials: "include"
        });
        const t = await r.text();
        try { return JSON.parse(t); } catch { return null; }
      }, playerId);
      if (result && typeof result === "object") {
        captured = result;
        debug.page_fetch = true;
      }
    } catch {}
  }

  // Give the network listener a final chance
  await page.waitForTimeout(600);
  page.off("response", onResponse);

  return captured;
}

async function processPlayer(context, playerUrl, cap) {
  const { player_id, player_name } = parsePlayer(playerUrl);
  const debug = { player_id, xhr_hit: false, page_fetch: false, anchors_found: 0, next_ids: 0, tab_clicks: 0, load_more_clicks: 0, scroll_steps: 0, errors: [] };

  if (!player_id) {
    debug.errors.push("Could not parse player_id from URL");
    return { player_url: playerUrl, player_id: null, player_name, match_urls: [], debug };
  }

  const page = await context.newPage();
  try { await page.setViewportSize(VIEWPORT); } catch {}
  try {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      // Let everything through; optionally we could abort ads/analytics to speed up.
      route.continue();
    });
  } catch {}

  try {
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookies(page);
    await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
  } catch (e) {
    debug.errors.push(String(e));
  }

  // Try to capture playerData JSON
  let pdata = null;
  try {
    pdata = await capturePlayerData(page, player_id, debug);
  } catch (e) {
    debug.errors.push(String(e));
  }

  // Collect anchors & __NEXT_DATA__ too
  let anchorUrls = [];
  try { anchorUrls = await scrollAndCollectAnchors(page, 8, debug); } catch (e) { debug.errors.push(String(e)); }

  let nextUrls = [];
  try { nextUrls = await parseNextDataIds(page, debug); } catch (e) { debug.errors.push(String(e)); }

  await page.close();

  // Build final URL set
  const set = new Set(anchorUrls);
  if (pdata) {
    const ids = collectMatchIdsFromPlayerData(pdata);
    debug.harvested_ids = ids.length;
    for (const id of ids) set.add(`https://www.fotmob.com/match/${id}`);
  } else {
    debug.harvested_ids = 0;
  }
  nextUrls.forEach((u) => set.add(u));

  const all = Array.from(set);
  const match_urls = Number(cap) > 0 ? all.slice(0, Number(cap)) : all;

  debug.returned = match_urls.length;

  return { player_url: playerUrl, player_id, player_name, match_urls, debug };
}

// ---------- Netlify handler ----------
export async function handler(event) {
  try {
    // POST JSON or GET query (for quick tests)
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

    // Launch Chromium (Lambda-friendly)
    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({
      executablePath: execPath,
      args: chromium.args,
      headless: true,
    });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: VIEWPORT,
      locale: "en-US",
    });

    const players = [];
    for (const playerUrl of urls) {
      try {
        players.push(await processPlayer(context, playerUrl, cap));
      } catch (e) {
        players.push({
          player_url: playerUrl,
          player_id: null,
          player_name: null,
          match_urls: [],
          debug: { errors: [String(e)] }
        });
      }
    }

    await browser.close();

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, players }) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
