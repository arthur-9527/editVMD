#!/usr/bin/env python3
"""从 DSL 提取「样本级」多任务标签（P1-A 训练 / 评测共用）。

每个样本 -> 六个标签
--------------------
  morph   所有叶子 morph 去重（multi-hot，36 维含 neutral）
  tempo   由叶子 attack 反推（very_slow/slow/normal/fast/very_fast）
  repeat  max(repeat)，三档：1 / 2 / 3(>=3)
  layout  顶层结构：single / seq / par
  asym    是否存在非对称包络（attack 与 release 相差 >= 2 倍）
  peak    叶子 peak 众数（0.5 / 1.0）

约定
----
  · tempo 由 attack 反推（非对称样本 attack 慢 -> slow），与 asym 解耦；
  · layout 只看顶层：`nodes` 多于一个或顶层是 seq -> seq；顶层是 par -> par；
    单个 morph -> single。
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import expression_dsl as ed  # noqa: E402
import expression_schema as es  # noqa: E402

TEMPO_NAMES: tuple[str, ...] = ("very_slow", "slow", "normal", "fast",
                                "very_fast")
TEMPO_INDEX: dict[str, int] = {n: i for i, n in enumerate(TEMPO_NAMES)}
LAYOUTS: tuple[str, ...] = ("single", "seq", "par")
LAYOUT_INDEX: dict[str, int] = {n: i for i, n in enumerate(LAYOUTS)}
REPEATS: tuple[int, ...] = (1, 2, 3)          # 3 表示 >=3
PEAKS: tuple[float, ...] = (0.5, 1.0)


def walk_morphs(node: dict | None) -> list[dict]:
    """深度优先收集所有 morph 叶子。"""
    if not node:
        return []
    op = node.get("op")
    if op == "morph":
        return [node]
    if op == "repeat":
        return walk_morphs(node.get("child"))
    return [m for c in (node.get("children") or []) for m in walk_morphs(c)]


def tempo_of(node: dict) -> str:
    """按 attack 匹配最近的节奏档（非对称样本落到慢档）。"""
    atk = int(node.get("attack", 4))
    return min(TEMPO_NAMES, key=lambda n: abs(ed.TEMPO[n]["attack"] - atk))


def repeat_class(value: int) -> int:
    v = max(1, int(value))
    return 3 if v >= 3 else v


def extract_labels(dsl: dict) -> dict:
    nodes = dsl.get("nodes") or []
    leaves: list[dict] = []
    for n in nodes:
        leaves += walk_morphs(n)

    seen: set[str] = set()
    morphs: list[str] = []
    for n in leaves:
        m = n.get("morph")
        if m in es.ATOM_SLOT and m not in seen:
            seen.add(m)
            morphs.append(m)
    morphs.sort(key=lambda m: (es.SLOTS.index(es.ATOM_SLOT[m]), m))

    if leaves:
        tempo = Counter(tempo_of(n) for n in leaves).most_common(1)[0][0]
        repeat = repeat_class(max(int(n.get("repeat", 1)) for n in leaves))
        asym = int(any(int(n["attack"]) >= 2 * int(n["release"])
                       or int(n["release"]) >= 2 * int(n["attack"])
                       for n in leaves))
        peak = Counter(round(float(n.get("peak", 1.0)), 3)
                       for n in leaves).most_common(1)[0][0]
    else:
        tempo, repeat, asym, peak = "normal", 1, 0, 1.0

    if len(nodes) > 1:
        layout = "seq"
    elif nodes and nodes[0].get("op") == "par":
        layout = "par"
    elif nodes and nodes[0].get("op") == "seq":
        layout = "seq"
    else:
        layout = "single"

    if not morphs:
        morphs = [es.NEUTRAL]
    return {"morphs": morphs, "tempo": tempo, "repeat": repeat,
            "layout": layout, "asym": asym,
            "peak": 1.0 if abs(peak - 1.0) < 0.26 else 0.5}


# ---------------------------------------------------------------- 统计 / CLI


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def stats(rows: list[dict]) -> dict:
    tempo = Counter()
    repeat = Counter()
    layout = Counter()
    asym = Counter()
    peak = Counter()
    n_morph = Counter()
    neutral = 0
    for r in rows:
        lab = extract_labels(r["dsl"])
        tempo[lab["tempo"]] += 1
        repeat[lab["repeat"]] += 1
        layout[lab["layout"]] += 1
        asym[lab["asym"]] += 1
        peak[lab["peak"]] += 1
        n = len(lab["morphs"])
        n_morph[n] += 1
        if lab["morphs"] == [es.NEUTRAL]:
            neutral += 1
    return {"n": len(rows), "tempo": dict(tempo), "repeat": dict(repeat),
            "layout": dict(layout), "asym": dict(asym), "peak": dict(peak),
            "n_morphs": dict(sorted(n_morph.items())), "neutral": neutral}


def main() -> int:
    ap = argparse.ArgumentParser(description="DSL 标签统计")
    ap.add_argument("path", nargs="?",
                    default=str(ROOT / "data" / "model" / "expression"
                                / "dsl_v1.jsonl"))
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    rows = load_jsonl(Path(args.path))
    if args.limit:
        rows = rows[: args.limit]
    print(json.dumps(stats(rows), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
