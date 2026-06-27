#!/usr/bin/env python3
"""
build_dict.py — Build the en<->zh trade dictionary for the PoE2 CN trade helper.

Fetches the *public* /api/trade2/data/* endpoints from the international and the
Chinese (国服) trade sites and joins them into a single ``dict.json`` keyed by
language-independent ids, then writes a coverage/diff report so that content
updates (roughly every 4 months) can be reviewed at a glance.

Join strategy per endpoint (see the verified notes in HANDOFF.md §4b):
  - stats   : groups joined by group ``id``; entries by entry ``id`` (+ options
              by option ``id``). All ids are language-independent  -> ROBUST.
  - static  : same id-join as stats.                                -> ROBUST.
  - items   : entries have no shared id (only the localized ``type``), so they
              are joined BY POSITION within each shared category id.   FRAGILE.
  - leagues : no shared id (the id *is* the localized name), joined BY POSITION.
              FRAGILE.

"Fragile" = if the two hosts ever fall out of sync (CN typically lags the intl
patch), a position-join can silently mis-pair. The builder therefore guards every
position-join with a per-section count-parity check and reports any mismatch
loudly. After a content update: re-run, then READ report.md before trusting the
fragile sections.

Zero third-party dependencies (Python stdlib only). Intended to run under WSL:
    wsl python3 /mnt/c/.../poe2cn-trade-helper/tool/build_dict.py

Usage:
    python3 build_dict.py            # fetch live -> dist/dict.json + dist/report.md
    python3 build_dict.py --offline  # rebuild from cached raw/ responses (no network)
    python3 build_dict.py --timeout 60
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# --- configuration ----------------------------------------------------------

HOSTS = {
    "intl": "www.pathofexile.com",
    "cn": "poe.game.qq.com",
}
ENDPOINTS = ["stats", "items", "static", "leagues", "filters"]

# Full browser-like headers. pathofexile.com sits behind Cloudflare, whose
# bot-fight rules 403 bare requests; a real Referer + Sec-Fetch-* + Accept-
# Language get served normally. Sent to both hosts (harmless to CN).
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}
PACING_SECONDS = 1.5   # gap between live requests, to stay under CF bot-fight
MAX_ATTEMPTS = 3       # per-endpoint retries on block/transient failure

SCRIPT_DIR = Path(__file__).resolve().parent
RAW_DIR = SCRIPT_DIR / "raw"
DATA_DIR = SCRIPT_DIR / "data"          # client-datamined inputs (extract_items.mjs)
DIST_DIR = SCRIPT_DIR / "dist"
DICT_PATH = DIST_DIR / "dict.json"
RUNTIME_PATH = DIST_DIR / "dict.runtime.json"       # slim display-only zh/id -> en
REPORT_PATH = DIST_DIR / "report.md"
USERSCRIPT_PATH = DIST_DIR / "poe2cn-trade.user.js"
TEMPLATE_PATH = SCRIPT_DIR / "userscript.template.js"
ITEM_BASES_PATH = DATA_DIR / "item_bases.json"      # [{id, en, zh}]
ITEM_CLASSES_PATH = DATA_DIR / "item_classes.json"  # [{id, en, zh}]
SKILL_TEXT_PATH = DATA_DIR / "skill_text.json"      # [{id, en_name, zh_name, en_desc, zh_desc}]
STAT_LINES_PATH = DATA_DIR / "stat_lines.json"      # [[zhTemplate, enTemplate], ...]
UNIQUE_NAMES_PATH = DATA_DIR / "unique_names.json"  # [[zh, en], ...] (Words.Text2)

# PoE rich-text markup: "[Key|Display]" renders as "Display"; "[Display]" as "Display".
_TAG_PIPE = re.compile(r"\[([^\]|]+)\|([^\]]+)\]")
_TAG_PLAIN = re.compile(r"\[([^\]]+)\]")


def strip_tags(s: str | None) -> str:
    if not s:
        return ""
    return _TAG_PLAIN.sub(r"\1", _TAG_PIPE.sub(r"\2", s))


# --- fetching / caching -----------------------------------------------------

def raw_path(side: str, endpoint: str) -> Path:
    return RAW_DIR / f"{side}_{endpoint}.json"


def _curl_exe() -> str | None:
    """Locate a curl binary. Prefer Windows curl.exe: when running under WSL,
    the Windows network stack honours the user's system proxy / fake-IP TUN that
    the WSL stack cannot reach (the intl host resolves to 198.18.x.x there)."""
    for name in ("curl.exe", "curl"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _referer(host: str) -> str:
    return f"https://{host}/trade2/search/poe2/Standard"


def _fetch_bytes(url: str, host: str, timeout: int) -> bytes:
    """Single HTTP GET. Uses curl.exe via interop when available, else urllib."""
    curl = _curl_exe()
    if curl:
        cmd = [curl, "-s", "--compressed", "--max-time", str(timeout)]
        for k, v in BROWSER_HEADERS.items():
            cmd += ["-H", f"{k}: {v}"]
        cmd += ["-H", f"Referer: {_referer(host)}", url]
        out = subprocess.run(cmd, capture_output=True)
        if out.returncode != 0:
            raise RuntimeError(
                f"curl exit {out.returncode}: "
                f"{out.stderr.decode('utf-8', 'replace')[:200]}"
            )
        return out.stdout
    req = urllib.request.Request(
        url, headers={**BROWSER_HEADERS, "Referer": _referer(host)}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch(side: str, endpoint: str, timeout: int) -> dict:
    """Fetch one endpoint from one host with retry/backoff, validate it is the
    expected JSON (not a Cloudflare block page), cache the raw bytes, return it."""
    host = HOSTS[side]
    url = f"https://{host}/api/trade2/data/{endpoint}"
    last_err: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            body = _fetch_bytes(url, host, timeout)
            obj = json.loads(body.decode("utf-8"))
            if "result" not in obj:
                raise ValueError("response JSON has no 'result' key")
            RAW_DIR.mkdir(parents=True, exist_ok=True)
            raw_path(side, endpoint).write_bytes(body)
            return obj
        except (json.JSONDecodeError, ValueError, RuntimeError,
                urllib.error.URLError) as e:
            last_err = e
            if attempt < MAX_ATTEMPTS:
                wait = 2 * attempt
                print(f"[build_dict] {side}/{endpoint} attempt {attempt} "
                      f"failed ({e}); retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
    raise RuntimeError(f"{side}/{endpoint}: all {MAX_ATTEMPTS} attempts failed "
                       f"(last: {last_err})")


def load_cached(side: str, endpoint: str) -> dict:
    p = raw_path(side, endpoint)
    if not p.exists():
        raise FileNotFoundError(
            f"--offline set but cache missing: {p}\n"
            f"Run once online first to populate {RAW_DIR}."
        )
    return json.loads(p.read_bytes().decode("utf-8"))


def get_all(offline: bool, timeout: int) -> dict:
    """Return {endpoint: {'intl': data, 'cn': data}} for every endpoint."""
    out: dict[str, dict[str, dict]] = {}
    for ep in ENDPOINTS:
        out[ep] = {}
        for side in HOSTS:
            if offline:
                out[ep][side] = load_cached(side, ep)
            else:
                out[ep][side] = fetch(side, ep, timeout)
                time.sleep(PACING_SECONDS)  # be gentle with CF bot-fight
    return out


# --- join helpers -----------------------------------------------------------

def _index_by(items, key):
    return {it[key]: it for it in items if key in it}


def join_id(intl: dict, cn: dict) -> tuple[dict, dict]:
    """ID-join for stats/static. Returns (result_dict, coverage)."""
    intl_groups = _index_by(intl["result"], "id")
    cn_groups = _index_by(cn["result"], "id")

    groups: dict[str, dict] = {}
    entries: dict[str, dict] = {}
    options: dict[str, dict] = {}

    matched_groups = sorted(set(intl_groups) & set(cn_groups))
    for gid in matched_groups:
        ig, cg = intl_groups[gid], cn_groups[gid]
        groups[gid] = {"en": ig.get("label"), "zh": cg.get("label")}

        ie = _index_by(ig.get("entries", []), "id")
        ce = _index_by(cg.get("entries", []), "id")
        for eid in set(ie) & set(ce):
            ien, cen = ie[eid], ce[eid]
            entries[eid] = {"en": ien.get("text"), "zh": cen.get("text")}
            # discrete dropdown options are localized too -> join by option id
            iopts = {o["id"]: o for o in ien.get("option", {}).get("options", [])}
            copts = {o["id"]: o for o in cen.get("option", {}).get("options", [])}
            for oid in set(iopts) & set(copts):
                options[f"{eid}::{oid}"] = {
                    "en": iopts[oid].get("text"),
                    "zh": copts[oid].get("text"),
                }

    coverage = {
        "intl_groups": len(intl_groups),
        "cn_groups": len(cn_groups),
        "matched_groups": len(matched_groups),
        "intl_only_groups": sorted(set(intl_groups) - set(cn_groups)),
        "cn_only_groups": sorted(set(cn_groups) - set(intl_groups)),
        "intl_entries": sum(len(g.get("entries", [])) for g in intl["result"]),
        "cn_entries": sum(len(g.get("entries", [])) for g in cn["result"]),
        "matched_entries": len(entries),
        "matched_options": len(options),
    }
    return {"groups": groups, "entries": entries, "options": options}, coverage


def join_item_categories(intl: dict, cn: dict) -> tuple[dict, dict, set]:
    """Item *category labels* id-join cleanly (the group `id` is shared, e.g.
    'accessory'), even though the base-type entries within them do not (CN lags
    the intl patch -> a position-join mis-pairs). So here we only translate the
    category labels and harvest the CN entries' localized `type` strings, which
    are used to coverage-check the client-datamined base map (join_item_bases)."""
    intl_cat = _index_by(intl["result"], "id")
    cn_cat = _index_by(cn["result"], "id")

    categories: dict[str, dict] = {}
    cn_types: set[str] = set()
    for cid in sorted(set(intl_cat) & set(cn_cat)):
        ic, cc = intl_cat[cid], cn_cat[cid]
        categories[cid] = {"en": ic.get("label"), "zh": cc.get("label")}
    for g in cn["result"]:
        for e in g.get("entries", []):
            if e.get("type"):
                cn_types.add(e["type"])

    coverage = {
        "intl_categories": len(intl_cat),
        "cn_categories": len(cn_cat),
        "matched_categories": len(categories),
        "intl_only_categories": sorted(set(intl_cat) - set(cn_cat)),
        "cn_only_categories": sorted(set(cn_cat) - set(intl_cat)),
        "cn_type_strings": len(cn_types),
    }
    return categories, coverage, cn_types


def load_client_list(path: Path) -> list[dict] | None:
    """Load a client-datamined [{id, en, zh}] list (from extract_items.mjs)."""
    if not path.exists():
        return None
    return json.loads(path.read_bytes().decode("utf-8"))


def build_item_bases(cn_types: set[str]) -> tuple[dict, dict]:
    """Build the en<->zh item-base section from the client extract, and
    coverage-check it against the CN trade endpoint's `type` strings."""
    bases = load_client_list(ITEM_BASES_PATH)
    classes = load_client_list(ITEM_CLASSES_PATH)
    if bases is None:
        return {"bases": [], "classes": classes or [], "source": "missing"}, {
            "available": False,
        }

    # zh display name -> en. (Multiple ids can share a display name; keep first.)
    zh_to_en: dict[str, str] = {}
    for b in bases:
        zh, en = b.get("zh"), b.get("en")
        if zh and en:
            zh_to_en.setdefault(zh, en)

    covered = sum(1 for t in cn_types if t in zh_to_en)
    uncovered = sorted(t for t in cn_types if t not in zh_to_en)

    section = {
        "bases": [{"en": b["en"], "zh": b["zh"]} for b in bases
                  if b.get("en") and b.get("zh")],
        "classes": [{"en": c["en"], "zh": c["zh"]} for c in (classes or [])
                    if c.get("en") and c.get("zh")],
        "source": "client-datamined (metadata Id join)",
    }
    coverage = {
        "available": True,
        "client_bases": len(section["bases"]),
        "client_classes": len(section["classes"]),
        "cn_trade_types": len(cn_types),
        "cn_trade_types_covered": covered,
        "cn_trade_types_uncovered": uncovered,
    }
    return section, coverage


