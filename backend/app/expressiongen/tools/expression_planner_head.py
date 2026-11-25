#!/usr/bin/env python3
"""P1-A：多头模型推理 -> 扁平 DSL。

    文本 -> bge encode -> 5 头 -> 每槽 top1 -> 扁平 DSL
                                        -> expression_dsl.compile_dsl()

与规则 Planner 的关系：规则负责「已知短语/词表」，本模块负责「泛化到未见说法」。
两者输出格式一致（扁平 DSL），可直接被同一个编译器消费。

集成（可选）
------------
`ensemble_dirs=[...]` 时对多个模型的 morph 概率取平均（其它头用第一个模型）。
实测 probe(OOD) any_hit：v2 单模型 0.692 -> v2+v3 集成 0.718（neutral_ok 仍 0.955）。

    HeadPlanner(ensemble_dirs=["data/model/expression/bge_expr_dsl_v3"],
                neutral_bias=2.0)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (str(ROOT / "tools"),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import expression_dsl as ed  # noqa: E402
import expression_schema as es  # noqa: E402
from expression_dsl_labels import (  # noqa: E402
    LAYOUTS, PEAKS, REPEATS, TEMPO_NAMES)
from expression_planner import GESTURE_MORPHS  # noqa: E402

DATA = ROOT / "data"
DEFAULT_MODEL_DIR = DATA / "model" / "expression" / "bge_expr_dsl_v2"
ONNX_DIR = DATA / "model" / "onnx" / "bge-large-zh-v1.5"
DEFAULT_SLOT_THR = {"pupil": 0.7, "eyeUnder": 0.7}


def build_pick_table(labels: dict) -> tuple[list[tuple[str, int, str]], int | None]:
    """从 `labels.json` 构造「每槽候选」表。

    -> ([(slot, label_index, output_atom), ...], neutral_index)

    schema 4（atom/state 两种空间）优先读 `morph_id_slot` / `morph_id_atoms`；
    缺失时回退到 schema <= 3 的 `es.LABEL_INDEX × es.SLOT_ATOMS`。
    state 空间的 `morph_id_atoms` 是候选 morph 列表，取首选（与编译器一致）。
    """
    ids = labels.get("ids")
    id_slot = labels.get("morph_id_slot")
    id_atoms = labels.get("morph_id_atoms")
    neutral = labels.get("neutral", es.NEUTRAL)
    if ids and id_slot and id_atoms:
        idx = {n: i for i, n in enumerate(ids)}
        table: list[tuple[str, int, str]] = []
        for name in ids:
            slot = id_slot.get(name)
            atoms = id_atoms.get(name) or []
            if slot and atoms:
                table.append((slot, idx[name], atoms[0]))
        return table, idx.get(neutral)
    table = []
    for slot in es.SLOTS:
        for atom in es.SLOT_ATOMS[slot]:
            i = es.LABEL_INDEX.get(atom)
            if i is not None:
                table.append((slot, i, atom))
    return table, es.LABEL_INDEX.get(neutral)


class HeadPlanner:
    """多头分类 -> 扁平 DSL。模型缺失时 `available=False`，由级联回退规则。"""

    def __init__(self, model_dir: str | Path | None = None,
                 verbose: bool = True, neutral_bias: float = 3.0,
                 slot_threshold: dict | None = None,
                 ensemble_dirs: list | None = None,
                 emb_onnx_dir: str | Path | None = None,
                 union_rule: bool = False) -> None:
        self.model_dir = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
        self.ensemble_dirs = [Path(d) for d in (ensemble_dirs or [])]
        self.emb_onnx_dir = Path(emb_onnx_dir) if emb_onnx_dir else ONNX_DIR
        self.verbose = verbose
        self.neutral_bias = float(neutral_bias)
        self.union_rule = bool(union_rule)
        self.slot_thr = {**DEFAULT_SLOT_THR, **(slot_threshold or {})}
        self.backend = "none"
        self.available = False
        self.label_space = "atom"
        self._emb = None
        self._heads = []
        self._meta = []
        self._table: list[tuple[str, int, str]] = []
        self._neutral: int | None = None
        self._load()

    def _load(self) -> None:
        dirs = [self.model_dir] + self.ensemble_dirs
        valid = [d for d in dirs
                 if (d / "head_numpy.npz").exists()
                 and (d / "labels.json").exists()]
        if not valid or not self.emb_onnx_dir.exists():
            if self.verbose:
                print(f"[head] 未找到模型 {self.model_dir}，HeadPlanner 不可用",
                      file=sys.stderr)
            return
        try:
            from onnx_embedder import OnnxEmbedder
            from expression_dsl_head_numpy import NumpyDslHead
            self._emb = OnnxEmbedder(self.emb_onnx_dir)
            base_ids: list | None = None
            loaded: list[Path] = []
            for d in valid:
                try:
                    lab = json.loads((d / "labels.json")
                                     .read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    lab = {}
                ids = lab.get("ids") or list(es.LABELS)
                if base_ids is None:
                    base_ids = ids
                elif ids != base_ids:
                    # 集成要求同一标签空间，否则概率不可平均 → 跳过
                    if self.verbose:
                        print(f"[head] {d.name} 标签空间不一致，已跳过集成",
                              file=sys.stderr)
                    continue
                self._heads.append(NumpyDslHead(d / "head_numpy.npz"))
                self._meta.append(lab)
                loaded.append(d)
            if not self._heads:
                raise RuntimeError("没有可用的头模型")
            self._table, self._neutral = build_pick_table(self._meta[0])
            self.label_space = str(self._meta[0].get("label_space", "atom"))
            self.loaded_dirs = loaded
            self.backend = "onnx"
            self.available = True
            if self.verbose:
                print(f"[head] 引擎就绪 models={[d.name for d in self.loaded_dirs]}"
                      f" space={self.label_space}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            if self.verbose:
                print(f"[head] 加载失败（{exc}），不可用", file=sys.stderr)

    def _forward(self, texts: list[str]) -> dict:
        import numpy as np
        v = np.asarray(self._emb.encode(list(texts)), dtype=np.float32)
        outs = [h.forward(v) for h in self._heads]
        probs = [h.sigmoid(o["morph"])
                 for h, o in zip(self._heads, outs)]
        morph = probs[0] if len(probs) == 1 else np.mean(probs, axis=0)
        o0 = outs[0]
        return {
            "morph": morph,
            "tempo": o0["tempo"].argmax(axis=1),
            "repeat": o0["repeat"].argmax(axis=1),
            "layout": o0["layout"].argmax(axis=1),
            "peak": o0["peak"].argmax(axis=1),
        }

    def _pick(self, row) -> dict:
        """每槽 top1（同槽互斥）。候选表来自 labels.json，atom/state 通用。"""
        picked: dict[str, tuple[str, float]] = {}
        for slot, idx, atom in self._table:
            p = float(row[idx])
            cur = picked.get(slot)
            if cur is None or p > cur[1]:
                picked[slot] = (atom, p)
        return {s: v for s, v in picked.items()
                if v[1] >= self.slot_thr.get(s, 0.5)}

    def _decode(self, pr: dict, i: int) -> dict | None:
        """从批量前向结果第 i 行解码出一个 segment。"""
        row = pr["morph"][i]
        picked = self._pick(row)
        neutral_p = (float(row[self._neutral])
                     if self._neutral is not None else 0.0)
        top = max((p for _, p in picked.values()), default=0.0)
        if not picked or neutral_p >= max(top * self.neutral_bias, 0.5):
            return None
        tempo = TEMPO_NAMES[int(pr["tempo"][i])]
        repeat = REPEATS[int(pr["repeat"][i])]
        layout = LAYOUTS[int(pr["layout"][i])]
        peak = PEAKS[int(pr["peak"][i])]
        clips = [self._clip(name, tempo, repeat, peak)
                 for _slot, (name, _p) in picked.items()]
        return {"layout": layout, "clips": clips,
                "top": round(top, 4), "neutral": round(neutral_p, 4)}

    @staticmethod
    def _clip(name: str, tempo: str, repeat: int, peak: float) -> dict:
        env = ed.TEMPO.get(tempo) or ed.TEMPO["normal"]
        clip = {"morph": name, "tempo": tempo,
                "attack": env["attack"], "hold": env["hold"],
                "release": env["release"], "peak": peak}
        if name in GESTURE_MORPHS and repeat > 1:
            clip["repeat"] = repeat
            clip["gap"] = 3
        return clip

    @staticmethod
    def _rule_atoms(text: str) -> list[str]:
        """规则 Planner 命中的原子（同槽只留首个），用于 rule ∪ head 并集。"""
        from expression_dsl_labels import extract_labels
        from expression_planner import plan_text
        try:
            morphs = extract_labels(plan_text(str(text or "")))["morphs"]
        except Exception:  # noqa: BLE001
            return []
        out: list[str] = []
        used: set[str] = set()
        for m in morphs:
            slot = es.ATOM_SLOT.get(m)
            if slot and slot not in used:
                used.add(slot)
                out.append(m)
        return out

    def _merge_rule(self, seg: dict, text: str) -> None:
        """把规则命中的原子并入 head 段（同槽互斥：已有槽不再加）。"""
        have = {c["morph"] for c in seg.get("clips") or []}
        used = {es.ATOM_SLOT.get(m) for m in have}
        for a in self._rule_atoms(text):
            slot = es.ATOM_SLOT.get(a)
            if a in have or slot in used:
                continue
            seg["clips"].append(self._clip(a, "normal", 1, 1.0))
            have.add(a)
            used.add(slot)

    def plan_segment(self, text: str) -> dict | None:
        if not self.available:
            return None
        return self._decode(self._forward([text]), 0)

    def _prepare(self, texts: list[str]) -> tuple[list[list[str]], dict | None]:
        """切段 + 一次性批量前向 -> (每条的段列表, 前向结果)。

        与 `_assemble` 配对使用：同一次前向可以按不同 `union` / `neutral_bias`
        重新组装，避免评测时为每个配置重复编码。
        """
        from expression_engine import extract_stage_content
        from stage_segmenter import split_stage
        seg_lists: list[list[str]] = []
        flat: list[str] = []
        for t in texts:
            content = extract_stage_content(str(t or ""))
            segs = [s for s in split_stage(content) if s] or [content]
            seg_lists.append(segs)
            flat.extend(segs)
        pr = self._forward(flat) if (self.available and flat) else None
        return seg_lists, pr

    def _assemble(self, seg_lists: list[list[str]], pr: dict | None,
                  fps: int = ed.FPS, union: bool | None = None) -> list[dict]:
        """由前向结果组装扁平 DSL。`union=None` 时用实例的 `union_rule`。"""
        use_union = self.union_rule if union is None else bool(union)
        out: list[dict] = []
        idx = 0
        for segs in seg_lists:
            parts = []
            for seg_text in segs:
                r = self._decode(pr, idx) if pr is not None else None
                if use_union:
                    if r:
                        self._merge_rule(r, seg_text)
                    else:
                        atoms = self._rule_atoms(seg_text)
                        if atoms:
                            r = {"layout": "single",
                                 "clips": [self._clip(a, "normal", 1, 1.0)
                                           for a in atoms],
                                 "top": 1.0, "neutral": 0.0}
                if r:
                    parts.append(r)
                idx += 1
            out.append({"fps": fps, "source": "head", "segments": parts})
        return out

    def plan_batch(self, texts: list[str], fps: int = ed.FPS) -> list[dict]:
        """批量规划：一次性 encode 所有分段（生产/评测主路径）。"""
        seg_lists, pr = self._prepare(texts)
        return self._assemble(seg_lists, pr, fps)

    def plan(self, text: str, fps: int = ed.FPS) -> dict:
        """自然语言 -> 扁平 DSL（与规则 Planner 同格式）。"""
        flat = self.plan_batch([text], fps=fps)[0]
        flat["text"] = text
        return flat

    @staticmethod
    def confidence(flat: dict) -> float:
        """级联判据：所有段 top1 的最小值（任一段不确定就降级）。"""
        segs = flat.get("segments") or []
        if not segs:
            return 0.0
        return min(float(s.get("top", 0.0)) for s in segs)


def main() -> int:
    ap = argparse.ArgumentParser(description="Head Planner：文本 -> 扁平 DSL")
    ap.add_argument("text")
    ap.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    ap.add_argument("--emb-onnx-dir", default="",
                    help="bge ONNX 目录（默认 data/model/onnx/bge-large-zh-v1.5；"
                         "微调后可指向新目录）")
    ap.add_argument("--frames", type=int, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--union-rule", action="store_true",
                    help="rule ∪ head 并集（补 head 漏判，neutral 不变）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    planner = HeadPlanner(args.model_dir,
                          emb_onnx_dir=(args.emb_onnx_dir or None),
                          union_rule=args.union_rule)
    if not planner.available:
        raise SystemExit("HeadPlanner 不可用（缺 head_numpy.npz / onnx 模型）")
    flat = planner.plan(args.text)
    res = ed.compile_dsl(flat, total_frames=args.frames or None)
    if args.out:
        p = ed.write_vmd(res, args.out)
        print("VMD", p, "frames", res["duration_frames"],
              "morph_keys", res["morph_keys"], "warn", res["warnings"],
              "confidence", round(planner.confidence(flat), 4))
    if args.json or not args.out:
        print(json.dumps({"dsl": flat, "tracks": res["tracks"],
                          "duration_frames": res["duration_frames"],
                          "confidence": round(planner.confidence(flat), 4),
                          "warnings": res["warnings"]},
                         ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
