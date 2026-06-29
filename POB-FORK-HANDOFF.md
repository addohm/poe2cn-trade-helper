# Handoff — Path of Building (PoE2) 国服 item-paste translation

> For a **new** Claude Code project: fork Path of Building Community and add
> automatic translation of items **copy/pasted from the 国服 (Simplified-Chinese)
> PoE2 client**, so PoB can parse them. Reuses the datamine + en↔zh tables already
> built in **`poe2cn-trade-helper`** (`github.com/addohm/poe2cn-trade-helper`).
> Read that repo's `SESSION-HANDOFF.md` for the datamine toolchain + every gotcha.

---

## Setup — where this runs (read first)

This file lives in `poe2cn-trade-helper`, but the **workspace is your PoB fork**:

1. **Fork the PoE2 PoB** on GitHub — the **PoE2** variant, *not* the PoE1
   `PathOfBuildingCommunity/PathOfBuilding`. Clone **your fork**.
2. **Copy the datamine toolchain into the fork** so it's self-contained. From
   `poe2cn-trade-helper/tool/`: `engine.mjs`, `extract_items.mjs`, `extract_statdesc.mjs`,
   `package.json` → `<fork>/tools/cn-translate/`. Drop **this file** in at the fork root.
   (`npm install` in that folder pulls `pathofexile-dat`.)
3. Start a new Claude Code session **with the fork as the working directory**; first
   instruction: "Read POB-FORK-HANDOFF.md".

**Two-machine reality (same as the userscript project):** the **datamine needs the WeGame
国服 client + WSL node**, so generate the translation tables on the **Windows machine with
the client**, then **commit the generated Lua tables into the fork**. PoB itself (and the
Lua hook dev) runs anywhere — that machine just consumes the committed tables. Character
import from a 国服 *account* is out of scope (different auth/API on poe.game.qq.com); the
workable path is **manual item paste**.

---

## Scope — item-paste translation vs "completely Chinese" PoB

Two very different efforts hide under "make PoB Chinese":

- **(A) Translate GAME DATA** (item bases, mods/stat lines, skills, uniques, passive-tree
  stats, gems). **This is what we have.** The en↔zh tables are **bidirectional** (en + zh per
  metadata `Id`), so the *same* tables serve **input** (zh→en — item paste) *and* **display**
  (en→zh — showing game content in Chinese). Gaps: the `Mods` table (affixes), passive-tree
  node *names*, and composed/templated strings (handle like §4).
- **(B) Localize PoB's OWN UI** (buttons, menus, panel labels, calc output, tooltips, help).
  **None are in our datamine** — they're PoB author strings, and PoB has **no i18n framework**
  (English is hardcoded throughout). A large, *separate* localization project (externalize
  strings + a zh file + a render hook), best coordinated with the PoB community; every upstream
  update adds strings to track.

**Recommendation — phase it; lead with the input layer:**
- **Phase 1 (highest ROI): item-paste translation (zh→en).** Unlocks PoB for 国服 players —
  import gear; the English UI is learnable/tolerable (many do this today). ~70% of the data
  exists here already.
- **Phase 2: game-data DISPLAY in Chinese (en→zh)** via the same bidirectional tables + a
  render hook for composed strings. Big, but leveraged by existing data.
- **Phase 3: PoB UI localization (B).** Largest piece, least helped by our data — a distinct
  sub-project (or a community PoB-i18n effort). A 国服 player is productive after Phase 1, so
  **don't gate accessibility on Phase 3.**

The phase list in §10 below is the *item-paste* breakdown (Phase 1); Phases 2–3 above are the
longer roadmap toward "completely Chinese."

---

## 0. Goal & why it's tractable

PoB can't parse 国服 items because the pasted text is Simplified Chinese and PoB
matches against **English** base/mod/gem names. The 国服 client is a **mirror** of
the international one — every base, mod, skill, and unique has a language-independent
metadata `Id`, so we already have **exact one-to-one en↔zh** tables. The job: detect
a Chinese item paste, **translate it line-by-line to the English item-paste text PoB
expects**, then hand it to PoB's existing parser. No PoB parser changes needed beyond
a small pre-translate hook.