# English labels for CN-only filters that have no intl counterpart to join against.
MANUAL_FILTER_TEXT = {
    # CN exposes a Waystone Item-Quantity filter that intl's trade does not;
    # name it to match intl's sibling "Waystone IIR" (map_iir).
    "map_iiq": "Waystone IIQ",
}


def join_filters(intl: dict, cn: dict) -> tuple[dict, dict]:
    """The /data/filters panel (Type/Equipment/Requirements/... sections and their
    named sub-filters + dropdown options). Language-independent ids at 3 levels:
    group `id` (title), filter `id` (text), option `id` (text). Some options have
    a null id (e.g. the leading 'Any') — those are id-joined by position within
    their filter and also recorded in a zh->en fallback map."""
    intl_g = _index_by(intl["result"], "id")
    cn_g = _index_by(cn["result"], "id")

    groups: dict[str, dict] = {}      # group id -> {en, zh}  (section title)
    filters: dict[str, dict] = {}     # filter id -> {en, zh}
    options: dict[str, dict] = {}     # "fid::oid" -> {en, zh}
    options_by_zh: dict[str, str] = {}  # zh text -> en  (covers null-id options)

    for gid in sorted(set(intl_g) & set(cn_g)):
        ig, cg = intl_g[gid], cn_g[gid]
        if ig.get("title") or cg.get("title"):
            groups[gid] = {"en": ig.get("title"), "zh": cg.get("title")}
        if_ = _index_by(ig.get("filters", []), "id")
        cf_ = _index_by(cg.get("filters", []), "id")
        for fid in set(if_) & set(cf_):
            iff, cff = if_[fid], cf_[fid]
            if iff.get("text") or cff.get("text"):
                filters[fid] = {"en": iff.get("text"), "zh": cff.get("text")}
            iopts = (iff.get("option") or {}).get("options", [])
            copts = (cff.get("option") or {}).get("options", [])
            iby = {o.get("id"): o for o in iopts if o.get("id") is not None}
            cby = {o.get("id"): o for o in copts if o.get("id") is not None}
            for oid in set(iby) & set(cby):
                en, zh = iby[oid].get("text"), cby[oid].get("text")
                options[f"{fid}::{oid}"] = {"en": en, "zh": zh}
                if zh and en:
                    options_by_zh.setdefault(zh, en)
            # null-id options (e.g. 'Any'): pair by position within this filter
            i_null = [o for o in iopts if o.get("id") is None]
            c_null = [o for o in copts if o.get("id") is None]
            for a, b in zip(i_null, c_null):
                if b.get("text") and a.get("text"):
                    options_by_zh.setdefault(b["text"], a["text"])

    # manual labels for CN-only filters (no intl row to id-join against)
    cn_all = {f["id"]: f for g in cn["result"] for f in g.get("filters", [])}
    for fid, en in MANUAL_FILTER_TEXT.items():
        if fid not in filters and fid in cn_all:
            filters[fid] = {"en": en, "zh": cn_all[fid].get("text")}

    coverage = {
        "groups": len(groups),
        "filters": len(filters),
        "options": len(options),
        "options_by_zh": len(options_by_zh),
    }
    section = {
        "groups": groups, "filters": filters,
        "options": options, "options_by_zh": options_by_zh,
    }
    return section, coverage


