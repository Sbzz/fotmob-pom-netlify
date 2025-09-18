// netlify/functions/discover.mjs
// Build per-player match URL lists using FotMob's playerData endpoint.
// We deliberately over-collect plausible match IDs; /check filters Top-5 + 2025–26.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HDRS = {
  accept: "application/json",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": UA,
  referer: "https://www.fotmob.com/",
};

// ---- utils ----
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

async function fetchJSON(url, retry = 3) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: HDRS });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt?.slice(0,200) || ""}`);
      return JSON.parse(txt);
    } catch (e) {
      last = e;
      await sleep(250 + 400 * i);
    }
  }
  throw last || new Error("fetch failed");
}

// Heuristic collector: walk JSON and harvest objects that look like matches.
// We accept objects that contain a numeric 'id' and any common "match-like" keys,
// e.g., {id, homeTeam/home, awayTeam/away, pageUrl, tournament/league }.
function collectMatchIdsFromPlayerData(root) {
  const ids = new Set();
  const q = [root];
  while (q.length) {
    const node = q.pop();
    if (!node || typeof node !== "object") continue;

    // If node itself looks like a match object, capture its id
    const id = node?.id;
    const looksLikeMatch =
      Number.isFinite(Number(id)) &&
      (
        node?.homeTeam || node?.awayTeam ||
        node?.home || node?.away ||
        node?.pageUrl || node?.status || node?.tournament || node?.league
      );

    if (looksLikeMatch) {
      const sid = String(id).trim();
      // FotMob match IDs are usually 6–8 digits; guard against tiny ids (e.g., team/player ids sometimes slip in)
      if (/^\d{6,9}$/.test(sid)) ids.add(sid);
    }

    // Keep walking
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") q.push(v);
      if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") q.push(it);
    }
  }
  return Array.from(ids);
}

export async function handler(event) {
  try {
    // Accept POST JSON (preferred) or GET query
    let payload = {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch {
        return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
    } else {
      payload = {
        urls: (event.queryStringParameters?.urls || "").split(",").filter(Boolean),
        maxMatches: Number(event.queryStringParameters?.maxMatches || 0),
      };
    }

    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    if (!urls.length) {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Provide { urls: [...] }" }) };
    }

    const cap = Number(payload.maxMatches) || 0;

    // Fetch each player's playerData and extract match IDs
    const players = [];
    for (const player_url of urls) {
      const { player_id, player_name } = parsePlayer(player_url);
      if (!player_id) {
        players.push({
          player_url,
          player_id: null,
          player_name: player_name || null,
          match_urls: [],
          debug: { reason: "Could not parse player_id from URL" },
        });
        continue;
      }

      let data = null, ids = [];
      let error = null;
      try {
        data = await fetchJSON(`https://www.fotmob.com/api/playerData?id=${player_id}`);
        ids = collectMatchIdsFromPlayerData(data);
      } catch (e) {
        error = String(e);
      }

      // Turn ids into fotmob match URLs; cap if requested
      const urlsAll = ids.map((id) => `https://www.fotmob.com/match/${id}`);
      const match_urls = cap > 0 ? urlsAll.slice(0, cap) : urlsAll;

      players.push({
        player_url,
        player_id,
        player_name: (payload.player_name_override || player_name || "").trim(),
        match_urls,
        debug: {
          harvested_ids: ids.length,
          returned: match_urls.length,
          had_error: !!error,
          error_sample: error ? error.slice(0, 200) : null
        }
      });
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, players })
    };
  } catch (e) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) };
  }
}
