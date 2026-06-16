# Handoff: 国服 PoE2 trade-site usability / translation tool

> For a fresh Claude Code session. Goal, confirmed context, the core reusable asset, the
> tool-shape decision, and a concrete MVP path. Read top to bottom.

---

## 1. Objective

Make the **Chinese** PoE2 trade website usable for an English speaker — as close as possible to the
seamlessness of the international site. The CN site is a **mirror** of the international one, so this
is fundamentally a **translation + input-assist** layer, not a rebuild of trade logic.

- CN trade:   `https://poe.game.qq.com/trade2/search/poe2/<league>`
- Intl trade: `https://www.pathofexile.com/trade2/search/poe2/<league>`
- **Both require login (authenticated session).**

Confirmed mirror relationship: the example URLs are the same search on each site — CN league
`奥杜尔秘符` (URL-encoded) decodes to and equals intl league **"Runes of Aldur"**.

---

## 2. The core insight (why this is tractable)

Because CN mirrors intl, the trade engine filters on **language-independent IDs** — stat ids,
item-type ids, league ids. Only the **display strings** differ (中文 vs English). So the right
approach is **id-based**, not fuzzy translation:

> Build a dictionary `id → { en, zh }` once, then translate the CN site's text to English by id, and
> translate the user's English input back to the ids the CN site expects.

### Where the dictionary comes from
1. **Trade data endpoints (authoritative for trade UI).** Both sites expose the same static data API
   (verify exact paths in the browser Network tab — expected to mirror intl):
   - `GET /api/trade2/data/stats`   — every searchable stat/mod, with stable `id` + localized `text`
   - `GET /api/trade2/data/items`   — item base types / categories, by `type` + localized name
   - `GET /api/trade2/data/static`  — currencies, fragments, misc, with ids + localized names
   - `GET /api/trade2/data/leagues` — league id ↔ localized name
   - (search/fetch: `POST /api/trade2/search/poe2/<league>`, `GET /api/trade2/fetch/<ids>?query=<id>`)

   Fetch each from **pathofexile.com** (English) and **poe.game.qq.com** (Chinese), join on `id`/
   `type`/`entries[].id` → a complete en↔zh map for everything the trade UI shows. The `data/*`
   endpoints are typically **public (no auth)** — verify; if so the dictionary build is trivial and
   offline.
