// ==UserScript==
// @name         PoE2 国服 Trade — English
// @namespace    poe2cn-trade-helper
// @version      __VERSION__
// @description  Translate the Chinese PoE2 trade site to English at the API layer (by id).
// @match        https://poe.game.qq.com/trade2*
// @match        https://poe.game.qq.com/*/trade2*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/addohm/poe2cn-trade-helper/main/tool/dist/poe2cn-trade.user.js
// @downloadURL  https://raw.githubusercontent.com/addohm/poe2cn-trade-helper/main/tool/dist/poe2cn-trade.user.js
// ==/UserScript==
// Auto-update: Tampermonkey re-pulls this from GitHub raw when build_dict.py bumps
// the @version. The build machine (with the WeGame client) runs refresh.ps1 which
// rebuilds + pushes; any browser (incl. Linux) auto-updates from the raw URL.
//
// HOW IT WORKS
// The CN trade site is a mirror of pathofexile.com: the trade engine filters on
// language-independent ids (stat ids, item-type ids, league names), only the
// DISPLAY strings differ. This script patches window.fetch and XMLHttpRequest so
// that when the SPA loads /api/trade2/data/{stats,static,items,leagues}, the
// localized strings in the JSON are swapped to English *before* the app renders
// them — keyed by id where possible. The dictionary below is built offline by
// tool/build_dict.py (joining the CN + intl data endpoints, plus client-datamined
// item base names) and injected at build time.
//
// This is a display-translation layer only: it never changes the ids the site
// sends back to the trade API, so search/fetch keep working unchanged.

