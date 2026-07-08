# PoE2 国服 Trade — English

A personal accessibility layer that translates the **Chinese** PoE2 trade site
(`poe.game.qq.com/trade2`) to English. The CN site is a mirror of the international
one — the trade engine filters on language-independent ids, only the display
strings differ — so this is an **id-based translation** layer, not a rebuild.

A Tampermonkey userscript patches `fetch`/`XHR` on the CN site and rewrites the
trade API responses to English before the page renders. The dictionary is built
from the live CN + intl trade endpoints (for trade-API stats/filters/currency),
plus all **client-derived content** (item/unique/gem names, mod-line templates)
consumed from the sibling **[poe2-en-cn-dict](../poe2-en-cn-dict)** project — the
single source of truth for CN↔EN game strings. This tool no longer datamines the
client itself.

What it translates:
- **Filter UI** — stat filters, item-category/type, all filter-panel sections and
  options (`/api/trade2/data/{stats,static,items,filters}`, joined by id).
- **Search results** — item base types and affix mod lines
  (`/api/trade2/fetch/*`): mods are matched by stat-hash (then a zh-pattern
  fallback) and the rolled numbers are re-inserted into the English template.
- **Hardcoded chrome** — buttons, placeholders, result-card and property labels,
  via a small DOM pass (the `CHROME` map in `userscript.template.js`).
- **Gem/skill tooltips** — skill name, granted-skill line, description prose,
  Cost/Cast-Time/Requires labels+values, and the **skill stat/mechanic lines**
  (e.g. "Leeches 96 Mana"). Skill names/descriptions come from the client's
  `ActiveSkills` table; stat lines from the full `StatDescriptions` templates.

It also **auto-clears the site's `lscache` data cache** when the dictionary
version changes, so a freshly built dict takes effect on the next reload with no
manual DevTools clearing.

Because the script only swaps *display* strings (never the ids sent back to the
trade API), search/fetch keep working, and typing English in the stat/item
filters already works as input-assist.

See `HANDOFF.md` for the full design and the reasoning behind each decision.

## Install (use it)

1. Install the **Tampermonkey** browser extension.
2. Open `tool/dist/poe2cn-trade.user.js` in the browser (or drag it onto the
   Tampermonkey dashboard) and confirm the install.
3. Open `https://poe.game.qq.com/trade2/...` while logged in. Stat filters, item
   names, currencies and league names should appear in English.

## Manage it (in-browser panel)

A floating **中EN** button (bottom-right of the trade page) opens a settings panel:

- **Enable translation** — master on/off.
- **Translate page text** — the DOM pass for tooltips / hardcoded labels.
- **Debug logging** — verbose `[poe2cn]` console output.
- **Clear trade-data cache & reload** — forces the site to refetch + re-translate.
- Status: dictionary version, build date, and entry counts.

Settings persist per browser.

## Use it on other machines (Linux, etc.) via GitHub auto-update

The userscript is OS-independent — only **building the dictionary** needs the
Windows/WeGame client (to (re)generate poe2-en-cn-dict). So one machine builds;
any machine runs and auto-updates from GitHub raw.

