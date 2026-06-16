// extract_items.mjs — datamine en<->zh item base names + class names from the
// 国服 (CN) PoE2 client, joined on the language-independent metadata `Id`.
//
// Why this exists: the trade /api/trade2/data/items endpoint lists item base
// types only by their *localized* display string (no shared id), and the CN site
// lags the intl patch, so a position-join across the two sites mis-pairs. The
// game client, however, ships every table in English AND in a Simplified-Chinese
// overlay (Data/Balance/Simplified Chinese/<table>.datc64), both keyed by the
// stable metadata `Id`. Joining EN vs SC on `Id` gives a robust base-name map.
//
// Reuses the sibling FilterBlade-CN engine (openInstall/getSchema/extractTable),
// so the heavy pathofexile-dat/Oodle deps stay inside that toolchain. Run with
// the sibling's portable node:
//   <...>/filterblade2cn/tool/node/node.exe extract_items.mjs [cnInstall] [--refresh-schema]
//
// Output (in this project): tool/data/item_bases.json, item_classes.json, items.meta.json
// Re-run after a CN client content update (~every 4 months).

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getSchema, openInstall, extractTable, sanityCheckBaseItems, findGuofuInstall }
  from '../../filterblade2cn/tool/engine/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));            // <proj>/tool
const SIBLING_DATA = path.resolve(HERE, '../../filterblade2cn/tool/data');
const OUT_DATA = path.join(HERE, 'data');
const LANG = 'Simplified Chinese';

const args = process.argv.slice(2);
const refreshSchema = args.includes('--refresh-schema');
const cliInstall = args.find(a => !a.startsWith('--'));

async function resolveCnInstall() {
  // 1) explicit CLI arg, 2) sibling config, 3) auto-detect the WeGame install.
  const extra = [];
  if (cliInstall) extra.push(cliInstall);
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(SIBLING_DATA, 'config.json'), 'utf8'));
    if (cfg.cnInstall) extra.push(cfg.cnInstall);
  } catch {}
  const found = await findGuofuInstall(extra);
  if (!found) {
    console.error(
      '[extract_items] FATAL: the 国服 (WeGame) PoE2 client was not found.\n' +
      '  This tool requires the WeGame install (its Simplified-Chinese data is the\n' +
      '  only authoritative source). Pass the path explicitly:\n' +
      '    node extract_items.mjs "C:\\\\WeGameApps\\\\rail_apps\\\\Path of  Exile 2(2002052)"\n' +
      '  or set cnInstall in filterblade2cn\\tool\\data\\config.json.');
    process.exit(1);
  }
  return found;
}

// Join an English row set against a localized row set on `Id`.
// Returns [{id, en, zh}] for every row that has an English Name.
function joinByIdLang(enRows, zhRows) {
  const zhById = new Map(zhRows.map(r => [r.Id, r.Name]));
  const out = [];
  let translated = 0, untranslated = 0;
  for (const r of enRows) {
    if (!r.Name) continue;                 // skip unnamed/internal rows
    const zh = zhById.get(r.Id);
    const zhName = (zh != null && zh !== '') ? zh : r.Name;  // fall back to EN
    if (zhName !== r.Name) translated++; else untranslated++;
    out.push({ id: r.Id, en: r.Name, zh: zhName });
  }
  return { rows: out, translated, untranslated };
}