(function () {
  'use strict';

  // Injected at build time by build_dict.py (slim, display-oriented zh/id -> en).
  const DICT = __DICT__;
  const DICT_VERSION = '__VERSION__';
  const META = __META__;   // {version, builtAt, counts:{...}} for the panel

  // --- user settings (localStorage, page-context, read synchronously) ---
  const SKEY = (k) => 'poe2cn:' + k;
  function getFlag(k, dflt) {
    try { const v = localStorage.getItem(SKEY(k)); return v === null ? dflt : v === '1'; }
    catch (_) { return dflt; }
  }
  function setFlag(k, v) { try { localStorage.setItem(SKEY(k), v ? '1' : '0'); } catch (_) {} }
  const SETTINGS = {
    enabled: getFlag('enabled', true),   // master on/off
    dom: getFlag('dom', true),           // DOM chrome/tooltip pass
    debug: getFlag('debug', false),      // verbose console logging
  };
  const DEBUG = SETTINGS.debug;

  // Untranslated item bases seen at runtime (coverage self-check): zh -> count.
  const CJK_RE = /[一-鿿]/;
  const ITEM_MISS = new Map();
  const noteMiss = (zh) => { if (zh && CJK_RE.test(zh)) ITEM_MISS.set(zh, (ITEM_MISS.get(zh) || 0) + 1); };

  // Item base names have no language-independent id: the localized `type` string
  // IS the value the site sends to the search API. We translate it to English for
  // display, so the OUTGOING search query must be mapped back (en -> zh) or the
  // 国服 backend rejects it ("Unknown Base Type"). ITEM_REV holds that mapping.
  const ITEM_REV = new Map();

  // Hold-to-peek: as we translate (API + DOM), record shown-English -> original
  // Chinese here so a held hotkey can swap the page back to Chinese.
  const REVERSE = new Map();
  let PEEKING = false;
  let domObserver = null;
  const OBS_OPTS = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['placeholder', 'value'],
  };

  // Seed the reverse maps from the dictionary at startup so search-reverse-mapping
  // (en item name -> zh) and peek work even when the site serves data/* from its
  // own localStorage cache (in which case our fetch/XHR hook never re-runs).
  for (const zh in DICT.items) { const en = DICT.items[zh]; if (en) { ITEM_REV.set(en, zh); REVERSE.set(en, zh); } }
  for (const zh in DICT.uniques) { const en = DICT.uniques[zh]; if (en) { ITEM_REV.set(en, zh); REVERSE.set(en, zh); } }
  for (const en in (DICT.revSeed || {})) REVERSE.set(en, DICT.revSeed[en]);

  function bustCache() {
    // The site caches data/* in localStorage (the `lscache` lib: keys
    // `lscache-trade2{stats,filters,items,data}` + `-cacheexpiration`) and reads
    // those on load, so our hook only fires on a cache miss. Drop just those keys
    // (leaving __POESESSION etc.) so the app refetches once and our hook
    // translates + re-caches the English copy.
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('lscache-trade2') === 0) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch (e) { console.warn('[poe2cn] cache clear failed', e); }
  }

  // The site usually serves data/* straight from its localStorage cache (the
  // `lscache` lib) WITHOUT refetching, so our network hook never sees it. Translate
  // those cached payloads in place at document-start, before the app reads them.
  // Idempotent: skips entries already in English (no CJK). Also repopulates the
  // reverse maps from the real cached data (bonus for search-reverse + peek).
  const CACHE_MAP = {
    'lscache-trade2stats': '/data/stats', 'lscache-trade2items': '/data/items',
    'lscache-trade2filters': '/data/filters', 'lscache-trade2data': '/data/static',
  };
  function translateCache() {
    for (const key in CACHE_MAP) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw || !CJK_RE.test(raw)) continue;       // missing or already English
        const json = JSON.parse(raw);
        if (json && json.result) {
          localStorage.setItem(key, JSON.stringify(translate(CACHE_MAP[key], json)));
          if (DEBUG) console.log('[poe2cn] translated cached', key);
        }
      } catch (_) {}
    }
  }
  if (SETTINGS.enabled) {
    try { translateCache(); } catch (e) { console.warn('[poe2cn] translateCache failed', e); }
  }

  const FETCH_RE = /\/api\/trade2\/fetch\//;          // search-result listings
  const SEARCH_RE = /\/api\/trade2\/search\//;        // POST: outgoing query
  const INTERCEPT_RE = /\/api\/trade2\/(data\/(stats|static|items|leagues|filters)|fetch\/)/;

  // Map a search request body's English item-name fields back to Chinese so the
  // 国服 backend recognises them. Only top-level query string fields (type/name/
  // term) can hold a base name; stat/filter values use ids and are left alone.
  function rewriteSearchBody(body) {
    if (typeof body !== 'string' || !ITEM_REV.size) return body;
    try {
      const obj = JSON.parse(body);
      const q = obj && obj.query;
      let changed = false;
      if (q && typeof q === 'object') {
        for (const key of Object.keys(q)) {
          const v = q[key];
          if (typeof v === 'string' && ITEM_REV.has(v)) { q[key] = ITEM_REV.get(v); changed = true; }
          else if (v && typeof v === 'object' && typeof v.option === 'string'
                   && ITEM_REV.has(v.option)) { v.option = ITEM_REV.get(v.option); changed = true; }
        }
      }
      if (DEBUG && changed) console.log('[poe2cn] reverse-mapped search query item name -> zh');
      return JSON.stringify(obj);
    } catch (_) { return body; }
  }

  function pathnameOf(url) {
    try { return new URL(url, location.origin).pathname; }
    catch (_) { return String(url || ''); }
  }

  // Fill an English template's `#` placeholders with the numbers (in order) found
  // in the rendered source string. Word order / range separators differ between
  // zh and en, but the numeric order is the same, so this stays correct.
  function fillNums(enTemplate, rendered) {
    const nums = String(rendered).match(/-?\d+(?:\.\d+)?/g) || [];
    let i = 0;
    return enTemplate.replace(/#/g, () => (i < nums.length ? nums[i++] : '#'));
  }

  // Translate one rendered mod line: prefer the stat id (from the result's
  // extended.hashes); else reverse-match by normalizing its numbers to `#`.
  function translateMod(rendered, statId) {
    if (statId && DICT.stats[statId]) return fillNums(DICT.stats[statId], rendered);
    const norm = String(rendered).replace(/-?\d+(?:\.\d+)?/g, '#');
    const id = DICT.statsByZh[norm];
    if (id && DICT.stats[id]) return fillNums(DICT.stats[id], rendered);
    return rendered;
  }

  // --- full StatDescriptions matcher (gem/skill stat lines, mods) ---
  // DICT.statLines is [[zhTemplate, enTemplate], ...] with {N} placeholders.
  // Build a Map keyed by the fully-normalized zh (placeholders + literal numbers
  // -> '#') lazily on first use; confirm each candidate with a regex so literal
  // numbers in the template must match, then transplant the rolled values.
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numRun = /[+-]?\d[\d.,]*/g;
  const normNums = (s) => s.replace(numRun, '#');
  let STATLINES = null;
  function statMap() {
    if (STATLINES) return STATLINES;
    STATLINES = new Map();
    for (const pair of (DICT.statLines || [])) {
      const key = pair[0].replace(/\{\d+\}/g, '#').replace(numRun, '#');
      let a = STATLINES.get(key);
      if (!a) { a = []; STATLINES.set(key, a); }
      a.push(pair);
    }
    return STATLINES;
  }
  const _statReCache = new Map();
  function statRe(zh) {
    let c = _statReCache.get(zh);
    if (c) return c;
    let re = '', last = 0; const order = []; const rx = /\{(\d+)\}/g; let m;
    while ((m = rx.exec(zh))) {
      re += reEsc(zh.slice(last, m.index)) + '([+-]?\\d[\\d.,]*)';
      order.push(+m[1]); last = m.index + m[0].length;
    }
    re += reEsc(zh.slice(last));
    c = { re: new RegExp('^' + re + '$'), order };
    _statReCache.set(zh, c);
    return c;
  }
  function translateStatLine(rendered) {
    const cands = statMap().get(normNums(rendered));
    if (!cands) return null;
    for (const [zh, en] of cands) {
      const { re, order } = statRe(zh);
      const m = rendered.match(re);
      if (m) {
        const val = {};
        for (let q = 0; q < order.length; q++) val[order[q]] = m[q + 1];
        return en.replace(/\{(\d+)\}/g, (_, n) => (n in val ? val[n] : '{' + n + '}'));
      }
    }
    return null;
  }

  const MOD_SECTIONS = ['enchant', 'implicit', 'explicit', 'fractured',
    'crafted', 'rune', 'scourge', 'desecrated'];

  // Translate a /fetch result payload: item base types + affix mod lines.
  function translateFetch(json) {
    let n = 0;
    if (!json || !Array.isArray(json.result)) return json;
    for (const r of json.result) {
      const it = r && r.item;
      if (!it) continue;
      // Capture the original (Chinese) base before we translate it, so we can
      // also swap it inside the displayed name. Magic items show typeLine =
      // "<prefix> <base> <suffix>" (one line), which never exact-matches; rare
      // items show a separate baseType line that does.
      const zhBase = (it.baseType && DICT.items[it.baseType]) ? it.baseType : null;
      const enBase = zhBase ? DICT.items[zhBase] : null;
      if (zhBase) { REVERSE.set(enBase, zhBase); it.baseType = enBase; n++; }
      for (const f of ['typeLine', 'name']) {
        const orig = it[f];
        if (!orig) continue;
        if (DICT.items[orig]) {                       // whole field is a base
          REVERSE.set(DICT.items[orig], orig); it[f] = DICT.items[orig]; n++;
        } else if (DICT.uniques[orig]) {              // whole field is a unique/item name
          REVERSE.set(DICT.uniques[orig], orig); it[f] = DICT.uniques[orig]; n++;
        } else if (zhBase && orig.indexOf(zhBase) >= 0) {  // base embedded in a magic name
          const t = orig.split(zhBase).join(enBase);
          REVERSE.set(t, orig); it[f] = t; n++;
        }
      }
      // magic/rare names: translate the remaining affix (prefix/suffix) words
      // around the (now-English) base, token by token, from the dictionary export.
      if (DICT.affixes) {
        for (const f of ['typeLine', 'name']) {
          const orig = it[f];
          if (typeof orig !== 'string' || !CJK_RE.test(orig)) continue;
          const t = orig.replace(/\S+/g, (tok) => DICT.affixes[tok] || tok);
          if (t !== orig) { REVERSE.set(t, orig); it[f] = t; n++; }
        }
      }
      if (it.baseType && CJK_RE.test(it.baseType)) noteMiss(it.baseType);  // base not in dict
      const hashes = (it.extended && it.extended.hashes) || {};
      for (const sec of MOD_SECTIONS) {
        const mods = it[sec + 'Mods'];
        if (!Array.isArray(mods)) continue;
        const h = hashes[sec];
        for (let i = 0; i < mods.length; i++) {
          const id = (Array.isArray(h) && h[i]) ? h[i][0] : null;
          const orig = mods[i];
          // Mod entries are normally rendered strings. If a payload uses
          // structured objects, translate the string field in place and leave
          // the object otherwise intact (don't stringify it into the UI).
          if (typeof orig === 'string') {
            const t = translateMod(orig, id);
            if (t !== orig) { REVERSE.set(t, orig); mods[i] = t; n++; }
          } else if (orig && typeof orig === 'object') {
            // structured mod, e.g. {description:'+87 生命上限', hash:'stat.explicit.stat_3299347043'}
            const sid = orig.hash ? String(orig.hash).replace(/^stat\./, '') : id;
            for (const key of ['description', 'text', 'name', 'string', 'value']) {
              if (typeof orig[key] === 'string') {
                const t = translateMod(orig[key], sid);
                if (t !== orig[key]) { REVERSE.set(t, orig[key]); orig[key] = t; n++; }
                break;
              }
            }
          }
        }
      }
      // property / requirement / flag labels (符文结界, 结界, 物品稀有度, 已腐化, ...)
      // from the legacy CHROME map or the dictionary export's uiTerms (preferred).
      for (const arr of [it.properties, it.additionalProperties, it.requirements]) {
        if (!Array.isArray(arr)) continue;
        for (const p of arr) {
          if (!p || typeof p.name !== 'string') continue;
          const en = CHROME[p.name] || (DICT.uiTerms && DICT.uiTerms[p.name]);
          if (en) { REVERSE.set(en, p.name); p.name = en; n++; }
        }
      }
    }
    if (DEBUG) console.log('[poe2cn] translated fetch →', n, 'changes');
    return json;
  }

  function translateResponse(pathname, json) {
    return FETCH_RE.test(pathname) ? translateFetch(json) : translate(pathname, json);
  }

  // ---- per-endpoint translators (mutate + return the parsed JSON) ----
  function translate(pathname, json) {
    if (!json || !json.result) return json;
    let n = 0;
    try {
      if (pathname.endsWith('/data/stats')) {
        for (const g of json.result) {
          const gl = DICT.statGroups[g.id]; if (gl) { REVERSE.set(gl, g.label); g.label = gl; }
          for (const e of g.entries || []) {
            const t = DICT.stats[e.id]; if (t) { REVERSE.set(t, e.text); e.text = t; n++; }
          }
        }
      } else if (pathname.endsWith('/data/static')) {
        for (const g of json.result) {
          for (const e of g.entries || []) {
            const t = DICT.static[e.id]; if (t) { REVERSE.set(t, e.text); e.text = t; n++; }
          }
        }
      } else if (pathname.endsWith('/data/items')) {
        for (const g of json.result) {
          const gl = DICT.itemCategories[g.id]; if (gl) { REVERSE.set(gl, g.label); g.label = gl; }
          for (const e of g.entries || []) {
            const zhType = e.type, zhName = e.name;
            const enType = zhType && DICT.items[zhType];
            if (enType) {
              ITEM_REV.set(enType, zhType);   // en -> zh, for the outgoing query
              REVERSE.set(enType, zhType); e.type = enType; n++;
            } else noteMiss(zhType);          // searchable item type not in dict
            // uniques have a `name` (the unique name) + base `type`
            const enName = zhName && DICT.uniques[zhName];
            if (enName) { ITEM_REV.set(enName, zhName); REVERSE.set(enName, zhName); e.name = enName; n++; }
            // `text` is the combined "name base" the autocomplete matches/displays;
            // rebuild it from the translated parts (for uniques especially).
            if (e.text) {
              const orig = e.text; let txt = orig;
              if (zhName && enName) txt = txt.split(zhName).join(enName);
              if (zhType && enType) txt = txt.split(zhType).join(enType);
              if (txt !== orig) { ITEM_REV.set(txt, orig); REVERSE.set(txt, orig); e.text = txt; n++; }
            }
          }
        }
      } else if (pathname.endsWith('/data/leagues')) {
        for (const e of json.result) {
          const t = DICT.leagues[e.text]; if (t) { REVERSE.set(t, e.text); e.text = t; n++; }
          // NB: leave e.id alone — the site sends it back to the search API.
        }
      } else if (pathname.endsWith('/data/filters')) {
        for (const g of json.result) {
          const gt = DICT.filterGroups[g.id]; if (gt) { REVERSE.set(gt, g.title); g.title = gt; n++; }
          for (const f of g.filters || []) {
            const ft = DICT.filters[f.id]; if (ft) { REVERSE.set(ft, f.text); f.text = ft; n++; }
            const opts = f.option && f.option.options;
            if (opts) for (const o of opts) {
              let t = (o.id != null) ? DICT.filterOptions[f.id + '::' + o.id] : null;
              if (!t && o.text) t = DICT.filterOptionsByZh[o.text];
              if (t) { REVERSE.set(t, o.text); o.text = t; n++; }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[poe2cn] translate error', pathname, err);
    }
    if (DEBUG) console.log('[poe2cn] translated', pathname, '→', n, 'entries');
    return json;
  }

  // ---- patch fetch ----
  const origFetch = window.fetch;
  if (SETTINGS.enabled && origFetch) {
    window.fetch = async function (input, init) {
      const url = (typeof input === 'string') ? input
        : (input && input.url) ? input.url : '';
      // Rewrite the outgoing search query (English item name -> Chinese).
      if (SEARCH_RE.test(url) && init && typeof init.body === 'string') {
        const nb = rewriteSearchBody(init.body);
        if (nb !== init.body) { init = Object.assign({}, init, { body: nb }); arguments[1] = init; }
      }
      const resp = await origFetch.apply(this, arguments);
      if (!INTERCEPT_RE.test(url)) return resp;
      if (DEBUG) console.log('[poe2cn] fetch intercepted', url);
      try {
        const json = await resp.clone().json();
        const body = JSON.stringify(translateResponse(pathnameOf(url), json));
        return new Response(body, {
          status: resp.status, statusText: resp.statusText, headers: resp.headers,
        });
      } catch (err) {
        console.warn('[poe2cn] fetch wrap error', url, err);
        return resp;
      }
    };
  }

  // ---- patch XMLHttpRequest (jQuery/axios use XHR) ----
  // Lazy getters sidestep listener-ordering: we translate the ORIGINAL value the
  // first time the site reads responseText/response, after the request completes.
  if (SETTINGS.enabled) {
  const proto = XMLHttpRequest.prototype;
  const rtDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const rDesc = Object.getOwnPropertyDescriptor(proto, 'response');
  const origOpen = proto.open;
  const origSend = proto.send;

  proto.open = function (method, url) {
    this.__poeUrl = url;
    this.__poeHit = INTERCEPT_RE.test(url || '');
    this.__poeSearch = SEARCH_RE.test(url || '');
    return origOpen.apply(this, arguments);
  };

  proto.send = function (body) {
    // Rewrite the outgoing search query (English item name -> Chinese).
    if (this.__poeSearch && typeof body === 'string') {
      const nb = rewriteSearchBody(body);
      if (nb !== body) arguments[0] = nb;
    }
    if (this.__poeHit) {
      const xhr = this;
      if (DEBUG) console.log('[poe2cn] xhr intercepted', this.__poeUrl);
      let cache = null, computed = false;
      const computeText = (raw) => {
        if (computed) return cache;
        computed = true;
        try { cache = JSON.stringify(translateResponse(pathnameOf(xhr.__poeUrl), JSON.parse(raw))); }
        catch (_) { cache = raw; }
        return cache;
      };
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get() {
          const raw = rtDesc.get.call(xhr);
          return xhr.readyState === 4 ? computeText(raw) : raw;
        },
      });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get() {
          const rt = xhr.responseType;
          if (rt === '' || rt === 'text') {
            const raw = rtDesc.get.call(xhr);
            return xhr.readyState === 4 ? computeText(raw) : raw;
          }
          if (rt === 'json') {
            const obj = rDesc.get.call(xhr);
            return xhr.readyState === 4 ? translateResponse(pathnameOf(xhr.__poeUrl), obj) : obj;
          }
          return rDesc.get.call(xhr); // blob/arraybuffer/document: untouched
        },
      });
    }
    return origSend.apply(this, arguments);
  };
  }  // end if(SETTINGS.enabled) XHR patch

  // ---- DOM pass: hardcoded UI chrome the data endpoints don't cover ----
  // Exact-match (trimmed) zh -> en for fixed strings: button labels, input
  // placeholders, menu items. Extend as more are spotted.
  const CHROME = {
    // top bar / search
    '搜索物品': 'Search Items', '查找物品...': 'Find Items...', '查找物品…': 'Find Items…',
    '设定': 'Settings', '使用指南': 'Guide', '输入账号名': 'Enter account name',
    '最小值': 'Min', '最大值': 'Max', '清除': 'Clear', '搜索': 'Search',
    '自定义搜索': 'Custom Search', '搜索列表物品': 'Search Listed Items',
    '大宗交易': 'Bulk Item Exchange',
    // stat-filter section + action buttons
    '状态过滤': 'Stat Filters', '状态筛选': 'Stat Filters',
    '+ 增加状态过滤器': '+ Add Stat Filter', '增加状态过滤器': 'Add Stat Filter',
    '+ 增加状态组': '+ Add Stat Group', '增加状态组': 'Add Stat Group',
    '激活实时搜索': 'Activate Live Search', '实时搜索': 'Live Search',
    '隐藏过滤器': 'Hide Filters', '显示过滤器': 'Show Filters',
    // stat-group type dropdown (hardcoded; best-guess zh — verify exact strings).
    // English options are: And, Not, If, Count, Weighted Sum, Weighted Sum v2.
    '与': 'And', '并且': 'And', '全部': 'And',
    '非': 'Not', '排除': 'Not',
    '如果': 'If', '若': 'If',
    '计数': 'Count', '数量': 'Count',
    '加权总和': 'Weighted Sum', '权重总和': 'Weighted Sum', '加权和': 'Weighted Sum',
    '加权总和 V2': 'Weighted Sum v2', '加权总和V2': 'Weighted Sum v2',
    '加权总和 2': 'Weighted Sum v2', '加权总和2': 'Weighted Sum v2',
    '加权总和 v2': 'Weighted Sum v2',
    // result card
    '询价': 'Price', '费用': 'Fee', '前往藏身处': 'Visit Hideout',
    '忽略玩家': 'Ignore Player', '拥有此物': 'Has Item',
    '复制': 'Copy', '上架': 'Listed',
    '上架 刚刚': 'Listed just now', '上架 昨天': 'Listed yesterday',
    '上架 前天': 'Listed 2d ago', '上架 上周': 'Listed last week',
    '刚刚': 'just now', '昨天': 'yesterday', '前天': '2d ago', '上周': 'last week',
    // item property / requirement labels (rendered text in result cards)
    '物理伤害': 'Physical Damage', '元素伤害': 'Elemental Damage',
    '暴击率': 'Critical Hit Chance', '暴击伤害加成': 'Critical Damage Bonus',
    '每秒攻击次数': 'Attacks per Second', '武器范围': 'Weapon Range',
    '每秒造成伤害': 'Damage per Second', '每秒物理伤害': 'Physical Damage per Second',
    '每秒元素伤害': 'Elemental Damage per Second',
    '物品等级': 'Item Level', '需求': 'Requires', '获得技能': 'Grants Skill',
    '等级': 'Level', '力量': 'Strength', '敏捷': 'Dexterity', '智慧': 'Intelligence',
    '精魂': 'Spirit', '品质': 'Quality', '护甲': 'Armour', '闪避值': 'Evasion Rating',
    '能量护盾': 'Energy Shield', '格挡': 'Block',
    '充能次数': 'Charges', '装填时间': 'Reload Time',
    // waystone / map properties + item flags (result cards)
    '复活次数': 'Revives', '物品稀有度': 'Item Rarity', '怪物群规模': 'Monster Pack Size',
    '怪物稀有度': 'Monster Rarity', '怪物效能': 'Monster Effectiveness',
    '引路石掉落几率': 'Waystone Drop Chance', '引路石阶级': 'Waystone Tier',
    '已腐化': 'Corrupted', '已鉴定': 'Identified', '未鉴定': 'Unidentified',
    '数量': 'Quantity', '堆叠数量': 'Stack Size', '经验值': 'Experience',
    // gem / skill tooltip labels
    '消耗': 'Cost', '魔力': 'Mana', '生命': 'Life', '施放时间': 'Cast Time',
    '冷却时间': 'Cooldown Time', '攻击时间': 'Attack Time',
    '可在技能面板中管理技能。': 'Skills can be managed in the Skills panel.',
    '已装备': 'Equipped', '辅助': 'Support', '主动技能': 'Active Skill',
    // skill tags / damage types (rendered as standalone chips)
    '法术': 'Spell', '攻击': 'Attack', '物理': 'Physical', '火焰': 'Fire',
    '冰霜': 'Cold', '闪电': 'Lightning', '混沌': 'Chaos', '近战': 'Melee',
    '投射物': 'Projectile', '持续': 'Duration', '范围': 'Area', '增益': 'Buff',
    '诅咒': 'Curse', '召唤生物': 'Minion', '引导': 'Channelling',
  };

  // Substring replacements (applied within a text node) for composite strings:
  // the league dropdown shows "<game title> - <league>", so we swap both pieces.
  const SUBSTR = Object.assign(
    { '《流放之路：降临》': 'Path of Exile 2', '流放之路：降临': 'Path of Exile 2',
      '（遗产）': '（Legacy）', '(遗产)': '(Legacy)' },   // legacy-variant unique marker
    DICT.leagues);

  // Inline patterns: "等级 N <skill>", gem cost / cast time, etc.
  const PATTERNS = [
    [/^等级\s*(\d+)\s+(\S.*)$/, (m) => 'Level ' + m[1] + ' ' + (DICT.items[m[2]] || m[2])],
    [/^消耗[:：]\s*(\d+)\s*点?(?:魔力|法力)$/, (m) => 'Cost: ' + m[1] + ' Mana'],
    [/^消耗[:：]\s*(\d+)\s*点?生命$/, (m) => 'Cost: ' + m[1] + ' Life'],
    [/^施放时间[:：]\s*([\d.]+)\s*秒$/, (m) => 'Cast Time: ' + m[1] + 's'],
    [/^攻击时间[:：]\s*([\d.]+)\s*秒$/, (m) => 'Attack Time: ' + m[1] + 's'],
    [/^冷却时间[:：]\s*([\d.]+)\s*秒$/, (m) => 'Cooldown Time: ' + m[1] + 's'],
    // standalone gem value nodes (label is a separate, already-translated node)
    [/^(\d+)\s*点\s*(?:魔力|法力)$/, (m) => m[1] + ' Mana'],
    [/^(\d+)\s*点\s*生命$/, (m) => m[1] + ' Life'],
    [/^([\d.]+)\s*秒$/, (m) => m[1] + 's'],
    // relative listing times ("上架 7天前", "7天前", ...)
    [/^(?:上架\s*)?(\d+)\s*天前$/, (m) => (/上架/.test(m[0]) ? 'Listed ' : '') + m[1] + 'd ago'],
    [/^(?:上架\s*)?(\d+)\s*小时前$/, (m) => (/上架/.test(m[0]) ? 'Listed ' : '') + m[1] + 'h ago'],
    [/^(?:上架\s*)?(\d+)\s*分钟前$/, (m) => (/上架/.test(m[0]) ? 'Listed ' : '') + m[1] + 'm ago'],
    [/^(?:上架\s*)?(\d+)\s*周前$/, (m) => (/上架/.test(m[0]) ? 'Listed ' : '') + m[1] + 'w ago'],
    [/^(?:上架\s*)?(\d+)\s*(?:个)?月前$/, (m) => (/上架/.test(m[0]) ? 'Listed ' : '') + m[1] + 'mo ago'],
    // results-count header: "正在展示100个结果 (10000+个匹配项)"
    [/^正在展示\s*(\d+)\s*个结果\s*[（(]\s*([\d,]+\+?)\s*个匹配项\s*[)）]\s*$/,
      (m) => 'Showing ' + m[1] + ' results (' + m[2] + ' matches)'],
    // mod value-range display: "[2—3 到 6—8]" (到 = "to")
    [/^\[([\d.\-—]+)\s*到\s*([\d.\-—]+)\]$/, (m) => '[' + m[1] + ' to ' + m[2] + ']'],
  ];

  const CJK = /[一-鿿]/;

  function tText(node) {
    if (PEEKING) return;                      // don't re-translate while peeking
    const v = node.nodeValue;
    if (!v) return;
    const k = v.trim();
    if (!k || !CJK.test(k)) return;          // skip empty / already-English nodes
    const set = (en) => { REVERSE.set(en, k); node.nodeValue = v.replace(k, en); };

    // 1) fixed chrome + dict-sourced UI terms / gem tags (colon-aware).
    // CHROME is the legacy hand-map; DICT.uiTerms/gemTags come from the dictionary
    // export and are the preferred source (CHROME retires once uiTerms covers it).
    const term = (x) => CHROME[x] || (DICT.uiTerms && DICT.uiTerms[x]) || (DICT.gemTags && DICT.gemTags[x]);
    if (term(k)) return set(term(k));
    const cm = k.match(/^([\s\S]*?)\s*([：:])$/);
    if (cm && term(cm[1])) return set(term(cm[1]) + cm[2]);

    // 1b) affix (prefix/suffix) display words, incl. "<word> (≥N)" tier annotations
    if (DICT.affixes) {
      if (DICT.affixes[k]) return set(DICT.affixes[k]);
      const am = k.match(/^(\S+?)\s*(\([^)]*\))$/);
      if (am && DICT.affixes[am[1]]) return set(DICT.affixes[am[1]] + ' ' + am[2]);
    }

    // 2) inline patterns (granted skill, gem cost/cast time)
    for (const [re, fn] of PATTERNS) {
      const m = k.match(re);
      if (m) return set(fn(m));
    }

    // 3) item base / class / skill names (result item lines, gem tooltip header)
    if (k.length <= 32 && (DICT.items[k] || DICT.itemClasses[k] || DICT.skillNames[k])) {
      return set(DICT.items[k] || DICT.itemClasses[k] || DICT.skillNames[k]);
    }

    // 4) skill description prose (gem tooltips) — full-sentence exact match
    if (DICT.skillDesc[k]) return set(DICT.skillDesc[k]);

    // 5) stat/mod/skill text by template (gem tooltip stat lines, mods, anywhere)
    const sl = translateStatLine(k);
    if (sl !== null) return set(sl);
    const mod = translateMod(k, null);
    if (mod !== k) return set(mod);

    // 5) composite strings with an embedded league / game-title substring
    let out = k;
    for (const zh in SUBSTR) if (out.indexOf(zh) >= 0) out = out.split(zh).join(SUBSTR[zh]);
    if (out !== k) return set(out);
  }
  function tAttr(el, attr) {
    const a = el.getAttribute(attr);
    if (a) { const k = a.trim(); if (CHROME[k]) el.setAttribute(attr, CHROME[k]); }
  }
  function tValue(el) {
    if (el.tagName !== 'INPUT') return;
    const ty = (el.getAttribute('type') || '').toLowerCase();
    if (ty === 'submit' || ty === 'button' || ty === 'reset') tAttr(el, 'value');
  }
  function domPass(root) {
    try {
      if (root.nodeType === 1) {
        if (root.hasAttribute && root.hasAttribute('placeholder')) tAttr(root, 'placeholder');
        tValue(root);
        if (root.querySelectorAll) {
          root.querySelectorAll('[placeholder]').forEach((e) => tAttr(e, 'placeholder'));
          root.querySelectorAll('input[type=submit],input[type=button],input[type=reset]')
            .forEach(tValue);
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n; while ((n = walker.nextNode())) tText(n);
    } catch (e) { /* ignore */ }
  }

  function startDom() {
    domPass(document.body || document.documentElement);
    domObserver = new MutationObserver((muts) => {
      if (PEEKING) return;
      for (const m of muts) {
        if (m.type === 'attributes' && m.target.nodeType === 1) {
          if (m.attributeName === 'value') tValue(m.target);
          else tAttr(m.target, m.attributeName);
        } else if (m.type === 'characterData' && m.target.nodeType === 3) {
          tText(m.target);
        }
        for (const node of m.addedNodes) {
          if (node.nodeType === 3) tText(node);
          else if (node.nodeType === 1) domPass(node);
        }
      }
    });
    domObserver.observe(document.documentElement, OBS_OPTS);
  }
  if (SETTINGS.enabled && SETTINGS.dom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startDom);
    } else {
      startDom();
    }
  }

  // ---- management panel (always available, even when translation is off) ----
  function buildPanel() {
    if (document.getElementById('poe2cn-panel-btn')) return;
    const css = document.createElement('style');
    css.textContent = `
      #poe2cn-panel-btn{position:fixed;right:14px;bottom:14px;z-index:2147483646;
        width:40px;height:40px;border-radius:50%;border:1px solid #b8924a;
        background:#1a1812;color:#cBA56a;font:600 12px/40px system-ui,sans-serif;
        text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5);opacity:.85}
      #poe2cn-panel-btn:hover{opacity:1}
      #poe2cn-panel{position:fixed;right:14px;bottom:62px;z-index:2147483646;width:300px;
        background:#14120d;color:#d8c7a0;border:1px solid #b8924a;border-radius:8px;
        font:13px/1.5 system-ui,sans-serif;padding:14px 16px;display:none;
        box-shadow:0 4px 16px rgba(0,0,0,.6)}
      #poe2cn-panel h3{margin:0 0 8px;font-size:14px;color:#e8d8a8}
      #poe2cn-panel .row{display:flex;align-items:center;justify-content:space-between;margin:7px 0}
      #poe2cn-panel label{cursor:pointer}
      #poe2cn-panel small{color:#8a7c5c}
      #poe2cn-panel button{margin-top:10px;width:100%;padding:7px;cursor:pointer;
        background:#2a2418;color:#e8d8a8;border:1px solid #b8924a;border-radius:5px}
      #poe2cn-panel button:hover{background:#352c1c}
      #poe2cn-panel .ver{border-top:1px solid #3a3322;margin-top:10px;padding-top:8px}`;
    document.head.appendChild(css);

    const btn = document.createElement('div');
    btn.id = 'poe2cn-panel-btn'; btn.textContent = '中EN'; btn.title = 'PoE2 Trade English - settings';
    const panel = document.createElement('div');
    panel.id = 'poe2cn-panel';
    const c = META.counts || {};
    const toggle = (k, lbl) => `<div class="row"><label for="poe2cn-${k}">${lbl}</label>` +
      `<input type="checkbox" id="poe2cn-${k}" ${SETTINGS[k] ? 'checked' : ''}></div>`;
    panel.innerHTML =
      '<h3>PoE2 Trade - English</h3>' +
      toggle('enabled', 'Enable translation') +
      toggle('dom', 'Translate page text (tooltips/labels)') +
      toggle('debug', 'Debug logging (console)') +
      '<button id="poe2cn-peek">Show original Chinese</button>' +
      '<button id="poe2cn-miss">Check item coverage</button>' +
      '<button id="poe2cn-clear">Clear trade-data cache &amp; reload</button>' +
      `<div class="ver"><small>dict ${META.version || '?'}<br>built ${META.builtAt || '?'}<br>` +
      `${c.stats || 0} stats &middot; ${c.items || 0} items &middot; ${c.statLines || 0} stat lines &middot; ` +
      `${c.skillDesc || 0} skills</small></div>` +
      '<div class="ver"><small>Toggle the button above, or hold <b>`</b> (backtick), to show the original Chinese.</small></div>' +
      '<div class="ver"><small>Update after a game patch: run <b>refresh.ps1</b>, ' +
      'then reload this script in Tampermonkey.</small></div>';
    document.body.appendChild(btn); document.body.appendChild(panel);

    btn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    });
    for (const k of ['enabled', 'dom', 'debug']) {
      panel.querySelector('#poe2cn-' + k).addEventListener('change', (e) => {
        setFlag(k, e.target.checked);
        // toggling translation on/off changes whether data gets translated at
        // fetch time, so refetch the cached payloads.
        if (k === 'enabled') bustCache();
        location.reload();
      });
    }
    panel.querySelector('#poe2cn-clear').addEventListener('click', () => {
      bustCache(); location.reload();
    });
    const peekBtn = panel.querySelector('#poe2cn-peek');
    if (peekBtn) peekBtn.addEventListener('click', togglePeek);
    updatePeekBtn();
    const missBtn = panel.querySelector('#poe2cn-miss');
    if (missBtn) missBtn.addEventListener('click', (e) => {
      const list = [...ITEM_MISS.keys()].sort();
      console.log('[poe2cn] untranslated item bases seen this session (' + list.length + '):', list);
      if (list.length) { try { navigator.clipboard.writeText(list.join('\n')); } catch (_) {} }
      e.target.textContent = list.length
        ? `Untranslated items: ${list.length} (copied, see console)`
        : 'Item coverage: all translated ✓';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }

  // ---- peek: show the original Chinese, via held hotkey OR panel toggle ----
  // Walks the DOM and swaps every shown-English string we recorded an original
  // for back to Chinese; restores on exit. Pauses the observer while peeking.
  let peeked = [];
  function peekOn() {
    if (PEEKING || !REVERSE.size) return;
    PEEKING = true;
    if (domObserver) domObserver.disconnect();
    try {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = w.nextNode())) {
        const val = node.nodeValue; if (!val) continue;
        const k = val.trim(); if (!k) continue;
        const zh = REVERSE.get(k);
        if (typeof zh === 'string' && zh !== k) { peeked.push({ node, saved: val }); node.nodeValue = val.replace(k, zh); }
      }
    } catch (_) {}
    updatePeekBtn();
  }
  function peekOff() {
    if (!PEEKING) return;
    for (const p of peeked) { try { p.node.nodeValue = p.saved; } catch (_) {} }
    peeked = [];
    PEEKING = false;
    if (domObserver) domObserver.observe(document.documentElement, OBS_OPTS);
    updatePeekBtn();
  }
  function togglePeek() { if (PEEKING) peekOff(); else peekOn(); }
  function updatePeekBtn() {
    const b = document.getElementById('poe2cn-peek');
    if (b) b.textContent = PEEKING ? 'Show English (restore)' : 'Show original Chinese';
  }

  // hold-to-peek hotkey (default Backquote; override via localStorage poe2cn:peekKey).
  // Only the *held* key auto-restores on release; a button toggle stays until clicked.
  if (SETTINGS.enabled) {
    let PEEK_CODE = 'Backquote';
    try { PEEK_CODE = localStorage.getItem(SKEY('peekKey')) || 'Backquote'; } catch (_) {}
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    let heldPeek = false;
    window.addEventListener('keydown', (e) => {
      if (e.code === PEEK_CODE && !e.repeat && !typing(e.target) && !PEEKING) {
        e.preventDefault(); heldPeek = true; peekOn();
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (e.code === PEEK_CODE && heldPeek) { heldPeek = false; peekOff(); }
    }, true);
    window.addEventListener('blur', () => { if (heldPeek) { heldPeek = false; peekOff(); } });
  }

  console.log('[poe2cn]', SETTINGS.enabled ? 'active' : 'DISABLED', '- dict', META.version,
    '(' + (META.counts ? META.counts.stats : '?') + ' stats,',
    (META.counts ? META.counts.items : '?') + ' items)');
})();
