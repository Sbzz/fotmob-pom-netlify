import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

/**
 * This discover uses a short Playwright visit to the player page,
 * captures the /api/playerData?id=<PID> JSON (or fetches it from the page),
 * heuristically extracts match IDs, and returns fotmob match URLs.
 *
 * Works with your existing index.html (chunked calls are fine; from/to are ignored here).
 */

// ---------- Browser profile ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1360, height: 1800 };

// ---------- Small helpers ----------
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

// Walk any JSON tree and harvest objects that look like matches (keep it broad).
function collectMatchIdsFromPlayerData(root) {
  const ids = new Set();
  const q = [root];
  while (q.length) {
    const node = q.pop();
    if (!node || typeof node !== "object") continue;

    const id = node?.id;
    const looksLikeMatch =
      Number.isFinite(Number(id)) &&
      (
        node?.homeTeam || node?.awayTeam || node?.home || node?.away ||
        node?.pageUrl || node?.status || node?.tournament || node?.league
      );

    if (looksLikeMatch) {
      const sid = String(id).trim();
      if (/^\d{6,9}$/.test(sid)) ids.add(sid); // typical FotMob match id length
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v) continue;
      if (Array.isArray(v)) v.forEach(it => { if (it && typeof it === "object") q.push(it); });
      else if (typeof v === "object") q.push(v);
    }
  }
  return Array.from(ids);
}

async function acceptCookies(page) {
  const names = [/Accept/i, /Agree/i, /Allow all/i, /Got it/i, /Continue/i, /I understand/i];
  for (const rx of names) {
    try {
      const btn = page.getByRole("button", { name: rx });
      if ((await btn.count()) > 0) { await btn.first().click({ timeout: 1500 }); break; }
    } catch {}
  }
  for (const f of page.frames()) {
    for (const rx of names) {
      try {
        const b = f.getByRole("button", { name: rx });
        if ((await b.count()) > 0) { await b.first().click({ timeout: 1500 }); break; }
      } catch {}
    }
  }
}

// Try to trigger the "Matches" view (some builds lazy-load playerData when switching tabs)
async function nudgeMatchesTab(page) {
  const texts = [/Matches/i, /All matches/i, /Fixtures/i];
  for (const rx of texts) {
    try {
      const t = page.getByText(rx, { exact: false }).first();
      if ((await t.count()) > 0) { await t.click({ timeout: 1500 }); await page.waitForTimeout(350); return; }
    } catch {}
  }
}

// Attempt to get playerData via page XHR or by fetching from within the page
async function getPlayerDataJSON(page, playerId, timeoutMs = 8000) {
  let captured = null;

  const watcher = async () => {
    const deadline = Date.now() + timeoutMs;
    while (!captured && Date.now() < deadline) {
      await page.waitForTimeout(150);
    }
    return captured;
  };

  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      if (!/\/api\/playerData\?id=\d+/i.test(url)) return;
      const ctype = resp.headers()["content-type"] || "";
      if (!ctype.includes("application/json")) return;
      const txt = await resp.text();
      const json = JSON.parse(txt);
      captured = json;
    } catch {}
  };

  page.on("response", onResponse);

  // If the page itself hasn't triggered it, try to nudge the UI and/or fetch from within the page
  await nudgeMatchesTab(page);
  // Give a moment for any XHR fired by tab switch
  await page.waitForTimeout(500);

  // Still nothing? Call it from the page context so cookies/headers apply
  if (!captured && Number.isFinite(playerId)) {
    try {
      const result = await page.evaluate(async (pid) => {
        const res = await fetch(`https://www.fotmob.com/api/playerData?id=${pid}`, {
          headers: {
            "accept": "application/json",
          },
          credentials: "include",
        });
        const txt = await res.text();
        try { return JSON.parse(txt); } catch { return null; }
      }, playerId);
      if (result && typeof result === "object") captured = result;
    } catch {}
  }

  // Wait briefly to allow network listener to catch late responses
  const winner = await Promise.race([watcher(), sleep(800)]);
  page.off("response", onResponse);
  return winner || captured;
}

async function processPlayer(context, playerUrl, cap) {
  const { player_id, player_name } = parsePlayer(playerUrl);
  const debug = { player_id, xhr_hit: false, harvested_ids: 0, returned: 0, error: null };

  if (!player_id) {
    debug.error = "Could not parse player_id from URL";
    return { player_url: playerUrl, player_id: null, player_name, match_urls: [], debug };
  }

  const page = await context.newPage();
  try {
    await page.setViewportSize(VIEWPORT);
  } catch {}
  try {
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptCookies(page);
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  } catch (e) {
    debug.error = String(e);
  }

  let pdata = null;
  try {
    pdata = await getPlayerDataJSON(page, player_id, 7000);
    debug.xhr_hit = !!pdata;
  } catch (e) {
    debug.error = String(e);
  }

  await page.close();

  if (!pdata) {
    return { player_url: playerUrl, player_id, player_name, match_urls: [], debug };
  }

  const ids = collectMatchIdsFromPlayerData(pdata);
  debug.harvested_ids = ids.length;

  const urls = ids.map((id) => `https://www.fotmob.com/match/${id}`);
  const match_urls = (Number(cap) > 0) ? urls.slice(0, Number(cap)) : urls;
  debug.returned = match_urls.length;

  return { player_url: playerUrl, player_id, player_name, match_urls, debug };
}

// ---------- Netlify handler ----------
export async function handler(event) {
  try {
    // Accept POST JSON or GET query
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
        const res = await processPlayer(context, playerUrl, cap);
        players.push(res);
      } catch (e) {
        players.push({
          player_url: playerUrl,
          player_id: null,
          player_name: null,
          match_urls: [],
          debug: { error: String(e) }
        });
      }
    }

    await browser.close();

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, players }) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