**Crucial difference from the trade helper:** that project translated the *trade
API's* pre-rendered JSON. PoB parses the **in-game Ctrl+C item format**, which is
different — fixed property labels, mod lines with **rolled values + `(min-max)`
ranges**, and optional **affix annotations** (`{ 前缀属性 "name" (等阶：4) — tags }`).
We translate that text format, not JSON.

---

## 1. The item-paste format (annotated, from a real 国服 item)

```
物品类别: 权杖                     → Item Class: Sceptres          [label + class value]
稀有度: 稀有                       → Rarity: Rare                  [label + rarity value]
复仇 巨锤                          → (rare name — cosmetic; PoB ignores for rares)
圣地权杖                           → Shrine Sceptre                [BASE TYPE]
--------
品质: +20% (augmented)            → Quality: +20% (augmented)     [label; keep value/flag]
精魂: 177 (augmented)             → Spirit: 177 (augmented)       [PoE2-specific property]
--------
需求： 等级 84, 45 力量, 114 智慧   → Requires: Level 84, 45 Str, 114 Int
--------
插槽: S                           → Sockets: S
--------
物品等级: 84                       → Item Level: 84
--------
该装备精魂提高 15% (rune)          → 15% increased Spirit (rune)    [MOD + state flag]
--------
获得技能: 等级 19 冰霜净化          → Grants Skill: Level 19 Purity of Ice   [label + "Level N" + SKILL]
--------
{ 前缀属性 "龙胆的" (等阶：4) — 魔力 }  → { Prefix Modifier "<en>" (Tier: 4) — Mana }  [AFFIX ANNOTATION]
+98 (90-104) 魔力上限              → +98 (90-104) to maximum Mana   [MOD with rolled value + range]
{ 前缀属性 "国王的" (等阶：1) }
该装备精魂提高 62 (61-65)%          → 62% (61-65) increased Spirit
{ 前缀属性 "韧炼的" (等阶：4) — 伤害, 物理, 攻击 }
在场的友军附加 8 (6-10) - 14 (12-17) 攻击物理伤害  → Allies in your Presence add 8 (6-10) to 14 (12-17) Attack Physical Damage
{ 后缀属性 "哲学家之" (等阶：4) — 属性 }
+21 (21-24) 智慧                  → +21 (21-24) to Intelligence
{ 后缀属性 "涅盘之" (等阶：1) — 魔力 }
魔力再生率提高 67 (60-69)%          → 67% (60-69) increased Mana Regeneration Rate
{ 后缀属性 "校长之" (等阶：3) — 生命, 召唤生物 }
召唤生物的生命上限提高 39 (36-40)%   → Minions have 39% (36-40) increased maximum Life
--------
引路石掉落                         → (flag line — "drops Waystone"; PoB-irrelevant, pass through/strip)
```

Sections are separated by `--------`. `需求：` uses a **fullwidth colon**. Numbers can
be `+98`, decimals, and **`(min-max)` ranges** appear after the rolled value (advanced
mod display). Some lines have **two** number+range groups (`8 (6-10) - 14 (12-17)`).

---

## 2. What must be translated (priority-ordered)

**Tier 1 — required for PoB to parse a working item:**
- **Fixed labels / keywords** (small hand-map, or datamine `ClientStrings`): `物品类别`→
  Item Class, `稀有度`→Rarity, `品质`→Quality, `精魂`→Spirit, `需求`→Requires, `等级`→Level,
  `力量/敏捷/智慧`→Strength/Dexterity/Intelligence (PoB wants full words in Requires),
  `插槽`→Sockets, `物品等级`→Item Level, `获得技能`→Grants Skill, plus state flags
  `(augmented)`/`(rune)`/`(crafted)`/腐化→Corrupted/已鉴定/未鉴定→Identified/Unidentified.