def join_leagues(intl: dict, cn: dict) -> tuple[list, dict]:
    """Position-join leagues. Guards on count."""
    ir, cr = intl["result"], cn["result"]
    pairs: list[dict] = []
    safe = len(ir) == len(cr)
    if safe:
        for a, b in zip(ir, cr):
            pairs.append({"en": a.get("text"), "zh": b.get("text")})
    coverage = {
        "intl_count": len(ir),
        "cn_count": len(cr),
        "count_match": safe,
        "intl_list": [x.get("text") for x in ir],
        "cn_list": [x.get("text") for x in cr],
    }
    return pairs, coverage


# --- report -----------------------------------------------------------------

def load_previous_dict() -> dict | None:
    if DICT_PATH.exists():
        try:
            return json.loads(DICT_PATH.read_bytes().decode("utf-8"))
        except Exception:
            return None
    return None


def diff_keys(old: dict | None, new: dict, path: list[str]) -> dict:
    """Diff entry-id sets between previous and new dict at dict[path...]."""
    def dig(d):
        for k in path:
            if not isinstance(d, dict):
                return {}
            d = d.get(k, {})
        return d if isinstance(d, dict) else {}

    old_keys = set(dig(old)) if old else set()
    new_keys = set(dig(new))
    return {"added": sorted(new_keys - old_keys), "removed": sorted(old_keys - new_keys)}


