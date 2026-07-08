# UNIFY-DICT-HANDOFF — consolidate the trade helper onto `poe2-en-cn-dict`

## AS-BUILT (implemented 2026-07-08)

Phases A and B are **done and verified**. One deviation from the plan below, for a
proven correctness reason:

- **Phase A (export) — as planned.** `poe2-en-cn-dict/poe2dict/consumers.py` +
  `export_consumers.py` emit `dictionary/consumers/trade-helper/` (items, uniques,
  skills, item_classes, stat_lines `[[zh,en]]`, stat_by_hash, cn/en flat lookups).
  A full `build.py` also emits it as a final step.
- **Phase B (rewire) — datamine dropped, intl KEPT.** `tool/build_dict.py` now
  sources ALL client content from the export (the local `extract_*.mjs` datamine
  is dead). BUT it still fetches **both** hosts for the structural id-joins.
  Reason: fully dropping intl regressed `DICT.stats` from ~6934 to ~3277 ids —
  the client stat-description export covers only ~48% of trade `data/stats` ids by
  hash, and text-matching recovers ~0% (the trade API phrases stats differently
  than the client `.csd`). The un-coverable half are **pseudo aggregates** and
  **compound radius-jewel mods**, which GGG's trade backend assembles and which
  have no client stat-description. intl `data/stats` is the sole authoritative
  source for them, so the robust intl+cn id-join stays. Every structural map
  (stats/static/filters/categories/leagues) is byte-identical to the pre-unify
  build; only the content maps now come from the export (items −151 benign
  identity `zh==en` bases; statLines +5k, richer).