- **Rarity value**: `普通`→Normal, `魔法`→Magic, `稀有`→Rare, `传奇/独特`→Unique.
- **Item class value**: `权杖`→`Sceptres` — from `ItemClasses` datamine, then **mapped to
  PoB's exact class string** (PoB's `Data/` class names; may differ — validate).
- **Base type**: `圣地权杖`→`Shrine Sceptre` — `BaseItemTypes` datamine. **COVERED.**
- **Unique name** (if Rarity = Unique): `Words.Text2` datamine. **COVERED.**
- **Mod lines** (implicit/explicit/rune/enchant): `StatDescriptions` templates. **Data
  exists**; the work is the *matching* (ranges/whitespace/value) — see §4.
- **Granted skill**: `获得技能: 等级 N <skill>` → `Grants Skill: Level N <en skill>`.
  Skill name from `ActiveSkills`. **COVERED** (`冰霜净化`→`Purity of Ice`).

**Tier 2 — nice-to-have (crafting/affix view; PoB parses mods without it):**
- **Affix annotations** `{ 前缀属性 "name" (等阶：4) — tags }` → `{ Prefix Modifier "<en>"
  (Tier: 4) — <en tags> }`. Keywords map easily (`前缀属性`→Prefix Modifier, `后缀属性`→
  Suffix Modifier, `等阶`→Tier). **The affix NAMES (`龙胆的`,`国王的`,…) are NOT in any
  current table → need the `Mods` table datamine** (see §5). The **tags** (`魔力`→Mana,
  `物理`→Physical, `攻击`→Attack, `属性`→Attribute, `生命`→Life, `召唤生物`→Minion) need a
  small tag map (or the `Tags`/`StatSemantics` table).
- **Rare item name** (`复仇 巨锤`): cosmetic; leave, strip, or transliterate.

Probe results against the example (current `poe2cn-trade-helper` data):
`圣地权杖→Shrine Sceptre ✓`, `权杖→Sceptres ✓`, `冰霜净化→Purity of Ice ✓`,
mod templates present in `stat_lines.json` ✓ (matching needs §4), affix names ✗ (§5).

---

## 3. Data sources (reuse + what's new)

**Reuse from `poe2cn-trade-helper/tool/`** (the datamine is self-contained: `engine.mjs`
+ `npm install` + WSL node; auto-detects the WeGame client):
- `extract_items.mjs` → `BaseItemTypes` (bases), `ItemClasses`, `ActiveSkills` (skills),
  `Words.Text2` (uniques + display names). Re-run as-is.
- `extract_statdesc.mjs` → `StatDescriptions` → `stat_lines.json` (zh-template→en-template
  with `{N}` placeholders). **CHANGE: drop the trade-relevant KEEP filter** — for items you
  want the *full* StatDescriptions set (it currently keeps gem/skill/mod/general; verify all
  item-mod files are included).

**New datamine needed (Tier 2 / completeness):**
- **`Mods` table** — affix display `Name` (`龙胆的`→ the English prefix/suffix name),
  `GenerationType` (prefix/suffix), `Domain`, tier, and the linked stat lines. EN + SC by
  metadata `Id`. This is the meaty new piece (affix annotations + better mod disambiguation).
- **Tags / stat tags** — for the `— Mana, Physical` annotation tags. Likely a small fixed
  map suffices; or datamine `Tags`/`StatSemantics`.
- **`ClientStrings`** (optional) — the in-game UI label strings (`Item Class`, `Requires`,
  `Sockets`, `Quality`, `Item Level`, `Grants Skill`, `Prefix/Suffix Modifier`, `Tier`,
  rarity words) to translate labels *exactly* instead of hand-mapping. A `lang`-section
  `.csd`-style or a dat table — find it; hand-mapping ~25 labels also works for MVP.

Emit the tables as **Lua data files** (PoB is Lua) — e.g. `data['zh'] = { bases={...},
classes={...}, mods={...}, stats={ {zhpat, enpat}, ... }, skills={...}, labels={...} }`.
Keep generation in the Node toolchain; commit the generated Lua into the PoB fork.

---

## 4. The central challenge — translating mod lines (StatDescriptions matching)

