# PoE2 国服 Trade — English

A personal accessibility layer that translates the **Chinese** PoE2 trade site
(`poe.game.qq.com/trade2`) to English. The CN site is a mirror of the international
one — the trade engine filters on language-independent ids, only the display
strings differ — so this is an **id-based translation** layer, not a rebuild.

A Tampermonkey userscript patches `fetch`/`XHR` on the CN site and rewrites the
trade API responses to English before the page renders. The dictionary is built
offline from the CN + intl data endpoints, plus item base names datamined from the
国服 game client.

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

Settings persist per browser. After a rebuild, the script auto-updates if you've
enabled "Allow access to file URLs" for Tampermonkey; otherwise reinstall the file.

## Data sources (factual only)

Two authoritative sources, nothing else:
- the **live trade API** (both `poe.game.qq.com` and `pathofexile.com`) for
  mods/stats, currency, filters, leagues, item categories;
- the **国服 WeGame client** for item base names, gem/skill text, and stat lines.

The WeGame 国服 client is **required** — its Simplified-Chinese data is the only
source that matches the 国服 trade site (the global client has no SC data, and
sites like poe2db are global/Traditional with no API). The datamine **auto-detects**
the WeGame install and errors clearly if it's missing.

## Rebuild the dictionary (after a game/content update, ~every 4 months)

Two steps. Both are re-runnable and idempotent.

```powershell
# 1. Client datamine — ONLY after a CN *client* update. Two scripts:
#    a) item bases, classes + gem/skill names & descriptions (joins on metadata Id)
C:\Users\addohm\Documents\filterblade2cn\tool\node\node.exe `
    C:\Users\addohm\Documents\poe2cn-trade-helper\tool\extract_items.mjs
#       add --refresh-schema if the dat schema changed this patch
#    b) full stat-description templates (gem/skill stat lines + mods), en<->zh
C:\Users\addohm\Documents\filterblade2cn\tool\node\node.exe `
    C:\Users\addohm\Documents\poe2cn-trade-helper\tool\extract_statdesc.mjs

# 2. Dictionary + userscript — after either the trade site OR the client updates.
#    Fetches the trade data endpoints from both hosts and merges the item data,
#    then writes dist/dict.json, dist/report.md, and dist/poe2cn-trade.user.js
wsl python3 /mnt/c/Users/addohm/Documents/poe2cn-trade-helper/tool/build_dict.py
#    --offline rebuilds from tool/raw/ cache without re-fetching
```

After step 2, **read `tool/dist/report.md`** — it shows coverage and a diff vs the
previous build (added/removed ids, item-base changes, any uncovered strings).
Then reinstall/refresh the userscript in Tampermonkey.

## Layout

```
tool/
  refresh.ps1              # one-command: datamine + fetch + rebuild (run after a patch)
  build_dict.py            # fetch trade endpoints (both hosts) + merge all data -> dict + userscript
  extract_items.mjs        # datamine item bases/classes + gem/skill names & descriptions
  extract_statdesc.mjs     # datamine full en<->zh StatDescriptions templates (gem/skill stats, mods)
  userscript.template.js   # userscript logic (__DICT__ injected at build time)
  sim_translate.py         # offline coverage check (data/* vs cached CN responses)
  sim_mods.py              # offline check of result-mod (affix) translation
  sim_dom.py               # offline check of DOM/chrome/tooltip/league translation
  data/                    # client-datamined inputs (item_bases, item_classes, skill_text, stat_lines)
  raw/                     # cached raw API responses (for --offline / diffing)
  dist/
    dict.json              # full bidirectional en<->zh dictionary
    dict.runtime.json      # slim display-only zh/id -> en (embedded in the userscript)
    poe2cn-trade.user.js   # << install this
    report.md              # coverage + diff-vs-previous
```

## Environment notes

- The builder fetches via Windows `curl.exe` (through WSL interop) because WSL's
  network stack can't reach `pathofexile.com` (a Windows-side proxy maps it to a
  fake-IP). It also sends browser headers + paces requests so Cloudflare's
  bot-fight doesn't 403 it.
- `extract_items.mjs` reuses the sibling `filterblade2cn` engine + portable node;
  it reads the CN install path from that project's `tool/data/config.json`.

## Scope / ToS

Personal translation + input-assist only. It translates what you already see and
helps you type search terms. It does **not** auto-trade, auto-whisper, mass-query,
or bypass the trade API rate limits.
