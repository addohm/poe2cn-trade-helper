#!/usr/bin/env python3
"""Offline simulation of the userscript's data-layer translation: apply the
runtime dict to the cached CN /api/trade2/data/* responses and report coverage
(what fraction of what the CN site actually shows would render in English)."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
rt = json.loads((HERE / "dist" / "dict.runtime.json").read_bytes().decode("utf-8"))
raw = lambda n: json.loads((HERE / "raw" / n).read_bytes().decode("utf-8"))


def cov(name, total, hit, samples):
    pct = 100 * hit / total if total else 0
    print(f"{name:16} {hit}/{total} ({pct:.1f}%)")
    for zh, en in samples[:3]:
        print(f"    {zh}  ->  {en}")


# stats: key by entry id
s = raw("cn_stats.json")
tot = hit = 0
samp = []
for g in s["result"]:
    for e in g.get("entries", []):
        tot += 1
        en = rt["stats"].get(e["id"])
        if en:
            hit += 1
            if len(samp) < 3:
                samp.append((e["text"], en))
cov("stats", tot, hit, samp)

# static: key by entry id
st = raw("cn_static.json")
tot = hit = 0
samp = []
for g in st["result"]:
    for e in g.get("entries", []):
        tot += 1
        en = rt["static"].get(e["id"])
        if en:
            hit += 1
            if len(samp) < 3:
                samp.append((e["text"], en))
cov("static", tot, hit, samp)

# items: key by entry type (zh)
it = raw("cn_items.json")
tot = hit = 0
samp = []
for g in it["result"]:
    for e in g.get("entries", []):
        tot += 1
        en = rt["items"].get(e.get("type"))
        if en:
            hit += 1
            if len(samp) < 3:
                samp.append((e["type"], en))
cov("item bases", tot, hit, samp)

# item categories: key by group id
tot = hit = 0
samp = []
for g in it["result"]:
    tot += 1
    en = rt["itemCategories"].get(g["id"])
    if en:
        hit += 1
        if len(samp) < 3:
            samp.append((g.get("label"), en))
cov("item categories", tot, hit, samp)

# leagues: key by text (zh)
lg = raw("cn_leagues.json")
tot = hit = 0
samp = []
for e in lg["result"]:
    tot += 1
    en = rt["leagues"].get(e["text"])
    if en:
        hit += 1
        samp.append((e["text"], en))
cov("leagues", tot, hit, samp)
