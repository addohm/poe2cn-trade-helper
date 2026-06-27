# Session Handoff — poe2cn-trade-helper

> A complete briefing for a fresh Claude Code session (on another machine, with
> **Playwright** available for live testing). Read top to bottom. The historical
> design log is in `HANDOFF.md`; **this** file is the current, practical reference.

---

## 0. What this is (1 paragraph)

A **Tampermonkey userscript** that translates the **Chinese (国服 / Tencent / WeGame)**
PoE2 trade site `https://poe.game.qq.com/trade2/*` into English. The CN site is a
**mirror** of `https://www.pathofexile.com/trade2`, so the trade engine filters on
**language-independent ids** — only the display strings differ. We translate at the
**API layer** (rewrite `/api/trade2/data/*` and `/api/trade2/fetch/*` JSON responses
before the SPA renders) plus a **DOM pass** for hardcoded chrome. The dictionary is
built offline from the trade API (both sites) **and** by datamining the 国服 game
client. Both trade sites require **login**.

- Repo: `https://github.com/addohm/poe2cn-trade-helper` (public)
- Install URL (raw `.user.js`): `https://raw.githubusercontent.com/addohm/poe2cn-trade-helper/main/tool/dist/poe2cn-trade.user.js`
- Current build at handoff: `2026.06.27.0243` (the `@version` is a UTC build timestamp).
- Userscript size: ~3.5 MB (all dictionary data inlined).

---

## 1. Files (everything in `tool/`)

| File | Purpose | Committed? |
| --- | --- | --- |
| `userscript.template.js` | The userscript logic. `__DICT__` / `__META__` / `__VERSION__` placeholders are injected at build time. **Edit translation logic here.** | yes |
| `build_dict.py` | Fetches the trade `data/*` from **both** hosts, merges the datamined client data, writes `dist/dict.json`, `dist/dict.runtime.json`, `dist/report.md`, and the final `dist/poe2cn-trade.user.js`. Flags: `--offline` (rebuild from `raw/` cache), `--timeout N`. | yes |
| `engine.mjs` | Self-contained `.dat` reader (uses `pathofexile-dat`). Exports `openInstall`, `extractTable(get,schema,name,langDir,columns)`, `listPaths`, `findGuofuInstall`, `getSchema`, `sanityCheckBaseItems`, `winToWsl`. POSIX paths; runs under WSL node. | yes |
| `extract_items.mjs` | Datamines the 国服 client: `BaseItemTypes`, `ItemClasses`, `ActiveSkills` (name+desc), and `Words.Text2` (unique/display names), all EN + Simplified-Chinese. → `data/{item_bases,item_classes,skill_text,unique_names}.json`. | yes |
| `extract_statdesc.mjs` | Datamines `Data/StatDescriptions/*.csd` (en + SC, paired by line) → `data/stat_lines.json` (zh-template → en-template, with `{N}` placeholders). | yes |
| `package.json` | Datamine deps: `pathofexile-dat ^15.1.0`, `pathofexile-dat-schema ^8.0.0`. Run `npm install` in `tool/`. | yes |
| `refresh.ps1` | **One-command** rebuild after a patch: `npm install` if needed → datamine (WSL node) → `build_dict.py` → git commit+push. ASCII-only (see gotchas). | yes |
| `sim_translate.py` | Offline coverage check: applies the runtime dict to cached CN responses. | yes |
| `sim_mods.py` | Offline check of result-mod (affix) translation. | yes |
| `sim_dom.py` | Offline check of DOM/chrome/tooltip/league/unique translation. | yes |
| `data/*.json` | Datamined inputs + `schema.cache.json` + optional `config.json`. **gitignored** (regenerated). | no |
| `raw/*.json` | Cached trade API responses (for `--offline`/diffing). **gitignored**. | no |
| `node_modules/` | `pathofexile-dat` etc. **gitignored** (`npm install`). | no |
| `dist/poe2cn-trade.user.js` | The installable artifact. | **yes** |
| `dist/{dict.json,dict.runtime.json,report.md}` | Build outputs. **gitignored**. | no |

Repo root also has `README.md` (user-facing), `HANDOFF.md` (historical design log, §1–§5),
and this file.

---

## 2. Dependencies / environment