2. **Item base names (supplement).** The sibling project already datamines item base types in both
   languages from the 国服 client (English base table + Simplified-Chinese overlay, joined on the
   shared metadata `Id`). Reuse if the trade endpoints miss anything. See
   `C:\Users\addohm\Documents\filterblade2cn\tool\` (engine `core.mjs`, data in `tool\data`).

Regenerate the dictionary per league/patch — same "refresh after update" pattern as the filter tool.

---

## 3. Tool shape — decision

| Shape | Verdict |
| --- | --- |
| **Browser extension / userscript** on `poe.game.qq.com/trade2/*` | **CHOSEN.** Runs inside the authenticated session automatically; can translate at the **API layer** (patch `fetch`/`XMLHttpRequest` to rewrite JSON responses) and the **DOM** (MutationObserver for the SPA). Most seamless. Start as a **Tampermonkey userscript MVP**, graduate to a packed extension (Chrome/Firefox). |
| English "reskin" web app calling the CN API with the session cookie | Possible later; full UX control but you rebuild the trade front-end + handle auth. Overkill for v1. |
| Desktop overlay (transparent window) | **Rejected** for a website: no DOM/API access → OCR/scraping, brittle, ignores the browser session. Overlays are for the game client, not web pages. |
| Translating MITM proxy | Rejected: cert/auth fiddle, more invasive than needed. |

---

## 4. Architecture (extension / userscript)

- **Translate at the data layer first.** Monkey-patch `window.fetch` and `XMLHttpRequest` in a
  content script; when the site requests `…/data/*`, `…/search/*`, `…/fetch/*`, rewrite the localized
  strings in the JSON response to English using the id-dictionary *before* the site's JS renders them.
  This is far more robust than chasing rendered DOM nodes, because the SPA renders from this data.
- **DOM pass for static chrome.** A MutationObserver translates fixed UI labels/buttons/placeholder
  text the dictionary covers but that aren't data-driven.
- **English input assist.** Let the user type English stat/item names; map to the CN ids and feed the
  site's existing autocomplete/search (either prefill the CN term or inject the id directly).
- **Dictionary delivery.** Ship the prebuilt `id→{en,zh}` JSON with the extension (built by a small
  Node script, reusing the filter project's toolchain). Add a "rebuild dictionary" step for new
  leagues/patches.

---

## 4b. VERIFIED (2026-06-15): data/* is public — no auth

Tested unauthenticated (no cookies, browser UA) against both hosts. All four endpoints return
**HTTP 200 with real JSON**:

- `data/stats` — IDs are **identical across hosts**; only `text`/`label` differ. e.g.
  `pseudo.pseudo_total_cold_resistance` → intl `"+#% total to Cold Resistance"` / cn `"+#% 总冰霜抗性"`.
  Group label intl `"Pseudo"` / cn `"综合"`. → **join on `id`, swap `text`. Confirmed.**
- `data/items`, `data/static` — same, reachable public.
- `data/leagues` — **special case: no shared id.** The league `id` *is* the localized name, so it
  can't be id-joined. But both hosts return the **same array in the same order**, so join by
  **position/index** (sanity-check the count). Current mapping:
  | intl | cn |
  | --- | --- |
  | `Runes of Aldur` | `奥杜尔秘符` |
  | `HC Runes of Aldur` | `奥杜尔秘符（专家）` (专家 = Expert/HC) |
  | `Standard` | `永久` (永久 = permanent) |
  | `Hardcore` | `永久（专家）` |
- CN `data/stats` headers: `Content-Type: application/json`, `Cache-Control: max-age=1140` — genuine
  cacheable static endpoint.

**Implication:** dictionary build is **fully offline** — a single Node script fetching both hosts, no
auth/cookies, no CORS workaround, no background service worker. Auth only matters at *runtime* for
search/fetch, where the userscript is same-origin on the CN site and the cookie rides along. The
"much simpler" branch is the actual situation.

---

## 4c. BUILT (2026-06-15): `tool/build_dict.py` — the dictionary builder

Reusable, zero-dependency (stdlib) Python builder. Run per patch:
```
wsl python3 /mnt/c/Users/addohm/Documents/poe2cn-trade-helper/tool/build_dict.py
wsl python3 .../build_dict.py --offline   # rebuild from cached raw/ (no network)
```
Outputs `tool/dist/dict.json` (the en↔zh map) + `tool/dist/report.md` (coverage +
diff-vs-previous). Caches raw responses in `tool/raw/`.

**Environment quirks discovered (important for future runs):**
- WSL's network stack **cannot reach `pathofexile.com`** — it resolves to a fake-IP
  `198.18.0.199` from a Windows-side proxy/VPN (Clash/v2ray-style) that WSL's NAT can't route.
  CN host resolves to a real IP and works from WSL. **Fix:** the builder fetches via Windows
  `curl.exe` through WSL interop, so requests use the Windows network stack (and its proxy).
- `pathofexile.com` is behind **Cloudflare bot-fight**: bare requests get a 403 (a ~5470-byte
  block page). **Fix:** builder sends full browser headers (Referer + `Sec-Fetch-*` +
  `Accept-Language`), paces requests (1.5s), retries with backoff, and validates each response
  is real JSON (has a `result` key) before caching.

**First build results (`奥杜尔秘符` / Runes of Aldur league):**
| section | join | result |
| --- | --- | --- |
| stats | by id | **6930 matched** (intl 8108, cn 7049 — CN lags ~1100 mods, but every shared id matched). Translations verified correct. |
| static | by id | **747 matched** (intl 775, cn 773). Confirms static entry ids ARE shared. |
| leagues | by position | **4/4** clean. |
| items | by position | **FAILED — 77 only.** 7 of 10 categories skipped on count mismatch: currency 564 vs 21, armour 1550 vs 1450, weapon 518 vs 397, gem 905 vs 723, map 63 vs 45, accessory 153 vs 152, sanctum 13 vs 12. CN lags the intl patch too far for position-join. |

Note: PoE2 `data/stats` has **no inline `option`/dropdown values** (0 found) — unlike PoE1. The
builder handles options if they ever appear, but currently there are none.

**Items conclusion:** position-join is a dead end. Use the §6 datamined fallback — extract
BaseItemTypes from the 国服 client in BOTH English and Simplified-Chinese overlays via
`filterblade2cn\tool\engine\core.mjs` `extractTable()`, join on the language-independent metadata
`Id`. This is robust because metadata `Id` is language-independent.

---

## 4d. DONE (2026-06-15): items solved via client datamining

- Discovered the SC overlay path: `Data/Balance/Simplified Chinese/<table>.datc64` (215 tables).
  The overlay carries the SAME `Id` column as the English table, so EN vs SC id-joins cleanly
  (BaseItemTypes: 5474 rows each, 4894 actually translated).
- Made a **backward-compatible** addition to the shared engine: `extractTable(get, schema, name,
  langDir=null)` in `filterblade2cn\tool\engine\core.mjs` now reads the `langDir` overlay when given
  (all existing 3-arg callers unaffected).
- New extractor: `poe2cn-trade-helper\tool\extract_items.mjs` — reuses the sibling engine
  (openInstall/getSchema/extractTable), reads the CN install path from the sibling `config.json`,
  extracts BaseItemTypes + ItemClasses in EN and SC, joins on `Id`, writes
  `tool\data\item_bases.json` + `item_classes.json` (+ `items.meta.json`). Run with the sibling
  portable node:
  ```
  C:\Users\addohm\Documents\filterblade2cn\tool\node\node.exe `
      C:\Users\addohm\Documents\poe2cn-trade-helper\tool\extract_items.mjs
  ```
  Re-run after a CN **client** content update. Output: 5053 base names, 92 item classes.
- `build_dict.py` now MERGES these: item **category labels** still id-join from the trade
  endpoint (robust, 10/10), item **base names** come from `item_bases.json`. Coverage check:
  **2145/2152 (99.7%)** of CN trade `type` strings are covered; the 7 misses are brand-new
  `Rune*`-crafted bases that the CN trade backend itself still shows in English (no-op to translate).

**Two-step refresh workflow (per patch):**
1. `node extract_items.mjs`  — only after a CN **client** update (new item bases). Optional `--refresh-schema`.
2. `python build_dict.py`    — after either site/client update; fetches trade endpoints + merges item data.

**Final `dict.json` shape:** `meta`, `stats{groups,entries,options}`, `static{groups,entries}`,
`items{categories,bases,classes,source}`, `leagues[]`. All values are `{en, zh}` pairs (or lists of
them), indexable in either direction. Totals: 6930 stats, 747 static, 5053 item bases, 92 classes,
10 item categories, 4 leagues.

---

## 4e. BUILT (2026-06-15): Tampermonkey userscript MVP (data-layer translation)

- `tool/userscript.template.js` — the userscript logic (real JS, with `__DICT__`/`__VERSION__`
  placeholders). Patches **both** `window.fetch` and `XMLHttpRequest` (the SPA could use either;
  jQuery/axios use XHR). On `/api/trade2/data/{stats,static,items,leagues}` it rewrites the localized
  strings to English **before the app renders**:
  - stats/static → keyed by entry `id` (robust); item categories → group `id`; item bases → by the
    localized `type` string (zh→en); leagues → by `text`. **Leaves all `id`s untouched** so the
    site's search/fetch calls keep working.
  - XHR interception uses lazy `responseText`/`response` getters (handles `''`/`text`/`json`
    responseTypes) to sidestep listener-ordering issues.
- `build_dict.py` now also emits `dist/dict.runtime.json` (slim, display-only zh/id→en) and injects
  it into the template → **`dist/poe2cn-trade.user.js`** (one self-contained installable file, ~725 KB,
  no hosting / no file-access perms needed). Version stamp = build time.
- Validated offline against the cached live CN responses (`tool/sim_translate.py`): **stats 99.4%,
  static 100%, item bases 99.7%, item categories 100%, leagues 100%** would render in English.
See `README.md` for the per-patch refresh + install steps.

## 4f. LIVE-TESTED (2026-06-15): data-layer translation works; key findings

Confirmed working on the live authenticated CN site:
- The SPA uses **XHR** (jQuery — `plugins.<hash>.js`), no service worker. Our XHR interception
  (lazy responseText/response getters) translates `data/stats|static|items|filters` correctly.
  Stat-filter dropdown + item-type search render in **English**, and because we replace the text the
  app filters on, **typing English already works as input-assist** for those.
- **Brave gotcha:** the user must enable userscripts in Brave (`brave://settings/...`) for
  Tampermonkey scripts to run — until then the script silently doesn't load.
- **CLIENT-SIDE CACHE (important):** the SPA caches the big `data/*` payloads in **IndexedDB/Local
  Storage** and reads them from there on reload, so our network hook only fires on a *cache miss*.
  To translate already-cached data the user had to clear site storage (IndexedDB + Local Storage +
  Cache Storage, **keeping cookies** to stay logged in) once, then reload. **TODO: make the userscript
  auto-bust/translate the app's cache** so manual clearing isn't needed on each dict update (need to
  identify the IndexedDB db/store names — diagnostic pending).
- Added **`/data/filters`** translation (filter-panel chrome): id-join at 3 levels (section title /
  filter text / option text) + a zh→en fallback for null-id options like 'Any'. Coverage: section
  titles 6/7, named filters 55/57, dropdown options 136/136.

**Claude-in-Chrome note:** the extension **refuses to navigate to `poe.game.qq.com`** ("not allowed
due to safety restrictions"), so live testing must be done by the user, not driven by Claude.

## 4g. BUILT (2026-06-15): auto cache-bust, chrome DOM pass, result translation

Three additions to the userscript (built into `tool/userscript.template.js`, emitted by build_dict.py):

1. **Auto cache-bust (no more manual clearing).** Confirmed the SPA caches data/* in **localStorage
   via the `lscache` lib** (keys `lscache-trade2{stats,filters,items,data}` + `-cacheexpiration`; no
   IndexedDB). At document-start the script compares the injected dict version to a stored marker and,
   on change, removes just those keys (leaves `__POESESSION` etc.) so the app refetches once through
   our hook and re-caches the English copy. **Verified working live** — user reloaded and everything
   refetched+translated with no DevTools clearing.

2. **DOM chrome pass.** Exact-match (trimmed) zh→en `CHROME` map for hardcoded UI the data endpoints
   don't cover: stat-filter section header + add buttons, action buttons (incl. `<input>` `value`
   attrs like the Search button), result-card labels (`询价`/`费用`/`前往藏身处`/…), item property &
   requirement labels (`物理伤害`/`暴击率`/`需求`/`等级`/`力量`…), and input placeholders
   (`最小值`/`最大值`). Also falls back to `DICT.items`/`DICT.itemClasses` for result base-type/class
   text. MutationObserver covers childList/characterData/placeholder+value attrs. **Extend the CHROME
   map as more fixed strings surface.**

3. **Search-result translation (`/api/trade2/fetch/`).** New `translateFetch`: translates each item's
   `baseType`/`typeLine` (via DICT.items) and every affix line. Mod translation is **hash-based first**
   — `item.extended.hashes.<section>[i][0]` gives the stat id → English template, and the numbers are
   extracted from the rendered zh string and re-inserted into the `#` slots (separator/word-order
   independent). **Fallback:** if no hash, normalize the rendered mod's numbers to `#` and look up
   `statsByZh` (zh template → stat id). Offline-validated against real affix lines
   (`tool/sim_mods.py`): ranges, %, and keyword mods translate correctly.
   - **NOT yet live-verified** (search needs the user's auth session; couldn't capture a sample
     `/fetch` myself — POST /search returns 401 unauthenticated). Needs a live check that CN `/fetch`
     includes `extended.hashes` aligned with the `*Mods` arrays. `DEBUG=true` logs `translated fetch →
     N changes` to confirm.

## 4h. LIVE-CONFIRMED + finishing touches (2026-06-15)

Result translation **verified live**: console logged `translated fetch → 69 changes`; result cards
show English base types and affix mods (`62% increased Fire Damage`, `Gain 17% of Damage as Extra
Fire Damage`, etc.). Then added:

- **`map_iiq` override** — CN exposes a Waystone-Item-Quantity filter (`引路石物品掉落数量增加`) with
  **no intl counterpart**, so the id-join couldn't translate it. Added `MANUAL_FILTER_TEXT` in
  build_dict (`map_iiq → "Waystone IIQ"`, matching intl's sibling `map_iir`/"Waystone IIR"). The user's
  guess of "Monster Effectiveness" was a different filter (`map_magic_monsters`, already translated).
- **Granted-skill lines** — `等级 10 力量抽取` → `Level 10 Power Siphon` (pattern `等级 N <skill>`,
  skill name via DICT.items, which includes gem bases).
- **Gem-tooltip labels** — `消耗`/`施放时间`/`需求`/`法术`/`物理` + tags, with colon-aware matching
  (`需求：` → `Requires：`) and gem cost/cast-time patterns (`消耗: 0 点魔力` → `Cost: 0 Mana`).
- **DOM stat-pattern translation** — text nodes are now also run through the `statsByZh` reverse-match,
  so any *trade* stat rendered anywhere (e.g. in tooltips) translates, not just /fetch result mods.
- **League dropdown** — `SUBSTR` map (game-title prefix + the 4 league names) handles the composite
  `《流放之路：降临》 - 奥杜尔秘符` → `Path of Exile 2 - Runes of Aldur`. (data/leagues is NOT fetched
  at runtime — it's embedded — so this must be done in the DOM, not via response translation.)
- **Relative listing times** — `上架 7天前` → `Listed 7d ago`.
- `DEBUG` set to **false** (clean console; flip true in the template to debug).

All DOM logic offline-validated in `tool/sim_dom.py`.

## 4i. BUILT (2026-06-15): gem/skill datamine (names + descriptions)

- Generalized the shared engine: `extractTable(get, schema, name, langDir, columns=['Id','Name'])`
  now takes an optional **columns** list (backward compatible).
- `extract_items.mjs` now also extracts **`ActiveSkills`** (`Id`, `DisplayedName`, `Description`) in
  EN + SC, joined on `Id` → `tool/data/skill_text.json` (923 skills, 838 with descriptions).
- Descriptions carry PoE rich-text markup `[Key|Display]`; `build_dict.py` **strips it to the display
  text** (`strip_tags`) so the stripped zh matches what the tooltip renders, then adds runtime maps
  `skillNames` (zh→en, 775) and `skillDesc` (zh→en, 750).
- Userscript `tText` now resolves skill names (step 3) and **full-sentence skill descriptions**
  (step 4), plus standalone gem value nodes (`0 点魔力`→`0 Mana`, `0.85 秒`→`0.85s`). All
  offline-validated in `sim_dom.py` (incl. the live Mana Drain tooltip text).

Gem tooltips now translate: header, tags, Level, Cost/Cast Time/Requires + values, granted-skill
line, and the **description prose**.

## 4j. BUILT (2026-06-15): StatDescriptions — full gem/skill stat-line translation

The client's `Data/StatDescriptions/*.csd` files (UTF-16LE) hold every stat line in all languages:
a `description` block = `<count> <stat ids>`, then the default **English** section, then
`lang "Simplified Chinese"` (and other) sections; each section is `<numLines>` then lines of
`<range tokens> "<text with {0}/{1}>" [modifiers]`, with `[Key|Display]` markup.

- Added `core.listPaths(gameDir)` (lists bundle file paths) + generalized `extractTable` columns.
- `extract_statdesc.mjs` parses the trade-relevant subset (general + gem/skill/mod/specific-skill;
  skips monster/atlas/passive/etc.), pairs the English and Simplified-Chinese line of each block by
  index, strips markup, keeps `{N}` placeholders → `tool/data/stat_lines.json` (**20,962** zh→en
  templates). Run it alongside `extract_items.mjs` after a CN client update.
- `build_dict.py` ships these as runtime `statLines`. The userscript builds a Map keyed by the
  fully-normalized zh ({N} + literal numbers → `#`) and, on a hit, **confirms with a regex** (so a
  template's literal numbers must match) and transplants the rolled values into the English template
  (correct even when word order differs). Wired into `tText` (DOM) — gem tooltips now fully translate
  (validated in `sim_dom.py`: `偷取 96 魔力`→"Leeches 96 Mana", `造成 26 - 49 物理伤害`→"Deals 26 to
  49 Physical Damage", the Power Siphon mechanic, etc.). It also serves as a safety net for any result
  mod the /fetch hash path misses. Userscript is now ~3.4 MB (fine for a local script).

**Known remaining gaps (minor):**
- **Rare item names** (`雕琢的苦难`) — affix-generated; not in any table (low value).
- **History / Settings sub-pages** — likely a few more fixed `CHROME` strings; add as spotted.

## 4k. BUILT (2026-06-16): in-browser management panel + WeGame check + data-source decision

**Data-source decision (settled — see memory `factual-sources-only`, `guofu-simplified-only-in-tencent-client`):**
Use only authoritative sources — the **live trade API** (both hosts) and the **国服 WeGame client**
datamine. NO external scrapes (poe2db = no API + global/Traditional, won't match 国服 Simplified;
proven the global Steam client has no SC overlay at all). The WeGame client is a hard requirement.

**Why no live in-browser Tier-1 fetch:** intl `data/*` sends **no CORS header** and its OPTIONS
preflight is 401, so a `@grant none` page-context fetch from poe.game.qq.com to pathofexile.com is
blocked. Live fetch would need `GM_xmlhttpRequest` → Tampermonkey sandbox → patch via `unsafeWindow`
(cross-context `Response` risk) — fragile, and untestable from here. AND every content patch updates
the client (forcing a datamine run that also refreshes the trade-API data), so live Tier-1 adds risk
for ~no freshness benefit. Decision: keep the proven `@grant none` engine; refresh all data via the
offline build per patch.

**WeGame auto-detect:** `core.findGuofuInstall()` scans common WeGame roots
(`<drive>\WeGameApps\rail_apps`, `…\WeGame\rail_apps`) for a "Path of Exile 2" dir containing
`Bundles2\_.index.bin`. Both `extract_items.mjs` and `extract_statdesc.mjs` resolve the install via
CLI arg → sibling config → auto-detect, and **exit with a clear error** if not found.

**In-browser management panel:** the userscript injects a floating "中EN" button (bottom-right) →
panel with: master **Enable translation** toggle, **Translate page text** (DOM pass) toggle, **Debug
logging** toggle (all persisted in `localStorage` under `poe2cn:*`, read synchronously at
document-start so the engine gates on them), a **Clear trade-data cache & reload** button, and a
status block (dict version, build date, counts). Toggling Enable busts the lscache so data refetches
in the new mode. `build_dict.py` injects a `__META__` blob (version/builtAt/counts) for the panel.

**Optional auto-update:** the userscript header has `@updateURL`/`@downloadURL` pointing at the local
`dist/poe2cn-trade.user.js`; works if "Allow access to file URLs" is enabled for Tampermonkey,
otherwise reinstall after a rebuild.

**Net per-patch flow:** run `tool/refresh.ps1` (auto-detects WeGame, datamines, live-fetches trade
API, rebuilds) → reload/auto-update the userscript. Everything else (toggles, cache, status) is in
the panel. The `@grant none` translation engine is unchanged from the live-validated version.

---

## 5. Auth & CORS (important)

- The extension/userscript runs **same-origin** on `poe.game.qq.com`, so the user's session cookie is
  sent automatically — search/fetch calls just work.
- Building the dictionary needs the **English** data from `pathofexile.com`. A content script on the
  CN origin **cannot** cross-origin fetch that (CORS). Options: build the dictionary **offline** with a
  Node script (fetch both hosts; `data/*` is likely public), or use an extension **background**
  service worker with appropriate host permissions. Prefer the offline prebuild — simpler, cacheable,
  no live cross-site calls.

---

## 6. Reusable assets from the FilterBlade-CN project (`…\filterblade2cn`)

- Portable Node: `tool\node\node.exe` (no system install needed).
- Datamining engine `tool\engine\core.mjs`: `openInstall()`, `extractTable()` (Id+Name in any
  language via the `Data/Balance/<Language>/` overlay), dependency-free helpers. Use to build the
  item-base en↔zh map from the 国服 client if needed.
- Extracted data in `tool\data\`: `cn_baseitemtypes_en.json`, `intl_baseitemtypes_en.json`,
  `cn_itemclasses_en.json`. Metadata `Id` is the shared join key across clients/languages.
- Patterns proven there: build a cached dictionary, refresh-after-patch, dependency-light Node tooling,
  optional local web UI.

---

## 7. ToS / safety

This is a **personal accessibility/translation layer**, not automation. Keep it that way: do **not**
auto-trade, auto-whisper, mass-query, or bypass the trade API **rate limits** (honour the site's
`X-Rate-Limit*` headers and back off). Translating what the user already sees and helping them type
search terms is the scope. Flag this boundary to the user before shipping anything that issues
requests on a timer.

---

## 8. First steps (MVP)

1. Log into the CN trade site; open DevTools → Network; record the exact `/api/trade2/data/*`,
   `/search/*`, `/fetch/*` request/response shapes. Confirm `data/*` is reachable without auth.
2. Write a Node script (reuse `…\filterblade2cn\tool\node`) that fetches `data/stats`, `data/items`,
   `data/static`, `data/leagues` from **both** hosts and emits `dict.json` (`id→{en,zh}`). Spot-check
   "Runes of Aldur"/`奥杜尔秘符` and a few stats.
3. Tampermonkey userscript on `poe.game.qq.com/trade2/*`: patch `fetch`/XHR to translate responses via
   `dict.json`; verify stat-filter names and item names render in English.
4. Add English-input autocomplete mapping. Iterate, then package as a real extension.
