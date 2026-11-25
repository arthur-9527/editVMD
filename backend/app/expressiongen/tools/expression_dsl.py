#!/usr/bin/env python3
"""表情 DSL：可执行的「表情编排语言」+ 校验器 + 编译器（P0）。

    文本 --Planner--> DSL --Compiler--> 稀疏关键帧
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import expression_schema as es  # noqa: E402

FPS = 30
MIN_NODE_FRAMES = 4

TEMPO = {
    "very_slow": {"attack": 14, "hold": 4, "release": 12},
    "slow":      {"attack": 10, "hold": 3, "release": 8},
    "normal":    {"attack": 6,  "hold": 4, "release": 6},
    "fast":      {"attack": 3,  "hold": 2, "release": 3},
    "very_fast": {"attack": 2,  "hold": 1, "release": 2},
}
TEMPO_ORDER = ("very_slow", "slow", "normal", "fast", "very_fast")

# 节奏词对「典型生命周期」的缩放（`normal` = ×1.0）。
# 默认生命周期来自 `expression_schema.MORPH_TIMING`（每个 morph 不一样），
# tempo 只负责整体快慢；显式 attack/hold/release 参数优先级最高。
TEMPO_SCALE = {
    "very_slow": 1.8, "slow": 1.4, "normal": 1.0, "fast": 0.7, "very_fast": 0.5,
}


def envelope(tempo="normal", *, peak=1.0, attack=None, hold=None, release=None,
             base=None):
    """包络 `{attack, hold, release, peak}`。

    `base=(a,h,r)` 是该 morph 的典型生命周期（通常来自 `MORPH_TIMING`），
    `tempo` 对它整体缩放；显式 `attack/hold/release` 直接覆盖（不缩放）。
    缺省 `base` 时退回 `TEMPO["normal"]`（旧行为）。
    """
    key = str(tempo).strip().lower()
    s = TEMPO_SCALE.get(key, 1.0)
    if base is None:
        n = TEMPO["normal"]
        base = (n["attack"], n["hold"], n["release"])
    a0, h0, r0 = base
    a = int(attack) if attack is not None else max(1, int(round(a0 * s)))
    h = int(hold) if hold is not None else max(1, int(round(h0 * s)))
    r = int(release) if release is not None else max(1, int(round(r0 * s)))
    return {"attack": max(1, a), "hold": max(1, h),
            "release": max(1, r), "peak": float(peak)}


def morph_node(morph, *, tempo="normal", peak=1.0, attack=None, hold=None,
               release=None, repeat=1, gap=0):
    name = str(morph).strip()
    env = envelope(tempo, peak=peak, attack=attack, hold=hold,
                   release=release, base=es.morph_timing(name))
    return {"op": "morph", "morph": name,
            "slot": es.ATOM_SLOT.get(name, ""),
            **env,
            "repeat": max(1, int(repeat)), "gap": max(0, int(gap))}


def seq_node(children, gap=0):
    return {"op": "seq", "gap": max(0, int(gap)),
            "children": [c for c in children if c]}


def par_node(children):
    return {"op": "par", "children": [c for c in children if c]}


def repeat_node(child, times=2, gap=0):
    return {"op": "repeat", "times": max(1, int(times)),
            "gap": max(0, int(gap)), "child": child}


def dsl_frames(nodes):
    return sum(_node_frames(n) for n in (nodes or []))


def _node_frames(node):
    if not node:
        return 0
    op = node.get("op")
    if op == "morph":
        dur = node["attack"] + node["hold"] + node["release"]
        times = max(1, node.get("repeat", 1))
        return times * dur + (times - 1) * node.get("gap", 0)
    if op == "seq":
        ch = node.get("children") or []
        return sum(_node_frames(c) for c in ch) + max(0, len(ch) - 1) * node.get("gap", 0)
    if op == "par":
        return max((_node_frames(c) for c in (node.get("children") or [])), default=0)
    if op == "repeat":
        d = _node_frames(node.get("child"))
        times = max(1, node.get("times", 1))
        return times * d + (times - 1) * node.get("gap", 0)
    return 0


def _collect_morphs(node):
    if not node:
        return []
    if node.get("op") == "morph":
        return [node]
    if node.get("op") == "repeat":
        return _collect_morphs(node.get("child"))
    return [m for c in (node.get("children") or []) for m in _collect_morphs(c)]


def _slots_of(node):
    return {m.get("slot") or es.ATOM_SLOT.get(m.get("morph"), "")
            for m in _collect_morphs(node)} - {""}


def _fix_morph(node, warnings):
    name = str(node.get("morph") or "").strip()
    if name not in es.ATOM_SLOT:
        warnings.append("unknown_morph:" + name)
        return None
    atk = max(1, int(node.get("attack", 6)))
    hold = es.clamp_hold(node.get("hold", 4))
    rel = max(1, int(node.get("release", 6)))
    if atk + hold + rel < MIN_NODE_FRAMES:
        hold = MIN_NODE_FRAMES - atk - rel
        if hold < 1:
            warnings.append("node_too_short:" + name)
            return None
        warnings.append("node_padded:" + name)
    peak = min(1.0, max(0.0, float(node.get("peak", 1.0))))
    if peak <= 1e-6:
        warnings.append("zero_peak:" + name)
        return None
    return {"op": "morph", "morph": name, "slot": es.ATOM_SLOT[name],
            "attack": atk, "hold": hold, "release": rel, "peak": peak,
            "repeat": max(1, int(node.get("repeat", 1))),
            "gap": max(0, int(node.get("gap", 0)))}


def _fix_node(node, warnings):
    if not node:
        return None
    op = node.get("op")
    if op == "morph":
        return _fix_morph(node, warnings)
    if op in ("seq", "par"):
        kids = [k for k in (_fix_node(c, warnings)
                            for c in (node.get("children") or [])) if k]
        if not kids:
            return None
        if len(kids) == 1:
            return kids[0]
        if op == "par":
            kept, moved, used = [], [], set()
            for k in kids:
                slots = _slots_of(k)
                if slots & used:
                    moved.append(k)
                    warnings.append("par_slot_conflict_to_seq")
                else:
                    kept.append(k)
                    used |= slots
            if not moved:
                return {"op": "par", "children": kept}
            head = (kept[0] if len(kept) == 1
                    else {"op": "par", "children": kept}) if kept else None
            return {"op": "seq", "gap": 0,
                    "children": ([head] if head else []) + moved}
        return {"op": "seq", "gap": max(0, int(node.get("gap", 0))),
                "children": kids}
    if op == "repeat":
        child = _fix_node(node.get("child"), warnings)
        if not child:
            return None
        return {"op": "repeat", "times": max(1, int(node.get("times", 1))),
                "gap": max(0, int(node.get("gap", 0))), "child": child}
    warnings.append("unknown_op:" + str(op))
    return None


def _scale_leaves(node, s):
    op = node.get("op")
    if op == "morph":
        n = dict(node)
        n["attack"] = max(1, int(round(node["attack"] * s)))
        n["hold"] = max(1, int(round(node["hold"] * s)))
        n["release"] = max(1, int(round(node["release"] * s)))
        n["gap"] = max(0, int(round(node.get("gap", 0) * s)))
        return n
    if op == "repeat":
        n = dict(node)
        n["gap"] = max(0, int(round(node.get("gap", 0) * s)))
        n["child"] = _scale_leaves(node["child"], s)
        return n
    n = dict(node)
    n["children"] = [_scale_leaves(c, s) for c in node.get("children") or []]
    if "gap" in n:
        n["gap"] = max(0, int(round(n["gap"] * s)))
    return n


def flat_to_tree(flat):
    """扁平 DSL（segments/clips）-> 树（nodes），供 Head/LLM Planner 共用。

    扁平格式（非递归，guided decoding 友好）：
        {"fps": 30, "segments": [
            {"layout": "par", "clips": [
                {"morph": "まばたき", "tempo": "fast", "repeat": 2, "gap": 3}
            ]}
        ]}
    `segments` 之间串行，段内按 `layout` 并行/串行。
    """
    segs = flat.get("segments") or []
    nodes = []
    for seg in segs:
        clips = []
        for c in (seg.get("clips") or []):
            clips.append(morph_node(
                c["morph"], tempo=c.get("tempo", "normal"),
                peak=c.get("peak", 1.0), attack=c.get("attack"),
                hold=c.get("hold"), release=c.get("release"),
                repeat=c.get("repeat", 1), gap=c.get("gap", 0)))
        if not clips:
            continue
        layout = str(seg.get("layout", "par")).strip().lower()
        if len(clips) == 1:
            nodes.append(clips[0])
        elif layout == "seq":
            nodes.append(seq_node(clips))
        else:
            nodes.append(par_node(clips))
    return {"fps": int(flat.get("fps", FPS)), "nodes": nodes,
            "source": flat.get("source", "flat")}


def validate_and_fix(dsl, *, total_frames=None):
    warnings = []
    nodes = [n for n in (_fix_node(c, warnings)
                         for c in (dsl.get("nodes") or [])) if n]
    if total_frames:
        nodes = _fit(nodes, max(1, int(total_frames)), warnings)
    seen, uniq = set(), []
    for w in warnings:
        if w not in seen:
            seen.add(w)
            uniq.append(w)
    return {"fps": int(dsl.get("fps", FPS)), "nodes": nodes}, uniq


def _fit(nodes, total, warnings):
    want = dsl_frames(nodes)
    if want <= total:
        return nodes
    s = total / float(max(1, want))
    out = [_scale_leaves(n, s) for n in nodes]
    if dsl_frames(out) > total:
        warnings.append("duration_scaled")
    return out


def _compile_node(node, cursor, tracks):
    op = node.get("op")
    if op == "morph":
        atk, hold, rel = node["attack"], node["hold"], node["release"]
        peak, name = node["peak"], node["morph"]
        times, gap = max(1, node.get("repeat", 1)), node.get("gap", 0)
        dur = atk + hold + rel
        for k in range(times):
            t0 = cursor + k * (dur + gap)
            tracks.setdefault(name, []).extend(
                [[t0, 0.0], [t0 + atk, peak],
                 [t0 + atk + hold, peak], [t0 + atk + hold + rel, 0.0]])
        return cursor + times * dur + (times - 1) * gap
    if op == "seq":
        cur, gap = cursor, node.get("gap", 0)
        kids = node.get("children") or []
        for i, c in enumerate(kids):
            cur = _compile_node(c, cur, tracks)
            if i < len(kids) - 1:
                cur += gap
        return cur
    if op == "par":
        return max((_compile_node(c, cursor, tracks)
                    for c in (node.get("children") or [])), default=cursor)
    if op == "repeat":
        cur, gap, times = cursor, node.get("gap", 0), max(1, node.get("times", 1))
        for k in range(times):
            cur = _compile_node(node["child"], cur, tracks)
            if k < times - 1:
                cur += gap
        return cur
    return cursor


def _merge(tracks):
    out = {}
    for name, keys in tracks.items():
        acc = {}
        for f, w in keys:
            acc[int(f)] = float(w)
        out[name] = [[f, round(acc[f], 4)] for f in sorted(acc)]
    return out


def compile_dsl(dsl, *, total_frames=None):
    if "segments" in dsl and "nodes" not in dsl:
        dsl = flat_to_tree(dsl)
    dsl2, warnings = validate_and_fix(dsl, total_frames=total_frames)
    tracks = {}
    end = 0
    for node in dsl2["nodes"]:
        end = _compile_node(node, end, tracks)
    tracks = _merge(tracks)
    total = int(total_frames) if total_frames else end
    return {"ok": True, "dsl": dsl2, "tracks": tracks, "end_frame": end,
            "duration_frames": total,
            "morph_keys": sum(len(v) for v in tracks.values()),
            "warnings": warnings}


def to_morph_records(tracks):
    return [(name, int(f), float(w))
            for name, keys in tracks.items() for f, w in keys]


def write_vmd(result, path, model_name="expression"):
    from vmd_export import write_vmd as _write
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    _write([], p, model_name=model_name,
           morphs=to_morph_records(result["tracks"]))
    return p


def main():
    ap = argparse.ArgumentParser(description="编译表情 DSL -> 稀疏关键帧 / VMD")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dsl")
    g.add_argument("--dsl-file")
    g.add_argument("--text")
    ap.add_argument("--frames", type=int, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.text:
        import expression_planner as ep
        dsl = ep.plan_text(args.text)
    else:
        raw = (Path(args.dsl_file).read_text(encoding="utf-8")
               if args.dsl_file else args.dsl)
        dsl = json.loads(raw)
    res = compile_dsl(dsl, total_frames=args.frames or None)
    if args.out:
        p = write_vmd(res, args.out)
        print("VMD", p, "frames", res["duration_frames"],
              "morph_keys", res["morph_keys"], "warn", res["warnings"])
    if args.json or not args.out:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