def _trunc(items, n=15):
    items = list(items)
    if len(items) <= n:
        return ", ".join(map(str, items)) or "(none)"
    return ", ".join(map(str, items[:n])) + f" … (+{len(items) - n} more)"


def write_report(cov: dict, dict_obj: dict, prev: dict | None) -> str:
    L: list[str] = []
    L.append(f"# Trade dictionary build report")
    L.append("")
    L.append(f"Generated: {dict_obj['meta']['generated_at']}")
    L.append(f"Source mode: {dict_obj['meta']['mode']}")
    L.append("")

    warnings: list[str] = []

    # stats
    s = cov["stats"]
    L.append("## stats  (id-join — robust)")
    L.append(f"- entries: intl {s['intl_entries']}, cn {s['cn_entries']}, "
             f"**matched {s['matched_entries']}**, options matched {s['matched_options']}")
    L.append(f"- groups: matched {s['matched_groups']} "
             f"(intl-only: {_trunc(s['intl_only_groups'])}; "
             f"cn-only: {_trunc(s['cn_only_groups'])})")
    L.append("")

    # static
    t = cov["static"]
    L.append("## static  (id-join — robust)")
    L.append(f"- entries: intl {t['intl_entries']}, cn {t['cn_entries']}, "
             f"**matched {t['matched_entries']}**")
    L.append(f"- groups: matched {t['matched_groups']} "
             f"(intl-only: {_trunc(t['intl_only_groups'])}; "
             f"cn-only: {_trunc(t['cn_only_groups'])})")
    if t["matched_entries"] == 0:
        warnings.append("static: 0 entries matched by id — ids may not be shared; "
                        "static may need a position-join instead.")
    L.append("")

    # item categories (id-join from trade endpoint)
    it = cov["items"]
    L.append("## item categories  (id-join from trade endpoint — robust)")
    L.append(f"- categories matched: {it['matched_categories']} "
             f"(intl {it['intl_categories']}, cn {it['cn_categories']})")
    if it["intl_only_categories"]:
        L.append(f"- intl-only categories: {_trunc(it['intl_only_categories'])}")
    if it["cn_only_categories"]:
        L.append(f"- cn-only categories: {_trunc(it['cn_only_categories'])}")
    L.append("")

    # item bases (client-datamined, id-join)
    ib = cov["item_bases"]
    L.append("## item bases  (client-datamined, metadata-Id join — robust)")
    if not ib["available"]:
        L.append("- ⚠️ `tool/data/item_bases.json` MISSING — run `extract_items.mjs` "
                 "with the sibling node to datamine the CN client. Items left empty.")
        warnings.append("item bases: item_bases.json missing — run extract_items.mjs.")
    else:
        pct = (100 * ib["cn_trade_types_covered"] / ib["cn_trade_types"]
               if ib["cn_trade_types"] else 0)
        L.append(f"- client base names: {ib['client_bases']}, "
                 f"client classes: {ib['client_classes']}")
        L.append(f"- coverage of CN trade `type` strings: "
                 f"**{ib['cn_trade_types_covered']}/{ib['cn_trade_types']} "
                 f"({pct:.1f}%)**")
        unc = ib["cn_trade_types_uncovered"]
        if unc:
            L.append(f"- ⚠️ {len(unc)} CN trade type(s) NOT in client map "
                     f"(naming mismatch or client missed): {_trunc(unc, 20)}")
            warnings.append(f"item bases: {len(unc)} CN trade type string(s) "
                            f"not covered by client map — see report.")
        else:
            L.append("- ✅ every CN trade `type` string is covered by the client map.")
    L.append("")

    # filters (filter-panel chrome)
    fl = cov["filters"]
    L.append("## filters  (filter-panel chrome, id-join 3 levels — robust)")
    L.append(f"- section titles: {fl['groups']}, named filters: {fl['filters']}, "
             f"dropdown options: {fl['options']} (+{fl['options_by_zh']} zh→en fallbacks)")
    L.append("")

    # leagues
    lg = cov["leagues"]
    L.append("## leagues  (position-join — FRAGILE)")
    L.append(f"- counts: intl {lg['intl_count']}, cn {lg['cn_count']} — "
             f"{'✅ match' if lg['count_match'] else '⚠️ MISMATCH'}")
    if lg["count_match"]:
        L.append("")
        L.append("| en | zh |")
        L.append("| --- | --- |")
        for p in dict_obj["leagues"]:
            L.append(f"| {p['en']} | {p['zh']} |")
    else:
        warnings.append("leagues: count mismatch — position-join skipped; "
                        "leagues left empty. Map them manually.")
        L.append(f"- intl: {lg['intl_list']}")
        L.append(f"- cn:   {lg['cn_list']}")
    L.append("")

    # diff vs previous
    L.append("## diff vs previous build")
    if prev is None:
        L.append("- no previous dict.json found (first build).")
    else:
        for label, path in [
            ("stats.entries", ["stats", "entries"]),
            ("static.entries", ["static", "entries"]),
            ("stats.groups", ["stats", "groups"]),
        ]:
            d = diff_keys(prev, dict_obj, path)
            if d["added"] or d["removed"]:
                L.append(f"- **{label}**: +{len(d['added'])} added, "
                         f"-{len(d['removed'])} removed")
                if d["added"]:
                    L.append(f"    - added: {_trunc(d['added'])}")
                if d["removed"]:
                    L.append(f"    - removed: {_trunc(d['removed'])}")
            else:
                L.append(f"- {label}: no id changes")
        # items/leagues compare by en string set
        prev_bases = {b["en"] for b in prev.get("items", {}).get("bases", [])}
        new_bases = {b["en"] for b in dict_obj["items"]["bases"]}
        L.append(f"- items.bases: +{len(new_bases - prev_bases)} / "
                 f"-{len(prev_bases - new_bases)} (by en name)")
    L.append("")

    # warnings summary at top-of-mind
    L.append("## ⚠️ warnings")
    if warnings:
        for w in warnings:
            L.append(f"- {w}")
    else:
        L.append("- none.")
    L.append("")

    return "\n".join(L), warnings


