#!/usr/bin/env python3
"""Mirror the userscript's tText() priority logic in Python to sanity-check the
DOM translation of chrome / gem-tooltip / league strings against real samples."""
import json, re
from pathlib import Path

d = json.loads((Path(__file__).resolve().parent / "dist" / "dict.runtime.json")
               .read_bytes().decode("utf-8"))
stats, byzh, items, classes, leagues = (
    d["stats"], d["statsByZh"], d["items"], d["itemClasses"], d["leagues"])
skill_names, skill_desc = d["skillNames"], d["skillDesc"]
NUM = re.compile(r"-?\d+(?:\.\d+)?")
CJK = re.compile(r"[一-鿿]")

# subset of the userscript's CHROME map relevant to the samples
CHROME = {"需求": "Requires", "消耗": "Cost", "施放时间": "Cast Time", "法术": "Spell",
          "物理": "Physical", "等级": "Level", "物品等级": "Item Level"}
SUBSTR = {"《流放之路：降临》": "Path of Exile 2", "流放之路：降临": "Path of Exile 2", **leagues}
PATTERNS = [
    (re.compile(r"^等级\s*(\d+)\s+(\S.*)$"),
     lambda m: "Level " + m[1] + " " + (items.get(m[2], m[2]))),
    (re.compile(r"^消耗[:：]\s*(\d+)\s*点?(?:魔力|法力)$"), lambda m: "Cost: " + m[1] + " Mana"),
    (re.compile(r"^施放时间[:：]\s*([\d.]+)\s*秒$"), lambda m: "Cast Time: " + m[1] + "s"),
    (re.compile(r"^(\d+)\s*点\s*(?:魔力|法力)$"), lambda m: m[1] + " Mana"),
    (re.compile(r"^([\d.]+)\s*秒$"), lambda m: m[1] + "s"),
    (re.compile(r"^(?:上架\s*)?(\d+)\s*天前$"),
     lambda m: ("Listed " if "上架" in m[0] else "") + m[1] + "d ago"),
]


def fill(en, src):
    nums = iter(NUM.findall(src))
    return re.sub("#", lambda _: next(nums, "#"), en)


def translate_mod(k):
    sid = byzh.get(NUM.sub("#", k))
    return fill(stats[sid], k) if sid and sid in stats else k


# --- StatDescriptions matcher (mirrors the userscript) ---
_PH = re.compile(r"\{(\d+)\}")
_statmap = {}
for zh, en in d["statLines"]:
    key = _PH.sub("#", zh)
    key = NUM.sub("#", key)
    _statmap.setdefault(key, []).append((zh, en))


def translate_stat_line(rendered):
    cands = _statmap.get(NUM.sub("#", rendered))
    if not cands:
        return None
    for zh, en in cands:
        order, parts, last = [], "", 0
        for m in _PH.finditer(zh):
            parts += re.escape(zh[last:m.start()]) + r"([+-]?\d[\d.,]*)"
            order.append(int(m.group(1)))
            last = m.end()
        parts += re.escape(zh[last:])
        mt = re.match("^" + parts + "$", rendered)
        if mt:
            val = {order[q]: mt.group(q + 1) for q in range(len(order))}
            return _PH.sub(lambda mm: val.get(int(mm.group(1)), mm.group(0)), en)
    return None


def ttext(k):
    if not CJK.search(k):
        return k + "  (skip: no CJK)"
    if k in CHROME:
        return CHROME[k]
    cm = re.match(r"^(.*?)\s*([：:])$", k)
    if cm and cm[1] in CHROME:
        return CHROME[cm[1]] + cm[2]
    for re_, fn in PATTERNS:
        m = re_.match(k)
        if m:
            return fn(m)
    if len(k) <= 32 and (k in items or k in classes or k in skill_names):
        return items.get(k) or classes.get(k) or skill_names.get(k)
    if k in skill_desc:
        return skill_desc[k]
    sl = translate_stat_line(k)
    if sl is not None:
        return sl
    mod = translate_mod(k)
    if mod != k:
        return mod
    out = k
    for zh, en in SUBSTR.items():
        out = out.replace(zh, en)
    return out if out != k else k + "  (no match)"


for s in ["等级 10 力量抽取", "魔力吸取",
          "在一段时间内从敌人身上偷取法力，同时短暂缓速其行动。",
          "0 点魔力", "0.85 秒", "消耗: 0 点魔力",
          "造成 26 - 49 物理伤害", "偷取 96 魔力", "魔力偷取速度减慢 70%",
          "终结时有 36% 的几率获得一个额外的暴击球",
          "需求：", "物品等级", "《流放之路：降临》 - 奥杜尔秘符",
          "上架 7天前", "Power Siphon"]:
    print(repr(s), "->", ttext(s))