Net: the **datamine duplication is gone** (the user's core goal); intl remains one
build-time trade-API fetch (already handled via curl.exe, works). If zero live
intl is ever wanted, freeze an intl `data/stats` id→en snapshot refreshed per
patch — noted but not done (live curl fetch is fine).

Verified: `build_dict.py --offline` and live both clean; emitted userscript passes
`node --check`; DICT has all 17 keys; `sim_translate/mods/dom` pass (static 100%,
bases 100%, pseudo aggregates translate, gem tooltips translate). Still TODO by the
user: reload the userscript over the live site to eyeball it (logic is unchanged,
so this is a sanity check, not a risk).

Open (not done, awaiting user): delete the deprecated `tool/{engine,extract_*}.mjs`
+ `tool/data/` + `tool/package.json`; commit both repos.

---

**Status (original plan below):** planning brief for a fresh Claude Code session.
Read this top to bottom before touching either repo.

**Goal:** make the standalone dictionary at `C:\Users\addohm\Documents\poe2-en-cn-dict`
the single source of truth, and rewire the **poe2cn-trade-helper** userscript
build to consume it — deleting the trade helper's own client-datamine pipeline
and its dependency on the international (`www.pathofexile.com`) trade host.

---

## 0. Environment / hard constraints (do not violate)

- **Python runs under WSL (Fedora), not Windows.** Invoke as
  `wsl python3 "/mnt/c/Users/addohm/..."`. There is no Windows `python`.
- **PowerShell scripts must be ASCII-only** (no em-dash, no CJK) — see the
  existing `tool/refresh.ps1`.
- The **Bash tool mangles `wsl /mnt/c/...` paths** — run `wsl` via the PowerShell
  tool.
- **Do not touch** the separate PoB workstream files: `POB-FORK-HANDOFF.md`
  (it has uncommitted edits). Different project.
- **Factual sources only:** live trade API + the local 国服 WeGame client. 国服
  Simplified strings exist ONLY in the Tencent/WeGame client (global Steam client
  has no Simplified overlay). No scraping poe2db or other flaky sources.
- GitHub email privacy: commit as `addohm@users.noreply.github.com`.

---

## 1. Why we're doing this (analysis already done)

The trade helper's runtime dictionary is built from **two** source kinds:

1. **Client datamine** — 6 files it produces itself via `tool/extract_items.mjs`
   + `tool/extract_statdesc.mjs` (+ `tool/engine.mjs`): `data/item_bases.json`,
   `item_classes.json`, `skill_text.json`, `stat_lines.json`, `unique_names.json`.
2. **Live trade-API join** — `tool/build_dict.py` fetches BOTH
   `www.pathofexile.com` and `poe.game.qq.com` `/api/trade2/data/*` and joins by
   language-independent id to produce `stats`, `static`, item `categories`,
   `leagues`, `filters`.

`poe2-en-cn-dict` was verified to be a **strict superset of all game-content
strings** and reproduces every datamine input better (structured `stat_lines`
with the increased/reduced split + a `trade_id_to_stat` hash crosswalk). Proof
points checked:

- `dictionary/tables/BaseItemTypes.json` (4,902) ⊇ `item_bases`
- `dictionary/tables/ItemClasses.json` (92) = `item_classes`
- `dictionary/tables/ActiveSkills.json` (862) has DisplayedName + Description ⊇ `skill_text`
- `dictionary/lookup/stat_lines.json` (15,782 blocks) + `trade_id_to_stat.json` ⊃ `stat_lines`
- `dictionary/tables/Words.json` (3,214) = `unique_names`
- `dictionary/lookup/cn_to_en.json` (87,126 keys) / `en_to_cn.json` (90,253) — a
  flat catch-all the helper never had. 11 of 13 hand-maintained result-card
  property labels resolve here directly, with the *official* client wording
  (e.g. `怪物群规模 -> Pack Size`, not the helper's guessed "Monster Pack Size").

**Conclusion:** the trade helper's entire datamine half
(`extract_items.mjs`, `extract_statdesc.mjs`, `engine.mjs`, the 6 `data/*.json`)
is redundant. `poe2-en-cn-dict` already produces all of it.

**The one thing `poe2-en-cn-dict` does NOT contain (by design):** the trade-API
**structural id → label** maps — the filter-panel section/filter/option ids, the
`static` currency ids, the item-category ids (`accessory`, `weapon.claw`), the
stat-*group* labels, and the current league list. These are properties of the
trade *website's* JSON, not the game client, so they are un-dataminable. A tiny
set of trade-*synthesized* strings also have no verbatim client source (verified
missing from `cn_to_en`: `复活次数` "Revives", `已鉴定` "Identified"; and the
CN-only `map_iiq` "Waystone IIQ" the helper already hand-labels in
`MANUAL_FILTER_TEXT`).

This is **not a blocker**: at runtime the CN site already returns those labels in
Chinese. We translate the CN label *strings* through `cn_to_en` instead of
joining the two hosts by id — which lets us drop the intl host (and its
Cloudflare pain) and the fragile position-joins entirely.

---

## 2. Target architecture

```
poe2-en-cn-dict  ──emits──▶  dictionary/consumers/trade-helper/   (client-derived maps)
                                        │
poe.game.qq.com/api/trade2/data/*  ─────┤  (CN-ONLY live fetch — for trade-structural ids)
                                        ▼
poe2cn-trade-helper/tool/build_dict.py  ──▶  dist/poe2cn-trade.user.js
```

- **No more intl host.** `www.pathofexile.com` is removed from `build_dict.py`.
- **No more helper datamine.** `extract_items.mjs`, `extract_statdesc.mjs`,
  `engine.mjs`, `tool/data/*` deleted (or left dormant, your call — prefer delete
  and note it in README).
- The userscript's injected `DICT` **keeps its current shape** so the userscript
  logic barely changes. Only where each map comes from changes.

---

## 3. PHASE A — add the consumer export to `poe2-en-cn-dict`

Add an emitter (extend the existing Python build; see `poe2dict/` and `build.py`)
that writes `dictionary/consumers/trade-helper/` from data ALREADY in the repo.
All of this is reshaping existing `lookup/` + `tables/` output — no new datamine.

Emit these files (all UTF-8, `zh` = Simplified from WeGame, `en` = global):

1. `items.json` — `{ zh: en }` base-item display names. Source:
   `tables/BaseItemTypes.json` → `entries[].columns.Name[0]`. First zh wins on
   collision.
2. `item_classes.json` — `{ zh: en }`. Source: `tables/ItemClasses.json` Name col.
3. `skills.json` — `{ "names": { zh: en }, "desc": { zh: en } }`. Source:
   `tables/ActiveSkills.json` DisplayedName + Description. **Strip PoE rich-text
   markup** on desc (`[Key|Display]`→`Display`, `[Display]`→`Display`) so it
   matches the helper's `strip_tags`; skip pairs where zh==en.
4. `uniques.json` — `{ zh: en }`. Source: `tables/Words.json` Text2 col. (Note:
   `Words` also contains magic-affix words, not only uniques — that is fine and
   matches the helper's current behavior, which also fed all of `Words.Text2`.)
5. `stat_lines.json` — pass through the existing `lookup/stat_lines.json`
   (structured blocks with `stat_ids`, `stat_hash`, `forms[].{en,zh,value_range}`).
   ALSO emit two derived helpers so the consumer doesn't re-parse:
   - `stat_by_hash.json` — `{ stat_hash: { "en": <first en form>, "zh": <first zh form> } }`
     using the templates with GGG `{0}` placeholders normalized to trade-style `#`.
   - keep `trade_id_to_stat.json` reachable (copy or reference).
6. `cn_to_en.json` and `en_to_cn.json` — pass through the existing flat lookups
   (the consumer uses these to translate live CN trade labels + to build the
   `revSeed` en→zh map).
7. `meta.json` — `{ generatedAt, schemaVersion, counts: {...} }` for the report.

Add a short `dictionary/consumers/trade-helper/README.md` documenting the shape
and the join (hash = the number in a GGG trade id `explicit.stat_<hash>`; the
prefix is mod-context and not part of the hash — same rule as the repo's main
README §"Joining by GGG trade id").

**Verify Phase A** before moving on:
- Counts sane: items ≳ 4,000; skills.names ≳ 800; uniques ≳ 3,000;
  stat_by_hash ≈ 15,000.
- Spot-check the 13 property labels from §1 resolve via `cn_to_en`.
- Round-trip a known mod: `explicit.stat_2513318031` → hash → `stat_by_hash` →
  Chinese template contains `每个镶嵌的插槽使属性`.

---

## 4. PHASE B — rewire `poe2cn-trade-helper/tool/build_dict.py`

Keep the emitted userscript IDENTICAL in shape. The injected runtime `DICT` today
has exactly these keys (from `build_runtime_dict`) — preserve every one:

```
stats, statsByZh, statGroups, static, items, itemCategories, itemClasses,
leagues, filterGroups, filters, filterOptions, filterOptionsByZh,
skillNames, skillDesc, statLines, uniques, revSeed
```

New sourcing per key:

| DICT key | New source |
|---|---|
| `items` | `consumers/trade-helper/items.json` (zh→en) |
| `itemClasses` | `consumers/.../item_classes.json` |
| `skillNames`, `skillDesc` | `consumers/.../skills.json` |
| `uniques` | `consumers/.../uniques.json` |
| `statLines` | flatten `consumers/.../stat_lines.json` `forms` → `[[zh,en], …]` (helper expects `[[zh,en]]` templates) |
| `statsByZh` | from `stat_lines` forms: normalized-zh-template → `stat_hash` |
| `stats` | from `stat_by_hash.json`: `stat_hash` → en (**see keying note below**) |
| `statGroups`, `static`, `itemCategories`, `filterGroups`, `filters`, `filterOptions`, `leagues` | **CN-only live fetch** of `poe.game.qq.com/api/trade2/data/{stats,static,items,filters,leagues}`, then translate each CN label string via `cn_to_en.json`; keep the trade-id → en shape the userscript already expects |
| `filterOptionsByZh` | subset of `cn_to_en` (already zh→en) |
| `revSeed` | derive en→zh from the translated structural labels via `en_to_cn.json` |

**Keying note for `stats`:** today `DICT.stats` is keyed by the trade id WITHOUT
the `stat.` prefix (e.g. `explicit.stat_123`), and result mods carry
`hash = "stat.<section>.stat_<n>"` which the userscript strips to match. Since
`poe2-en-cn-dict` is keyed by bare hash, either (a) in `build_dict.py` expand
`stat_by_hash` across the prefixes present in the live CN `data/stats` response
(cleanest — you're fetching it anyway), or (b) change the userscript to strip the
mod hash down to the bare number and key `DICT.stats` by hash. Prefer (a) to keep
the userscript untouched; document whichever you pick.

**Manual overrides:** keep a `MANUAL_*` map for the trade-synthesized strings with
no client source: `map_iiq`→"Waystone IIQ", `复活次数`→"Revives",
`已鉴定`→"Identified". Merge these AFTER the `cn_to_en` pass so they win.

**Delete / stop calling:** the intl host, `extract_items.mjs`,
`extract_statdesc.mjs`, `engine.mjs`, `tool/data/*`, and every position-join
(`join_leagues` count-guard, item position logic). Update `tool/refresh.ps1` to
(1) build/refresh `poe2-en-cn-dict`, (2) run `build_dict.py`. Update `README.md`
data-sources + rebuild sections.

**Verify Phase B (must actually drive the site, not just diff JSON):**
- Rebuild, then load `dist/poe2cn-trade.user.js` and confirm the injected `DICT`
  has all 18 keys non-empty and counts within ~5% of the last committed build.
- Preferred: with a Playwright/Chrome session (see `SESSION-HANDOFF.md` §8),
  load the userscript over `poe.game.qq.com/trade2`, confirm: stat-filter dropdown
  English, a search result's base type + unique name + mods English, a Waystone
  result's property labels (Item Rarity / Pack Size / Corrupted / …), and a gem
  tooltip's skill stat lines. Tilde-peek reverts to Chinese.
- Confirm a `/search` still succeeds (the outgoing English→Chinese
  `rewriteSearchBody` reverse-map must still resolve — it now seeds from the new
  `items`/`uniques` maps).

---

## 5. Open decisions to confirm with the user before/while executing

1. **Delete vs. keep-dormant** the helper's datamine scripts. (Recommend delete;
   they're in git history.)
2. Whether `poe2-en-cn-dict` should also snapshot the CN trade endpoints itself
   (so the trade helper needs zero live fetch) — a bigger scope. Current plan
   keeps a thin CN-only fetch in the helper. Confirm before expanding.
3. Stat `stats` keying: option (a) expand-across-prefixes vs (b) userscript change.

Land Phase A first (self-contained, testable in isolation) before Phase B.
```