# --- runtime dict + userscript emission -------------------------------------

def build_runtime_dict(dict_obj: dict) -> dict:
    """Slim, display-only map for the userscript: zh/id -> en, one direction."""
    stats = dict_obj["stats"]
    static = dict_obj["static"]
    items = dict_obj["items"]
    filters = dict_obj["filters"]
    # zh stat template (with #) -> stat id, for reverse-matching rendered result
    # mods that lack a stat hash. First id wins on duplicate zh text.
    stats_by_zh: dict[str, str] = {}
    for k, v in stats["entries"].items():
        if v.get("zh") and v.get("en"):
            stats_by_zh.setdefault(v["zh"], k)
    return {
        "stats": {k: v["en"] for k, v in stats["entries"].items() if v.get("en")},
        "statsByZh": stats_by_zh,
        "statGroups": {k: v["en"] for k, v in stats["groups"].items() if v.get("en")},
        "static": {k: v["en"] for k, v in static["entries"].items() if v.get("en")},
        "items": {b["zh"]: b["en"] for b in items["bases"]
                  if b.get("zh") and b.get("en")},
        "itemCategories": {k: v["en"] for k, v in items["categories"].items()
                           if v.get("en")},
        "itemClasses": {c["zh"]: c["en"] for c in items["classes"]
                        if c.get("zh") and c.get("en") and c["zh"] != c["en"]},
        "leagues": {p["zh"]: p["en"] for p in dict_obj["leagues"]
                    if p.get("zh") and p.get("en")},
        "filterGroups": {k: v["en"] for k, v in filters["groups"].items()
                         if v.get("en")},
        "filters": {k: v["en"] for k, v in filters["filters"].items()
                    if v.get("en")},
        "filterOptions": {k: v["en"] for k, v in filters["options"].items()
                          if v.get("en")},
        "filterOptionsByZh": filters["options_by_zh"],
        **_skill_runtime_maps(),
        # full stat-description templates (gem/skill stats + mods); the userscript
        # builds a normalized lookup Map from these at startup.
        "statLines": load_client_list(STAT_LINES_PATH) or [],
        # localized unique item names (Words.Text2) zh -> en, for the find-items
        # list + outgoing-query reverse-mapping.
        "uniques": {zh: en for zh, en in (load_client_list(UNIQUE_NAMES_PATH) or [])
                    if zh and en},
        # en -> zh for the display sections (filters/static/categories/leagues/
        # stat groups) so the userscript can seed its reverse maps at startup and
        # peek/search-reverse work even when the site serves data/* from its cache.
        "revSeed": _rev_seed(dict_obj),
    }