The `stat_lines.json` map (zh-template → en-template, `{N}` placeholders) already exists,
but the **paste format differs from clean rendered strings**:

1. **Range annotations**: `魔力再生率提高 67 (60-69)%`. Strip the ` (min-max)` group(s)
   FIRST (regex `\s*\([^)]*\)`), THEN normalize the remaining rolled numbers to `#`, THEN
   look up. (My quick probe failed *only* because sloppy stripping left a stray space:
   `"...提高 67 %"` ≠ template `"...提高 #%"`. Strip the whole ` (..)` incl. surrounding
   space and collapse whitespace.)
2. **Reconstruct** the English line with the rolled value + range in PoB's format. PoB
   accepts both the plain form (`67% increased Mana Regeneration Rate`) and advanced ranges.
   Easiest robust MVP: emit the plain rolled value (drop ranges); add ranges later if PoB's
   crafting view needs them. Map each captured number back into the en template's `{N}` by
   index (word order differs between zh/en — same approach as the trade helper's `fillNums`).
3. **Two-group mods**: `8 (6-10) - 14 (12-17)` → two `{N}` slots → `8 to 14`.
4. **Disambiguation**: `stat_lines` has many near-duplicates (esp. support-gem variants
   `被辅助技能…`). Item mods are the *non-support* templates. The `{ 前缀属性 … }` annotation
   above each mod, and/or the `Mods` table, disambiguates; for MVP, prefer the shortest/most
   literal template match and validate.
5. **`该装备精魂提高 X%`** (Spirit) and other PoE2-only mods are present — confirm coverage.
6. **Implicit vs explicit**: PoB cares which mods are implicit. In the paste, the implicit
   block is the section *before* the explicit mods (separated by `--------`); preserve order
   and section boundaries when rebuilding.

Validate by translating real 国服 items and feeding them to PoB; iterate on misses.

---

## 5. Affix names (`Mods` table) — Tier 2

The `{ 前缀属性 "龙胆的" (等阶：4) — 魔力 }` names are NOT in bases/uniques/skills/stats.
They live in the **`Mods` table** (`Name` column, EN + SC overlay, joined on `Id`). Extend
`extract_items.mjs` with the `Mods` table (and its tier/gen-type/tags). This also enables
robust mod disambiguation (each affix `Id` links to specific stat lines). Treat as Phase 3
— PoB parses a working item from the stat lines alone without it.

---

## 6. Architecture

```
[WeGame 国服 client]
   │  (reuse poe2cn-trade-helper datamine: engine.mjs + extract_*.mjs, WSL node)
   ▼
[en↔zh tables] --emit--> [Lua data files in the PoB fork]
                                   │
[国服 item paste] ──► ChineseItemTranslator.lua ──► [English item text] ──► PoB's ParseItemRaw
   (detect CJK)        (line-by-line translate)
```

- **Translation module** (`ChineseItemTranslator.lua`, new): split the paste into sections/
  lines; translate labels, class, rarity, base, unique name, mod lines (StatDescriptions),
  granted skills, flags; pass through numbers/ranges/sockets/separators. Output English text.
- **Hook**: detect CJK in the pasted/imported item text and run the translator **before**
  PoB's parser. Find PoB's item-paste entry point (see §7). Keep the change a *thin* hook so
  the fork stays rebaseable on upstream.
- **Toggle/UX**: auto-detect is ideal; optionally a settings toggle "Translate 国服 items".

---

## 7. PoB codebase pointers (verify on the actual repo)

- **Target the PoE2 build of PoB**, not PoE1 — this is a PoE2 item. The community PoE2 PoB
  is a separate repo/branch (search `PathOfBuildingCommunity` orgs for the PoE2 one;
  historically `PathOfBuilding-PoE2`). The PoE1 repo is `PathOfBuildingCommunity/PathOfBuilding`.
- **Item parser**: `src/Modules/Item.lua` (look for `ParseItemRaw` / `function ... ParseItemRaw`).
  The pasted text arrives via the item import/edit control; that's the hook point.
- **Data**: `src/Data/` (bases, mods, gems, uniques) — English; PoB matches pasted strings
  against these. Your translation must produce strings that match these exactly.
- PoB runs on the **SimpleGraphic** Lua runtime; data is Lua. There's a headless test harness
  (`HeadlessWrapper.lua`) useful for automated parse tests.

---

## 8. Validation strategy

- **Parallel items**: paste the same item from the English client (if available) and diff
  against the translation. Lacking an English client, PoB's parser **is** the spec — round-trip:
  translate a 国服 item → PoB parses it → confirm correct base/class/mods/requirements.
- **Headless tests**: feed translated text to PoB's headless harness; assert the parsed Item
  has expected modList/baseName.
- **Coverage probe** (like the trade helper's `sim_*.py`): run the translator over many real
  国服 pastes, log untranslated lines, fix.
- Keep a corpus of real 国服 pastes (the user can supply) as regression fixtures.

---

## 9. Known unknowns / gotchas (carried from poe2cn-trade-helper — read its SESSION-HANDOFF.md)

- **国服 Simplified strings exist ONLY in the WeGame client** (global Steam client has no SC
  overlay; poe2db is global/Traditional). Datamine source = WeGame client. **Required.**
- Datamine runs on **WSL node** with vendored `pathofexile-dat`; auto-detects the WeGame path
  (`/mnt/<drive>/WeGameApps/rail_apps/Path of  Exile 2(...)` — double space). `engine.mjs` has
  `extractTable(get,schema,name,langDir,columns)` + `findGuofuInstall` ready to reuse.
- **WSL can't reach pathofexile.com** (proxy fake-IP) — irrelevant here (PoB items are local,
  no trade API needed), but the datamine gotchas (schema cache, Oodle via pathofexile-dat) apply.
- **PowerShell scripts must be ASCII-only**; the Bash tool mangles `wsl /mnt/c` paths (use the
  PowerShell tool or `wsl bash -lc`).
- **国服 content lag**: the 国服 client may have mods/bases the English data lacks (or vice
  versa). For *parsing*, you translate to English text and PoB needs matching English data —
  if PoE2-PoB's data is behind/ahead of 国服, some mods won't resolve. Track misses.
- **StatDescriptions** quirks: `[Key|Display]` markup (strip to display), `{N}` placeholders,
  numbers→`#` normalize + regex-confirm matching, many support-gem near-duplicates.
- **PoE2-specific** lines: `精魂`/Spirit, `引路石`/Waystone, runes, `（遗产）`/Legacy variants.

### The "Reaver Catalyst / Vilenta's Propulsion" availability finding (verified here)
Determined by 3 cross-checks (datamined client `BaseItemTypes`; intl-vs-国服 *client* diff on
metadata `Id`; intl-vs-国服 *trade* `data/items`): **Reaver Catalyst exists on 国服**
(`袭击催化剂`), **Vilenta's Propulsion / Vile Greataxe exist in the 国服 client but not its
trade endpoint** (client-ahead-of-trade lag), and **Necrotic Catalyst is in the international
client but not the 国服 client**. Relevance to PoB: 国服-only or version-skewed items may not
have matching English PoB data — expect occasional unresolved bases/mods until PoE2-PoB and
国服 are on the same patch.

---

## 10. Suggested phases

0. **Datamine + emit Lua tables** (reuse `engine.mjs`/`extract_*`; un-filter StatDescriptions).
1. **Tier-1 translator**: labels + rarity + class + base + properties + requirements + mod
   lines (with range/whitespace handling) → PoB parses a working item. Validate headless.
2. **Granted skills + uniques + flags** (corrupted/rune/quality/sockets).
3. **`Mods` table** → affix annotations + better mod disambiguation.
4. **Hook + UX** in the PoB fork (auto-detect on paste; optional toggle); packaging.

---

## 11. ToS / legal

PoB Community is **MIT** — forking is fine; credit upstream and keep the license. This is a
personal/community accessibility layer. Don't redistribute game assets; ship only the derived
translation tables. Not affiliated with GGG/Tencent/PoB.
