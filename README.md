# POTM & Match Stats — Top 5 Leagues (2025–26)

Tiny app + Netlify Functions to collect **POTM hits, full‑match 90 (FMP), goals (NPG/PG), assists, YC, RC** for any FotMob player in the **2025–26** season (PL, LaLiga, Bundesliga, Serie A, Ligue 1). Exports per‑player totals and per‑match rows as CSV/JSON.

---

## Quick start

### Requirements

* Netlify account
* Node **18+** (for local dev)
* Netlify CLI (optional for local dev):

  ```bash
  npm i -g netlify-cli   # or: npx netlify-cli <command> / ntl <command>
  ```

### File layout

```
.
├─ netlify.toml
├─ package.json
└─ public/
└─ index.html # UI (publish root)
└─ players.csv # optional seed list (served at /players.csv)
└─ url.csv # optional seed list (served at /url.csv)
├─ README.md
└─ netlify/
└─ functions/
├─ discover.mjs
└─ check.mjs
```

If you don’t already have a Netlify config, this minimal **netlify.toml** works:

```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

---

## Run locally (optional)

```bash
# from the project root
ntl dev        # or: netlify dev
# open the local URL from the CLI output
```

---

## Deploy

**Option A – Netlify UI (Git provider):**

1. New site from Git → pick this repo.
2. Build settings: **No build command**; Publish directory: `.`
3. Functions directory: `netlify/functions`.
4. Deploy.

**Option B – Netlify CLI:**

```bash
netlify init                 # run once to link site
netlify deploy --prod        # deploy to production
```

*No env vars required.*

---

## Use the app

1. Open the deployed site.
2. In **“Provide players”**, paste FotMob player profile URLs (one per line), or click **Load /players.csv** or **Load /url.csv**.
3. Click **1) Discover Matches** → progress shows *Discovering X/Y*.
4. Click **2) Run Checks** → progress shows *Checking X/Y*.
5. Download results:

   * **Summary CSV** – per‑player totals
   * **Details CSV** – per‑match rows
   * **POTM Table** – `player | POTM`
   * **JSON** – full structured output

### CSV formats

* `players.csv` accepts either:

  ```csv
  name,url
  Lamine Yamal,https://www.fotmob.com/players/1467236/lamine-yamal
  ```

  or just a list of URLs (header optional).
* `url.csv` accepts a `url` column or a plain list of URLs.

> URLs are normalized to `https://www.fotmob.com/players/<id>/<slug>` automatically.

---

## Season window & leagues

* Season: **2025‑07‑01 → 2026‑06‑30**
* Allowed leagues: **PL=47, LaLiga=87, Bundesliga=54, Serie A=55, Ligue 1=53**

If you need to change the season or leagues next year, update the constants at the top of **`netlify/functions/discover.mjs`** and **`netlify/functions/check.mjs`**.

---

## Reliability knobs (front‑end)

* `DISCOVER_BATCH_SIZE` in **index.html** – default **1** (most reliable on the 10s Netlify function budget). Increase only if your plan allows longer execution.

The app already throttles checks and de‑dupes matches to avoid double counting.

---

## Troubleshooting

* **Only a couple of players get processed**: keep `DISCOVER_BATCH_SIZE = 1`.
* **Some players show 0 despite having matches**: click *Discover* again (rare slow responses); the UI retries batches and individual players. Stats table only lists matches the player actually appeared in.
* **Headers look cramped**: adjust the `min-width` values for the first two table columns in `index.html` CSS.

---

## Notes

* The app makes standard HTML requests to public FotMob pages and parses `__NEXT_DATA__` (with HTML fallbacks). No authentication or private APIs are used.
* Respect the target site’s terms and avoid excessive concurrency; defaults are conservative.