def _rev_seed(dict_obj: dict) -> dict:
    rev: dict[str, str] = {}

    def add(en, zh):
        if en and zh and en != zh:
            rev.setdefault(en, zh)

    for v in dict_obj["static"]["entries"].values():
        add(v.get("en"), v.get("zh"))
    for v in dict_obj["stats"]["groups"].values():
        add(v.get("en"), v.get("zh"))
    f = dict_obj["filters"]
    for sect in ("groups", "filters", "options"):
        for v in f[sect].values():
            add(v.get("en"), v.get("zh"))
    for v in dict_obj["items"]["categories"].values():
        add(v.get("en"), v.get("zh"))
    for p in dict_obj["leagues"]:
        add(p.get("en"), p.get("zh"))
    return rev


def _skill_runtime_maps() -> dict:
    """zh->en maps for gem/skill names and (markup-stripped) descriptions."""
    skills = load_client_list(SKILL_TEXT_PATH) or []
    names: dict[str, str] = {}
    descs: dict[str, str] = {}
    for r in skills:
        zn, en = r.get("zh_name"), r.get("en_name")
        if zn and en and zn != en:
            names.setdefault(zn, en)
        zd, ed = strip_tags(r.get("zh_desc")), strip_tags(r.get("en_desc"))
        if zd and ed and zd != ed:
            descs.setdefault(zd, ed)
    return {"skillNames": names, "skillDesc": descs}


