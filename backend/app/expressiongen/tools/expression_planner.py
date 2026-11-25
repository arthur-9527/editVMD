#!/usr/bin/env python3
"""规则 Planner：自然语言 -> 表情 DSL（P0 冷启动，不依赖任何模型）。

流程：括号提取 -> 非对称检测 -> 分段 -> label_text 拿原子 -> 词法补节奏/重复/并行

三条实测修正
------------
1. 非对称句（「缓缓闭上眼，又猛地睁开」）**整句规划、不切段**：
   切段后 attack/release 分别落在两段里，节奏信息会丢。
2. `label_text` 词表未覆盖的口语（「挑了下眉」「垂下眼帘」）用
   `EXTRA_PATTERNS` 兜底，避免产出空 DSL。
3. 同槽冲突交给 `expression_dsl` 的校验器裁决（本层不处理）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
for p in (str(HERE), str(ROOT / "tools")):
    if p not in sys.path:
        sys.path.insert(0, p)

import expression_dsl as ed  # noqa: E402
import expression_schema as es  # noqa: E402

TEMPO_WORDS = {
    "very_slow": ("缓缓", "缓慢", "徐徐", "慢悠悠", "慢吞吞"),
    "slow": ("慢慢", "轻轻", "悄悄", "微微", "轻柔"),
    "fast": ("快速", "迅速", "连忙", "急忙", "赶紧", "飞快", "匆匆"),
    "very_fast": ("猛地", "突然", "骤然", "唰地", "一下子", "猝然", "霍地"),
}

# 事件型 morph（短生命周期 → 适合 repeat / 非对称包络）。
# 由 `expression_schema.MORPH_TIMING` 推导，不再手写白名单：
#   判据 = attack + hold + release ≤ GESTURE_MAX_LIFE
GESTURE_MAX_LIFE = 20
GESTURE_MORPHS: frozenset[str] = frozenset(
    m for m in es.ATOMS if sum(es.morph_timing(m)) <= GESTURE_MAX_LIFE)

PAR_SPLIT_RE = re.compile(r"一边(.+?)一边(.+)")

_SLOW = ("缓缓", "缓慢", "慢慢", "徐徐", "轻轻")
_FAST = ("猛地", "快速", "迅速", "突然", "一下子", "骤然")
_CLOSE = ("闭眼", "闭上眼", "合眼", "合上眼", "闭了闭", "闭上双眼",
          "闭起眼", "眯起眼", "眯上眼", "垂眸", "垂下眼帘")

# `expression_schema` 词表未覆盖时的兜底（只在该层用，不改 schema）
EXTRA_PATTERNS = (
    (re.compile(r"挑.{0,3}眉|扬.{0,3}眉|抬.{0,3}眉|眉.{0,3}挑"), "brow", "上"),
    (re.compile(r"皱眉|蹙眉|拧眉|眉头.{0,3}皱"), "brow", "怒り"),
    (re.compile(r"垂.{0,4}眼帘|眼帘.{0,4}垂|低垂.{0,3}眼"), "eyeOpen", "なごみ"),
    (re.compile(r"叹.{0,3}气"), "eyeOpen", "じと目"),
    (re.compile(r"睁.{0,3}眼|睁大"), "eyeOpen", "びっくり"),
    (re.compile(r"翻.{0,3}白眼|白眼"), "eyeOpen", "ジト目"),
    (re.compile(r"撇嘴|嘴角.{0,3}下"), "mouth", "口角下げ"),
    (re.compile(r"嘟嘴|撅嘴|嘟起嘴"), "mouth", "口横狭め"),
    (re.compile(r"龇牙|咧嘴"), "mouth", "にやり３"),
    (re.compile(r"吐.{0,3}舌"), "mouth", "ぺろっ"),
    (re.compile(r"笑"), "mouth", "口角上げ"),
)


def detect_tempo(text: str) -> str:
    for tempo in ("very_slow", "slow", "fast", "very_fast"):
        if any(w in text for w in TEMPO_WORDS[tempo]):
            return tempo
    return "normal"


def detect_repeat(text: str) -> tuple[int, int]:
    """文本 -> (重复次数, 间隔帧)。与 `expression_schema.detect_repeat` 同源。"""
    return es.detect_repeat(text)


def detect_asym(text: str) -> tuple[int, int] | None:
    """缓慢闭眼 + 快速睁开 -> (慢 attack, 快 release)。"""
    if (any(w in text for w in _SLOW) and any(w in text for w in _FAST)
            and any(w in text for w in _CLOSE)):
        return ed.TEMPO["slow"]["attack"], ed.TEMPO["very_fast"]["release"]
    return None


def _extra_atoms(text: str) -> list[str]:
    slots: dict[str, str] = {}
    for pat, slot, atom in EXTRA_PATTERNS:
        if slot not in slots and pat.search(text):
            slots[slot] = atom
    return [slots[s] for s in es.SLOTS if s in slots]


def _stage_content(text: str) -> str:
    try:
        from expression_engine import extract_stage_content
        return extract_stage_content(text)
    except Exception:  # noqa: BLE001
        return (text or "").strip()


def _segments(text: str) -> list[str]:
    try:
        from stage_segmenter import split_stage
        segs = [s for s in split_stage(text) if s]
    except Exception:  # noqa: BLE001
        segs = []
    return segs or [text]


def plan_with_atoms(seg: str, atoms: list[str],
                    asym: tuple[int, int] | None = None):
    """用**给定** atoms 构造一个 segment（教师数据用，避免 label_text 重标）。"""
    atoms = [a for a in (atoms or []) if a in es.ATOM_SLOT]
    if not atoms:
        return None
    tempo = detect_tempo(seg)
    repeat, gap = detect_repeat(seg)
    if asym is None:
        asym = detect_asym(seg)
    kids = []
    for a in atoms:
        is_gesture = a in GESTURE_MORPHS
        kw = {"tempo": tempo, "peak": 1.0}
        if asym and is_gesture and any(w in seg for w in _CLOSE):
            kw.update(attack=asym[0], hold=1, release=asym[1])
        if is_gesture and repeat > 1:
            kw.update(repeat=repeat, gap=gap)
        kids.append(ed.morph_node(a, **kw))
    return kids[0] if len(kids) == 1 else ed.par_node(kids)


def plan_segment(seg: str, asym: tuple[int, int] | None = None):
    lab = es.label_text(seg)
    atoms = [a for a in lab["atoms"] if a in es.ATOM_SLOT]
    if not atoms:
        atoms = _extra_atoms(seg)
    if not atoms:
        return None
    tempo = detect_tempo(seg)
    repeat, gap = detect_repeat(seg)
    if asym is None:
        asym = detect_asym(seg)
    peak = min(1.0, max(0.0, float(lab["intensity"])))
    kids = []
    for a in atoms:
        is_gesture = a in GESTURE_MORPHS
        kw = {"tempo": tempo, "peak": peak}
        if asym and is_gesture and any(w in seg for w in _CLOSE):
            kw.update(attack=asym[0], hold=1, release=asym[1])
        if is_gesture and repeat > 1:
            kw.update(repeat=repeat, gap=gap)
        kids.append(ed.morph_node(a, **kw))
    if not kids:
        return None
    return kids[0] if len(kids) == 1 else ed.par_node(kids)


def plan_text(text: str) -> dict:
    content = _stage_content(text)
    asym = detect_asym(content)
    # 非对称句整句规划：切段会把 attack/release 拆散
    if asym:
        node = plan_segment(content, asym)
        if node:
            return {"fps": ed.FPS, "source": "rule-asym", "text": text,
                    "nodes": [node]}

    nodes = []
    for seg in _segments(content):
        m = PAR_SPLIT_RE.search(seg)
        if m:
            subs = [m.group(1).strip(), m.group(2).strip()]
            kids = [k for k in (plan_segment(s) for s in subs) if k]
            if kids:
                nodes.append(kids[0] if len(kids) == 1 else ed.par_node(kids))
                continue
        node = plan_segment(seg)
        if node:
            nodes.append(node)
    if len(nodes) > 1:
        top = ed.seq_node(nodes, gap=2)
    elif nodes:
        top = nodes[0]
    else:
        top = {"op": "seq", "gap": 0, "children": []}
    return {"fps": ed.FPS, "source": "rule", "text": text, "nodes": [top]}


def main() -> int:
    ap = argparse.ArgumentParser(description="规则 Planner：文本 -> 表情 DSL")
    ap.add_argument("text")
    ap.add_argument("--frames", type=int, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    dsl = plan_text(args.text)
    res = ed.compile_dsl(dsl, total_frames=args.frames or None)
    if args.out:
        p = ed.write_vmd(res, args.out)
        print("VMD", p, "frames", res["duration_frames"],
              "morph_keys", res["morph_keys"], "warn", res["warnings"])
    if args.json or not args.out:
        print(json.dumps({"dsl": dsl, "tracks": res["tracks"],
                          "duration_frames": res["duration_frames"],
                          "warnings": res["warnings"]},
                         ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