**One-time setup on the Windows build machine:**
1. Create a **public** repo at `https://github.com/addohm/poe2cn-trade-helper`
   (empty — no README/license, so the first push isn't rejected).
2. Use your GitHub **noreply** email so the push isn't blocked by email privacy
   (GitHub error `GH007`). This repo is already configured with it; for a fresh
   clone set it once:
   ```
   git config user.email "addohm@users.noreply.github.com"
   ```
   (If you'd already committed with a private email, rewrite history before pushing:
   `git rebase --root --exec "git commit --amend --no-edit --reset-author"`.)
3. From the project folder:
   ```
   git remote add origin https://github.com/addohm/poe2cn-trade-helper.git
   git push -u origin main
   ```
   (Git Credential Manager will prompt you to sign in on the first push.)

**On the Linux machine (or any browser):**
1. Install Tampermonkey.
2. Open the raw URL — Tampermonkey offers to install:
   `https://raw.githubusercontent.com/addohm/poe2cn-trade-helper/main/tool/dist/poe2cn-trade.user.js`
3. It **auto-updates** whenever the build machine pushes a new version (Tampermonkey
   checks periodically; or use its "Check for userscript updates").

**Ongoing:** after a game patch, run `tool/refresh.ps1` on the Windows box — it
rebuilds **and pushes** automatically; every other machine auto-updates. No manual
copying.

## Data sources (factual only)

Two authoritative sources, nothing else:
- the **live trade API** (both `poe.game.qq.com` and `pathofexile.com`) for
  trade-stat text, currency, filters, leagues, item categories — joined by
  language-independent id. The intl host is uniquely authoritative for trade-stat
  phrasing (pseudo aggregates and compound radius-jewel mods are assembled by the
  trade backend and have no client stat-description);
- the **[poe2-en-cn-dict](../poe2-en-cn-dict)** consumer export for all
  client-derived content (item/unique/gem names, mod-line templates, flat
  cn↔en lookups). That project datamines the **国服 WeGame client** — the only
  source whose Simplified-Chinese data matches the 国服 trade site (the global
  client has no SC data; poe2db is global/Traditional with no API).

Building poe2-en-cn-dict **requires** the WeGame 国服 client (Windows-only). This
tool just consumes its committed export, so no game client is needed to build the
userscript once the export exists.

## Rebuild the dictionary (after a game/content update, ~every 4 months)

### The easy way — one command

From the project's `tool/` folder, run the refresher (it regenerates the
poe2-en-cn-dict consumer export, re-fetches the trade endpoints, rebuilds the
userscript, and pushes to GitHub):

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\addohm\Documents\poe2cn-trade-helper\tool\refresh.ps1
```

(or right-click `tool\refresh.ps1` → **Run with PowerShell**).

**After a game *client* patch**, first rebuild the dictionary itself in the sibling
repo (this is the only step that reads the WeGame + Steam clients):

```powershell
wsl python3 /mnt/c/Users/addohm/Documents/poe2-en-cn-dict/update.py   # datamine + full rebuild
```

Then run `refresh.ps1` here. If the trade *site* changed but the client didn't, you
can skip that and just run `refresh.ps1` (it re-fetches the live endpoints).

### The manual steps (what refresh.ps1 does)

```bash
# 1. Consumer export — reshape poe2-en-cn-dict's committed dictionary/ into the
#    trade-helper maps (no game client needed; run under WSL).
wsl python3 /mnt/c/Users/addohm/Documents/poe2-en-cn-dict/export_consumers.py

# 2. Dictionary + userscript — fetch the live trade endpoints (both hosts) and
#    inject the export into the userscript.
wsl python3 /mnt/c/Users/addohm/Documents/poe2cn-trade-helper/tool/build_dict.py
#    --offline rebuilds from tool/raw/ cache without re-fetching
#    --export <dir> overrides the consumer-export path
```

After step 2, **read `tool/dist/report.md`** — it shows coverage and a diff vs the
previous build (added/removed ids, item-base changes, any uncovered strings).
Then reinstall/refresh the userscript in Tampermonkey.

## Layout

```
tool/
  refresh.ps1              # one-command: export + fetch + rebuild + push (after a patch)
  build_dict.py            # fetch trade endpoints (both hosts) + inject poe2-en-cn-dict export -> userscript
  userscript.template.js   # userscript logic (__DICT__ injected at build time)
  sim_translate.py         # offline coverage check (data/* vs cached CN responses)
  sim_mods.py              # offline check of result-mod (affix) translation
  sim_dom.py               # offline check of DOM/chrome/tooltip/league translation
  raw/                     # cached raw API responses (for --offline / diffing)
  dist/
    dict.json              # build coverage + provenance
    dict.runtime.json      # slim display-only zh/id -> en (embedded in the userscript)
    poe2cn-trade.user.js   # << install this
    report.md              # coverage + diff-vs-previous
  # DEPRECATED (superseded by poe2-en-cn-dict; kept for history, no longer run):
  #   engine.mjs, extract_items.mjs, extract_statdesc.mjs, package.json, data/
```

Client content comes from **[../poe2-en-cn-dict](../poe2-en-cn-dict)** →
`dictionary/consumers/trade-helper/` (regenerate with its `export_consumers.py`).

## Environment notes

- The builder fetches via Windows `curl.exe` (through WSL interop) because WSL's
  network stack can't reach `pathofexile.com` (a Windows-side proxy maps it to a
  fake-IP). It also sends browser headers + paces requests so Cloudflare's
  bot-fight doesn't 403 it.
- The **client datamine now lives in [poe2-en-cn-dict](../poe2-en-cn-dict)**, which
  reads the WeGame 国服 client (auto-detected under
  `/mnt/<drive>/WeGameApps/rail_apps/...`) and the Steam client, and emits a
  `dictionary/consumers/trade-helper/` bundle this tool consumes. See that repo's
  README for the datamine details. The old `tool/extract_*.mjs` + `tool/engine.mjs`
  are retained only for history.

## Scope / ToS

Personal translation + input-assist only. It translates what you already see and
helps you type search terms. It does **not** auto-trade, auto-whisper, mass-query,
or bypass the trade API rate limits.