def emit_userscript(runtime: dict, version: str, meta: dict) -> bool:
    """Inject the runtime dict + meta into the userscript template. True if written."""
    if not TEMPLATE_PATH.exists():
        print(f"[build_dict] template missing ({TEMPLATE_PATH}); skipping userscript.",
              file=sys.stderr)
        return False
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    payload = json.dumps(runtime, ensure_ascii=False, separators=(",", ":"))
    meta_json = json.dumps(meta, ensure_ascii=False)
    # Replace small tokens first so a token can't accidentally match inside the
    # large data payload; inject the dict last.
    out = (template.replace("__META__", meta_json)
                   .replace("__VERSION__", version)
                   .replace("__DICT__", payload))
    USERSCRIPT_PATH.write_text(out, encoding="utf-8")
    return True


# --- main -------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Build en<->zh PoE2 trade dictionary.")
    ap.add_argument("--offline", action="store_true",
                    help="rebuild from cached raw/ responses (no network).")
    ap.add_argument("--timeout", type=int, default=30,
                    help="HTTP timeout seconds (default 30).")
    args = ap.parse_args()

    mode = "offline (cache)" if args.offline else "live fetch"
    print(f"[build_dict] mode: {mode}")
    try:
        data = get_all(args.offline, args.timeout)
    except (urllib.error.URLError, FileNotFoundError) as e:
        print(f"[build_dict] FATAL: {e}", file=sys.stderr)
        return 2

    stats, stats_cov = join_id(data["stats"]["intl"], data["stats"]["cn"])
    static, static_cov = join_id(data["static"]["intl"], data["static"]["cn"])
    categories, cats_cov, cn_types = join_item_categories(
        data["items"]["intl"], data["items"]["cn"])
    item_section, item_bases_cov = build_item_bases(cn_types)
    leagues, leagues_cov = join_leagues(data["leagues"]["intl"], data["leagues"]["cn"])
    filters, filters_cov = join_filters(data["filters"]["intl"], data["filters"]["cn"])

    items = {
        "categories": categories,
        "bases": item_section["bases"],
        "classes": item_section["classes"],
        "source": item_section["source"],
    }

    coverage = {
        "stats": stats_cov,
        "static": static_cov,
        "items": cats_cov,
        "item_bases": item_bases_cov,
        "leagues": leagues_cov,
        "filters": filters_cov,
    }

    prev = load_previous_dict()

    dict_obj = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "mode": mode,
            "hosts": HOSTS,
            "join_strategy": {
                "stats": "id", "static": "id",
                "item_categories": "id (trade endpoint)",
                "item_bases": "metadata-Id (client extract)",
                "leagues": "position", "filters": "id (3 levels)",
            },
        },
        "stats": stats,
        "static": static,
        "items": items,
        "leagues": leagues,
        "filters": filters,
    }

    report_text, warnings = write_report(coverage, dict_obj, prev)

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    DICT_PATH.write_text(json.dumps(dict_obj, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    REPORT_PATH.write_text(report_text, encoding="utf-8")

    # slim runtime dict + installable userscript
    runtime = build_runtime_dict(dict_obj)
    RUNTIME_PATH.write_text(json.dumps(runtime, ensure_ascii=False),
                            encoding="utf-8")
    version = datetime.now(timezone.utc).strftime("%Y.%m.%d.%H%M")
    meta = {
        "version": version,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "counts": {
            "stats": len(runtime["stats"]),
            "items": len(runtime["items"]),
            "statLines": len(runtime["statLines"]),
            "skillDesc": len(runtime["skillDesc"]),
            "filters": len(runtime["filters"]),
            "leagues": len(runtime["leagues"]),
        },
    }
    wrote_us = emit_userscript(runtime, version, meta)

    # console summary
    print(f"[build_dict] wrote {DICT_PATH}")
    print(f"[build_dict] wrote {REPORT_PATH}")
    print(f"[build_dict] wrote {RUNTIME_PATH}")
    if wrote_us:
        print(f"[build_dict] wrote {USERSCRIPT_PATH} (v{version})")
    print(f"[build_dict] stats entries: {stats_cov['matched_entries']}, "
          f"static entries: {static_cov['matched_entries']}, "
          f"item bases: {len(items['bases'])}, "
          f"item categories: {cats_cov['matched_categories']}, "
          f"leagues: {len(leagues)}")
    if warnings:
        print("[build_dict] WARNINGS:")
        for w in warnings:
            print(f"  - {w}")
    else:
        print("[build_dict] no warnings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
