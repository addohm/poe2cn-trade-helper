#!/usr/bin/env python3
"""Offline check of the userscript's result-mod translation (zh-pattern fallback
path) against real affix lines, mirroring the JS fillNums/translateMod logic."""
import json, re
from pathlib import Path

d = json.loads((Path(__file__).resolve().parent / "dist" / "dict.runtime.json")
               .read_bytes().decode("utf-8"))
stats, byzh = d["stats"], d["statsByZh"]
NUM = re.compile(r"-?\d+(?:\.\d+)?")


def fill(en, rendered):
    nums = iter(NUM.findall(rendered))
    return re.sub("#", lambda m: next(nums, "#"), en)


def tmod(r):
    sid = byzh.get(NUM.sub("#", r))
    if sid and sid in stats:
        return fill(stats[sid], r)
    return "(no match)  norm=" + NUM.sub("#", r)


for t in ["+10% 暴击伤害加成", "附加 25 - 29 物理伤害", "攻击速度提高 10%",
          "此武器粉碎相当于击中伤害 40% 的护甲", "物品稀有度提高 15%",
          "最大生命 +59", "+59 最大生命"]:
    print(repr(t), "->", tmod(t))
