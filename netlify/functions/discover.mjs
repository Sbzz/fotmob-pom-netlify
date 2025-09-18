import { chromium as pwChromium } from "playwright-core";
import chromium from "@sparticuz/chromium";

function norm(s = "") {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
async function acceptCookies(page) {
  const names = [/Accept.*/i, /Agree.*/i, /Allow all.*/i, /Got it.*/i, /I understand.*/i, /Continue.*/i];
  for (const rx of names) {
    try {
      const b = page.getByRole("button", { name: rx });
      if ((await b.count()) > 0) { await b.first().click({ timeout: 1500 }); break; }
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
  try {
    const t = page.locator("text=/accept all|accept|agree/i");
    if ((await t.count()) > 0) await t.first().click({ timeout: 1200 });
  } catch {}
}
async function smallPause(ms = 350) { await new Promise(r => setTimeout(r, ms)); }

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

// Find /match/<id> quickly: anchors, __NEXT_DATA__, page HTML
async function collectMatchLinksFast(page, maxLinks, scrolls = 8) {
  const hrefs = new Set();
  const debug = { anchors: 0, nextData: 0, htmlRegex: 0 };

  // Try a matches tab if exists
  try {
    const allMatches = page.getByText(/All matches|Matches|Fixtures/i).first();
    if ((await allMatches.count()) > 0) { await allMatches.click({ timeout: 1500 }).catch(() => {}); await smallPause(300); }
  } catch {}

  // 1) Anchors
  for (let i = 0; i < scrolls && hrefs.size < maxLinks; i++) {
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
    await smallPause(400);
    const links = await page.locator('a[href*="/match/"]').evaluateAll(els => Array.from(new Set(els.map(e => e.href))));
    debug.anchors += links.length;
    for (const h of links) {
      hrefs.add(h);
      if (hrefs.size >= maxLinks) return { urls: Array.from(hrefs).slice(0, maxLinks), debug };
    }
  }

  // 2) __NEXT_DATA__
  try {
    const raw = await page.evaluate(() => {
      try {
        if (window.__NEXT_DATA__) return JSON.stringify(window.__NEXT_DATA__);
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : null;
      } catch { return null; }
    });
    if (raw) {
      const str = typeof raw === "string" ? raw : JSON.stringify(raw);
      const re = /\/match\/(\d+)/g; let m; const found = new Set();
      while ((m = re.exec(str)) !== null) found.add(`https://www.fotmob.com/match/${m[1]}`);
      debug.nextData = found.size;
      for (const u of found) { hrefs.add(u); if (hrefs.size >= maxLinks) return { urls: Array.from(hrefs).slice(0, maxLinks), debug }; }
    }
  } catch {}

  // 3) Raw HTML
  try {
    const html = await page.content();
    const re = /href="\/match\/(\d+)"/g; let m; let c = 0;
    while ((m = re.exec(html)) !== null) { hrefs.add(`https://www.fotmob.com/match/${m[1]}`); c++; if (hrefs.size >= maxLinks) break; }
    debug.htmlRegex = c;
  } catch {}

  return { urls: Array.from(hrefs).slice(0, maxLinks), debug };
}

export async function handler(event) {
  try {
    const payload = event.httpMethod === "POST"
      ? JSON.parse(event.body || "{}")
      : { urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean), maxMatches: Number(event.queryStringParameters?.maxMatches || 20) };

    const { urls = [], maxMatches = 20 } = payload;
    if (!Array.isArray(urls) || urls.length === 0) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    const execPath = await chromium.executablePath();
    const browser = await pwChromium.launch({ executablePath: execPath, args: chromium.args, headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      viewport: { width: 1360, height: 2000 },
      locale: "en-US",
    });

    const players = [];
    for (const playerUrl of urls) {
      const page = await context.newPage();
      try {
        await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await acceptCookies(page);
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        const player_name = (await extractPlayerName(page)) || "Unknown";
        const { urls: match_urls, debug } = await collectMatchLinksFast(page, Number(maxMatches) || 20, 8);
        players.push({ player_url: playerUrl, player_name, match_urls, debug });
      } catch (e) {
        players.push({ player_url: playerUrl, player_name: "Unknown", match_urls: [], error: String(e) });
      } finally {
        await page.close();
      }
    }

    await browser.close();
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ players }) };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