async function main() {
  const cnInstall = await resolveCnInstall();
  console.log(`[extract_items] CN install: ${cnInstall}`);
  if (!(await fs.stat(path.join(cnInstall, 'Bundles2', '_.index.bin')).catch(() => null))) {
    console.error(`[extract_items] FATAL: CN install not found (no Bundles2/_.index.bin).`);
    process.exit(1);
  }

  const { schema, source } = await getSchema({ forceRefresh: refreshSchema });
  console.log(`[extract_items] schema: ${source} (v${schema.version})`);

  const get = await openInstall(cnInstall);

  // BaseItemTypes — EN (default path) and SC overlay, joined on Id.
  const enBit = await extractTable(get, schema, 'BaseItemTypes');
  const sanity = sanityCheckBaseItems(enBit.rows);
  if (!sanity.ok) {
    console.error(`[extract_items] SANITY FAILED for BaseItemTypes `
      + `(rows=${sanity.rowCount}, sentinels=${JSON.stringify(sanity.sentinelsFound)}). Aborting.`);
    process.exit(2);
  }
  const zhBit = await extractTable(get, schema, 'BaseItemTypes', LANG);
  const bases = joinByIdLang(enBit.rows, zhBit.rows);

  // ItemClasses — EN + SC, joined on Id (category/class display names).
  const enCls = await extractTable(get, schema, 'ItemClasses');
  const zhCls = await extractTable(get, schema, 'ItemClasses', LANG);
  const classes = joinByIdLang(enCls.rows, zhCls.rows);

  // ActiveSkills — gem/skill DisplayedName + Description (for gem tooltips).
  const SK_COLS = ['Id', 'DisplayedName', 'Description'];
  let skills = { rows: [], named: 0, described: 0 };
  try {
    const enSk = await extractTable(get, schema, 'ActiveSkills', null, SK_COLS);
    const zhSk = await extractTable(get, schema, 'ActiveSkills', LANG, SK_COLS);
    const zhById = new Map(zhSk.rows.map(r => [r.Id, r]));
    for (const r of enSk.rows) {
      const z = zhById.get(r.Id) || {};
      const row = {
        id: r.Id,
        en_name: r.DisplayedName || "", zh_name: z.DisplayedName || r.DisplayedName || "",
        en_desc: r.Description || "", zh_desc: z.Description || r.Description || "",
      };
      if (!row.en_name && !row.en_desc) continue;
      if (row.en_name) skills.named++;
      if (row.en_desc) skills.described++;
      skills.rows.push(row);
    }
  } catch (e) {
    console.warn(`[extract_items] ActiveSkills extract failed (${e.message}); skills skipped.`);
  }

  await fs.mkdir(OUT_DATA, { recursive: true });
  await fs.writeFile(path.join(OUT_DATA, 'item_bases.json'),
    JSON.stringify(bases.rows, null, 0), 'utf8');
  await fs.writeFile(path.join(OUT_DATA, 'item_classes.json'),
    JSON.stringify(classes.rows, null, 0), 'utf8');
  await fs.writeFile(path.join(OUT_DATA, 'skill_text.json'),
    JSON.stringify(skills.rows, null, 0), 'utf8');
  await fs.writeFile(path.join(OUT_DATA, 'items.meta.json'), JSON.stringify({
    when: new Date().toISOString(),
    schemaVersion: schema.version,
    cnInstall,
    baseItemTypes: { rows: enBit.rowCount, named: bases.rows.length,
      translated: bases.translated, untranslated: bases.untranslated },
    itemClasses: { rows: enCls.rowCount, named: classes.rows.length,
      translated: classes.translated },
    activeSkills: { rows: skills.rows.length, named: skills.named,
      described: skills.described },
  }, null, 2), 'utf8');

  console.log(`[extract_items] BaseItemTypes: ${bases.rows.length} named `
    + `(${bases.translated} translated, ${bases.untranslated} same-as-EN)`);
  console.log(`[extract_items] ItemClasses:  ${classes.rows.length} named `
    + `(${classes.translated} translated)`);
  console.log(`[extract_items] ActiveSkills: ${skills.rows.length} rows `
    + `(${skills.named} named, ${skills.described} described)`);
  console.log(`[extract_items] wrote ${path.join(OUT_DATA, 'item_bases.json')}`);
  console.log(`[extract_items] wrote ${path.join(OUT_DATA, 'item_classes.json')}`);
}

main().catch(e => { console.error('[extract_items] ERROR:', e); process.exit(1); });