- **WeGame 国服 PoE2 client** — *required for re-datamining* (the only source of the
  国服 Simplified-Chinese strings). Auto-detected at `/mnt/<drive>/WeGameApps/rail_apps/Path of  Exile 2(...)`
  (note the **double space** in the folder name). Override with `tool/data/config.json`
  `{"cnInstall":"C:\\..."}` or a CLI path arg.
- **WSL** (user runs Fedora) with `node` (v22), `npm`, `python3` (3.14). The user
  *prefers Python via WSL*; do not install Windows Python.
- **Tampermonkey** browser extension (the user uses **Brave**; Brave needs its
  "userscripts" toggle enabled or scripts silently don't run).
- A **logged-in** 国服 trade session (QQ/WeGame auth) to use/test the site.

---

## 3. How to rebuild after a patch

```powershell
# one command (Windows machine with WeGame + WSL):
powershell -ExecutionPolicy Bypass -File <repo>\tool\refresh.ps1
```
It: ensures `npm install`, runs `extract_items.mjs --refresh-schema` + `extract_statdesc.mjs`
on **WSL node**, runs `build_dict.py` (live-fetches both trade hosts, merges, rebuilds the
userscript), then commits + pushes. Browsers auto-update from the GitHub raw URL (or reinstall).

Manual equivalent (under WSL): `cd tool && node extract_items.mjs && node extract_statdesc.mjs`,
then `python3 build_dict.py` (or `--offline` to skip the network fetch).

---

## 4. Architecture / translation layers (how the userscript works)

`@grant none`, `@run-at document-start`. It must run in the **page context** to patch
`window.fetch` and `XMLHttpRequest` (the SPA uses **XHR/jQuery** for `data/*` and `fetch`
for `/fetch`). **Do not** switch to `GM_*` grants — that moves the script to a sandbox and
the patching breaks.

Translation happens in four places, all reading the injected `DICT`:
1. **`translate(pathname,json)`** — rewrites `data/{stats,static,items,leagues,filters}`:
   stats/static/filters/item-categories join by **id**; leagues by **position**; item base
   `type` by the zh string; unique `name` via `DICT.uniques`; the find-items **`text`** field
   (`"name base"`) is rebuilt from the translated parts.
2. **`translateFetch(json)`** — rewrites `/fetch` result listings: base types, and affix
   **mods**. Mods are now **objects** `{description, hash, ...}`; we translate `description`
   using the object's own `hash` (strip the leading `stat.`) → stat id → en template, then
   `fillNums` inserts the rolled numbers.
3. **`translateCache()`** — at document-start, translates the site's **own localStorage
   cache** (`lscache-trade2{stats,items,filters,data}`) **in place**, because the SPA serves
   `data/*` from that cache without refetching (so the network hook never sees it).
4. **DOM pass** (`tText`/`tAttr`/`tValue` + MutationObserver) — hardcoded chrome via the
   `CHROME` map, `PATTERNS` (gem cost/cast-time, "等级 N <skill>", listing times), full
   `StatDescriptions` templates (`statLines`/`translateStatLine`), item/skill names, skill
   descriptions, and `SUBSTR` (leagues, game title, `（遗产）`→`（Legacy）`).

**Reverse maps** (critical): `ITEM_REV` (en→zh, for rewriting the **outgoing** `/search`
query) and `REVERSE` (en→zh, for the **peek** feature) are **seeded from the dict at
startup** (inverting `DICT.items`/`DICT.uniques` + a baked `revSeed`), because the cache means
live translation may not run. `rewriteSearchBody()` rewrites the POST `/search` body so the
English item name the user picked is sent back to 国服 as Chinese.

**Panel + peek**: a floating **中EN** button opens settings (enable / DOM-pass / debug
toggles in `localStorage`, "Clear trade-data cache & reload", "Check item coverage", status).
Hold **`` ` ``** (backtick) or use the panel toggle to peek the original Chinese.

---

## 5. Bugs, trips & falls (hard-won — read before changing anything)

**Environment / tooling**
- **WSL cannot reach `pathofexile.com`** — it resolves to a fake-IP `198.18.0.199` from a
  Windows-side proxy that WSL's NAT can't route. `build_dict.py` fetches via **Windows
  `curl.exe` through WSL interop** (uses the Windows network stack). CN host works from WSL.
- **Cloudflare bot-fight** on `pathofexile.com` 403s bare requests → send full browser
  headers (Referer + Sec-Fetch-* + Accept-Language), pace ~1.5 s, retry, validate JSON.
- **PowerShell scripts must be ASCII-only.** Windows PowerShell reads UTF-8-without-BOM as
  the ANSI codepage; an em-dash's `0x94` byte becomes a curly quote and breaks parsing.
  `refresh.ps1` is ASCII; keep it that way. (The userscript & .md files can be UTF-8.)
- **The Bash tool mangles `wsl … /mnt/c/...` paths** (MSYS path translation prepends the Git
  install path). Run `wsl python3 /mnt/c/...` via the **PowerShell** tool, or use
  `wsl bash -lc "cd /mnt/c/... && ..."`.
- **GitHub `GH007`** (push blocked, would expose private email) → use the noreply email:
  `git config user.email "addohm@users.noreply.github.com"`; rewrite prior commits with
  `git rebase --root --exec "git commit --amend --no-edit --reset-author"`.
- **Tampermonkey auto-update is unreliable here.** The reliable update is: Dashboard → delete
  the script → reinstall from the raw URL. Confirm `[poe2cn] active - dict <version>` in console.

**国服-specific data facts**
- **国服 Simplified Chinese exists ONLY in the WeGame client.** The global Steam client has
  **no `Data/Balance/Simplified Chinese/` overlay** (tested — extraction throws). poe2db.tw is
  global/Traditional with no JSON API. So the only factual en↔国服-SC sources are the **live
  trade API** (both hosts) and the **WeGame client datamine**. Do not use external scrapes.
- **Items have NO language-independent id.** Unlike stats (which round-trip an id), the item
  `type`/`name` string **is** the value sent to the search API. Translating it for display
  REQUIRES `rewriteSearchBody` to map it back to Chinese, or the 国服 backend returns
  **"Unknown Base Type" (发生错误)**.
- **The SPA caches `data/*` in localStorage** (`lscache`) and serves it without refetching —
  so the network hook often never runs. `translateCache()` is what actually makes most things
  work on a normal reload. Clearing the lscache key does **not** reliably force a refetch.
- **Result affix mods became objects** `{description, hash}` in a 2026-06 patch (were plain
  strings before). Translate `description`; the `hash` is `stat.<section>.stat_<n>` → strip
  `stat.` → matches `DICT.stats` ids.
- **find-items uniques** match/display on a combined **`text`** field (`"<name> <base>"`),
  not `name`/`type`. Must rebuild `text` from the translated parts.
- **Unique display names live in `Words.Text2`** (NOT `Words.Text`, which isn't localized in
  the SC overlay). Found by scanning every SC-overlay table for a known unique zh string.
  Joined EN↔SC by **row index** (Words has no `Id`).
- **`（遗产）`** = the 国服 legacy-variant unique marker → `（Legacy）` (in `SUBSTR`).
- Leagues use a **position-join** (the league `id` is the localized name). Stat `data/stats`
  has **no inline `option`/dropdown values** in PoE2 (unlike PoE1).

**Userscript mechanics**
- Patch **both** `fetch` and `XHR`. XHR uses **lazy `responseText`/`response` getters** to
  sidestep listener-ordering; handle `responseType` `''`/`text`/`json`.
- Peek pauses the MutationObserver while held; reverse values must be strings (guarded).
- StatDescriptions matching: normalize the rendered line's numbers to `#`, look up by
  normalized-zh, then **regex-confirm** (so literal numbers in a template must match) before
  filling — avoids mis-translation.

---

## 6. Known remaining gaps (mostly inherent, not bugs)

- **国服 content lag**: some items international's trade has are not in 国服's trade
  `data/items` yet (e.g. `Vile Greataxe`, `Vilenta's Propulsion`, `Necrotic Catalyst`).
  Not surfacable — the 国服 backend doesn't serve them. The **Check item coverage** panel
  button + per-patch `report.md` track this.
- **Magic affix words** (prefix/suffix name fragments like "Galvanic") are partially covered
  by `Words.Text2`; some still show Chinese. A fuller affix-name pass could datamine more of
  `Words`.
- **Peek** covers what's in the reverse maps (items, uniques, filters, static, categories,
  leagues, stat groups, live result mods) — not every individual stat-filter template.
- **Rare item names** (affix-generated, e.g. `雕琢的苦难`) aren't in any table.

---

## 7. The "Reaver Catalyst" / "Vilenta's Propulsion" availability investigation (requested)

The user asked to record my assessment of whether these exist on the 国服 client and **how I
got there**. To be accurate (a handoff must be), here is exactly what the data shows — note it
**differs from the casual recollection** that both are "missing":

**Method (three cross-checks):**
1. Grep `tool/data/item_bases.json` (the datamined 国服 client `BaseItemTypes`, en+zh joined on
   the language-independent metadata `Id`) for the English name.
2. Join the 国服 vs international **client** `BaseItemTypes` on metadata `Id`
   (`filterblade2cn/data/{cn,intl}_baseitemtypes.json` exist, or re-datamine both) → items in
   one client but not the other.
3. Compare 国服 vs international **trade** `data/items` (the cached `raw/{cn,intl}_items.json`),
   translating the CN side with the runtime dict → items in one *trade* endpoint but not the
   other.

**Findings:**
- **Reaver Catalyst — EXISTS on 国服 (client AND trade).** Metadata `Id`
  `Metadata/Items/Currency/CurrencyJewelleryQualityAttack`, zh **`袭击催化剂`**, and it's in our
  dictionary/translation. So it is **not** missing. (The recollection that it doesn't exist is
  most likely a mix-up with **Necrotic Catalyst** — see below.)
- **Vilenta's Propulsion (gem) — present in the 国服 CLIENT `BaseItemTypes` but ABSENT from the
  国服 TRADE `data/items`.** So the base files exist in the installed client, yet the 国服 trade
  backend doesn't list it → it can't be searched/traded on 国服. Same situation as
  **`Vile Greataxe`** (weapon). This is a **client-ahead-of-trade lag**, not a client absence.
- **Necrotic Catalyst / Refined Necrotic Catalyst — in the international client but NOT the 国服
  client** (this is the genuine 2-item client-level difference found by cross-check #2).

**Honest caveat:** I could **not** browse the live 国服 trade site myself (the Claude-in-Chrome
extension refuses `qq.com`, and the trade search needs auth → `401` unauthenticated). All of the
above is from the datamined client files + cached trade-API JSON. **A session with Playwright +
a logged-in 国服 session should verify these against the live site** (type "Reaver"/"Vilenta"/
"Necrotic" in find-items) and update this section with ground truth.

---

## 8. Playwright guidance for the next session

You have Playwright; I did not — so **live verification** is the main new capability. Notes:

- The trade site requires a **logged-in** 国服 session. Use a **persistent context** (or
  inject `storageState` from a logged-in session) — the user said they'll provide access.
- Tampermonkey won't be in a fresh Playwright browser. Two options: (a) launch a persistent
  context that already has Tampermonkey + the script installed, or (b) **inject the userscript
  directly** with `page.addInitScript({ path: 'tool/dist/poe2cn-trade.user.js' })` so it runs
  at document-start in the page context (matches `@grant none` behavior). Option (b) is the
  cleanest for automated testing.
- **Things to verify live** (and feed back into fixes):
  - `find-items` autocomplete: type English (`vile`, `andvarius`, `reaver`, `vilenta`,
    `necrotic`) — confirm which items appear; reconcile with §7.
  - Selecting a base/unique and searching returns results (no "Unknown Base Type").
  - Result cards: affix mods, base types, prices, labels are English.
  - Gem tooltip (hover a "Grants Skill" link): name, description, Cost/Cast Time, stat lines.
  - Peek (hold backtick) reverts to Chinese and restores.
  - The 中EN panel: toggles, "Check item coverage" (paste any untranslated list back).
- **Capture for debugging**: turn on Debug logging in the panel; collect `[poe2cn] …` console
  lines and any `/api/trade2/fetch/` response shapes (the mod object shape can change per patch).
- Watch for: Cloudflare/anti-bot on automation, the `document.domain` console warning (benign),
  and the lscache behavior (data/* served from cache — `translateCache` handles it).

**Respect ToS**: this is a personal translation/accessibility layer. Do **not** automate
trading, whispering, mass-querying, or bypass rate limits. Playwright is for *verifying
translation*, not driving the market.

---

## 9. Quick validation without a browser

From `tool/` (WSL): `python3 sim_translate.py`, `python3 sim_mods.py`, `python3 sim_dom.py`
check coverage/correctness against cached data. `node --check dist/poe2cn-trade.user.js`
syntax-checks the build. `tool/dist/report.md` shows per-section coverage + diff-vs-previous.
