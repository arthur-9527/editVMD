#!/usr/bin/env python3
"""表情引擎：自然语言 -> morph 关键帧 / morph-only VMD。

与动作系统的 `distill_engine_v2.py` 同构（三层优先级 + 段级解码），额外多两件事：
  1. **槽解码**：模型给 36 维 sigmoid，按槽取 top1（组内互斥），`__neutral__`
     高则整段无表情。
  2. **morph 生命周期编排**：每个 morph 按自己的 `attack + hold + release`
     起落，**到点立即归零**（与动作总长无关）；同一时刻同槽绝不出现两个非零
     （需求明确禁止交叉过渡），眼 4 组各自起落、不再强制同步。

三层优先级（与动作引擎一致）
  ① 精确短语命中（`data/expression_phrases.json`）→ 直接采用
  ② 模型多标签 + 槽 top1 → 主力
  ③ 规则词表兜底（`expression_schema.label_text`）→ 模型缺失/无候选时

时长规则（需求：外部为主 + 内部编排兜底）
  外部 frames  >  外部 duration×fps  >  内部 max(90, 30×段数)
  每段按字数比例分配，下限 MIN_SEGMENT_FRAMES（保证放得下最短生命周期）。

用法:
  .venv/bin/python -m tools.expression_engine "（无语地翻个白眼，又勉强笑了一下）" \\
      --frames 120 --out /tmp/expr.vmd
  .venv/bin/python -m tools.expression_engine "开心地挥挥手" --json
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import expression_schema as es  # noqa: E402
from vmd_export import write_vmd  # noqa: E402

DATA = ROOT / "data"
DEFAULT_MODEL_DIR = DATA / "model" / "expression" / "bge_expr_v1"
PHRASES_PATH = DATA / "expression_phrases.json"
ONNX_DIR = DATA / "model" / "onnx" / "bge-large-zh-v1.5"


# ---------------------------------------------------------------- 短语兜底表


def load_phrases(path: Path = PHRASES_PATH) -> dict[str, dict]:
    """短语->原子表。文件不存在时返回空表（不影响模型路径）。"""
    if not path.exists():
        return {}
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    out: dict[str, dict] = {}
    for key, val in (obj.get("phrases") or {}).items():
        atoms = [a for a in (val.get("atoms") or []) if a in es.ATOM_SLOT]
        used, kept = set(), []
        for a in atoms:                     # 同槽互斥
            slot = es.ATOM_SLOT[a]
            if slot in used:
                continue
            used.add(slot)
            kept.append(a)
        out[key] = {"atoms": kept,
                    "intensity": es.intensity_class(val.get("intensity", 1.0))}
    return out


def _norm(text: str) -> str:
    """归一化：去空白与常见标点（短语路由用）。"""
    return "".join(ch for ch in (text or "")
                   if ch not in " \t\r\n，。、；：！？,.!?;:~～…").strip()


def extract_stage_content(text: str) -> str:
    """整句台词 -> 括号内的舞台指示内容（无括号则原样返回）。

    与动作系统一致：上游 LLM 的台词形如「你好（开心地招招手）」，
    表情系统只关心括号里的部分。多个括号用「，」连起来保留顺序。
    """
    s = (text or "").strip()
    if not s:
        return ""
    try:
        from stage_direction import extract_stage_directions
        parts = [p for p in extract_stage_directions(s) if p]
        if parts:
            return "，".join(parts)
    except Exception:  # noqa: BLE001
        pass
    return s


# ---------------------------------------------------------------- 引擎


class ExpressionEngine:
    """进程级表情引擎（模型可缺省，缺省时走规则兜底）。"""

    _instance: "ExpressionEngine | None" = None

    def __init__(self, model_dir: str | Path | None = None,
                 backend: str = "auto", allow_rules: bool = True,
                 verbose: bool = True, neutral_bias: float = 1.05,
                 slot_threshold: dict[str, float] | None = None) -> None:
        self.model_dir = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
        self.allow_rules = allow_rules
        self.verbose = verbose
        self.phrases = load_phrases()
        self.backend = "rules"
        self.label_space = "atom"        # 由 labels.json 覆盖（"atom" | "state"）
        self.labels: list[str] = list(es.LABELS)
        self.threshold = 0.5
        self.neutral_bias = float(neutral_bias)
        self.slot_threshold: dict[str, float] = dict(slot_threshold or {})
        self.intensity_classes = list(es.INTENSITY_CLASSES)
        self.neutral_idx = es.LABEL_INDEX[es.NEUTRAL]
        self._emb = None
        self._head = None
        self._torch = None
        self._torch_model = None
        self._load(model_dir_backend=backend)

    # ---- 加载 ----

    def _load(self, model_dir_backend: str) -> None:
        labels_p = self.model_dir / "labels.json"
        npz_p = self.model_dir / "head_numpy.npz"
        pt_p = self.model_dir / "head.pt"
        if not labels_p.exists():
            if self.verbose:
                print(f"[expr] 未找到模型 {self.model_dir}，使用规则兜底",
                      file=sys.stderr)
            return
        meta = json.loads(labels_p.read_text(encoding="utf-8"))
        self.labels = meta.get("ids") or self.labels
        self.threshold = float(meta.get("threshold", 0.5))
        self.intensity_classes = meta.get("intensity") or self.intensity_classes
        # 标签空间：v1="atom"（35 morph + neutral）/ v2="state"（30 语义态 + neutral）
        self.label_space = str(meta.get("label_space", "atom")).strip().lower()
        try:
            self.neutral_idx = self.labels.index(es.NEUTRAL)
        except ValueError:
            self.neutral_idx = len(self.labels) - 1

        backend = (model_dir_backend or "auto").strip().lower()
        if backend == "auto":
            backend = "onnx" if (npz_p.exists() and ONNX_DIR.exists()) else (
                "torch" if pt_p.exists() else "rules")

        try:
            if backend == "onnx":
                from expression_head_numpy import NumpyHead
                from onnx_embedder import OnnxEmbedder
                self._emb = OnnxEmbedder(ONNX_DIR)
                self._head = NumpyHead(npz_p)
            elif backend == "torch":
                import torch
                from sentence_transformers import SentenceTransformer
                self._torch = torch
                dev = "cuda" if torch.cuda.is_available() else "cpu"
                self._emb = SentenceTransformer(
                    meta.get("emb_model", "BAAI/bge-large-zh-v1.5"), device=dev)
                self._torch_model = self._build_torch_head(meta)
                self._torch_model.load_state_dict(
                    torch.load(pt_p, map_location="cpu"))
                self._torch_model.eval()
            else:
                raise FileNotFoundError("no onnx/torch artifact")
            self.backend = backend
            if self.verbose:
                print(f"[expr] 引擎就绪 backend={backend} "
                      f"model={self.model_dir}")
        except Exception as exc:  # noqa: BLE001
            self.backend = "rules"
            if self.verbose:
                print(f"[expr] 模型加载失败（{exc}），回退规则兜底",
                      file=sys.stderr)

    def _build_torch_head(self, meta: dict):
        import torch.nn as nn
        hidden = int(meta.get("hidden", 512))
        meta_p = self.model_dir / "meta.json"
        dim = int(json.loads(meta_p.read_text(encoding="utf-8"))
                  .get("emb_dim", 1024)) if meta_p.exists() else 1024
        n_labels = len(self.labels)
        n_int = len(self.intensity_classes)

        class EHead(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.trunk = nn.Sequential(
                    nn.Linear(dim, hidden), nn.GELU(), nn.Dropout(0.2),
                    nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(0.2))
                self.atom_head = nn.Linear(hidden, n_labels)
                self.intensity_head = nn.Linear(hidden, n_int)

            def forward(self, x):
                h = self.trunk(x)
                return self.atom_head(h), self.intensity_head(h)

        return EHead()
    # ---- 前向 / 解码 ----

    def _forward(self, text: str) -> tuple[list[float], float]:
        """返回 (36 维原子概率, 强度值)。"""
        if self.backend == "onnx":
            import numpy as np
            v = self._emb.encode([text])[0]
            out = self._head.forward(v[None, :].astype(np.float32))
            probs = 1.0 / (1.0 + np.exp(-out["atom"][0]))
            i_idx = int(out["intensity"][0].argmax())
            return [float(p) for p in probs], \
                float(self.intensity_classes[i_idx])
        if self.backend == "torch":
            import numpy as np
            v = self._emb.encode([text], normalize_embeddings=True,
                                 show_progress_bar=False,
                                 convert_to_numpy=True)[0]
            torch = self._torch
            x = torch.from_numpy(np.asarray([v], dtype=np.float32))
            x = x.to(next(self._torch_model.parameters()).device)
            with torch.no_grad():
                la, li = self._torch_model(x)
            probs = torch.sigmoid(la)[0].cpu().tolist()
            return probs, float(self.intensity_classes[int(li[0].argmax())])
        raise RuntimeError("规则模式下没有前向")

    def _slot_thr(self, slot: str) -> float:
        """每槽阈值（`T2M_EXPRESSION_SLOT_THR` 覆盖，缺省用 labels.json 的全局值）。"""
        return float(self.slot_threshold.get(slot, self.threshold))

    def _pick_per_slot(self, probs: list[float],
                       names_by_slot: dict[str, list[str]],
                       index: dict[str, int]) -> tuple[dict, float]:
        """每槽取 top1（组内互斥），返回 ({slot: (name, p)}, top1 概率)。"""
        picked: dict[str, tuple[str, float]] = {}
        top_all = 0.0
        for slot in es.SLOTS:
            best_name, best_p = None, 0.0
            for name in names_by_slot[slot]:
                i = index.get(name, -1)
                p = probs[i] if 0 <= i < len(probs) else 0.0
                if p > best_p:
                    best_name, best_p = name, p
            if best_name and best_p >= self._slot_thr(slot):
                picked[slot] = (best_name, best_p)
                top_all = max(top_all, best_p)
        return picked, top_all

    def _is_neutral(self, probs: list[float],
                    top_all: float) -> tuple[bool, float]:
        """neutral ≥ top1 × bias 且 ≥ threshold 才判「无表情」。

        `neutral_bias > 1` 抑制「该笑不笑」：只有 neutral 明显压过最高表情槽才收手。
        """
        neutral_p = probs[self.neutral_idx] if 0 <= self.neutral_idx < len(probs) \
            else 0.0
        return neutral_p >= max(top_all * self.neutral_bias, self.threshold), \
            neutral_p

    def decode_probs(self, probs: list[float], intensity: float) -> dict:
        """模型概率 -> {atoms, weights, top}（组内互斥 + neutral 抑制）。

        按 `labels.json` 的 `label_space` 分派：
          · `atom` （v1）：35 morph 原子取 argmax
          · `state`（v2）：30 语义态取 argmax，再映射到首选 morph
        输出**始终是 morph 名**，编排 / VMD 层不感知标签空间。
        """
        if not probs:
            return {"atoms": [], "weights": {}, "top": 0.0}
        if self.label_space == "state":
            picked, top_all = self._pick_per_slot(
                probs, es.SLOT_STATES_ORDERED, es.STATE_LABEL_INDEX)
        else:
            picked, top_all = self._pick_per_slot(
                probs, es.SLOT_ATOMS, es.LABEL_INDEX)

        neutral, neutral_p = self._is_neutral(probs, top_all)
        if neutral:
            return {"atoms": [], "weights": {}, "top": round(neutral_p, 4)}

        scale = min(1.0, max(0.1, float(intensity)))
        atoms, weights = [], {}
        for slot, (name, _p) in picked.items():
            if self.label_space == "state":
                names = es.STATE_TO_MORPH.get(name) or []
                if not names:           # 「睁」等在 state 空间不存在的态
                    continue
                atom = names[0]
            else:
                atom = name
            atoms.append(atom)
            # 跨槽独立、峰值统一到 1.0（只由强度档决定浓度）
            weights[atom] = round(min(1.0, scale), 4)
        return {"atoms": atoms, "weights": weights,
                "top": round(top_all, 4)}

    def _phrase_route(self, text: str) -> dict | None:
        """① 精确短语命中 / ③ 包含匹配兜底（覆盖率 ≥0.6 且贴首尾）。"""
        if not self.phrases:
            return None
        key = _norm(text)
        if not key:
            return None
        hit = self.phrases.get(key)
        if hit is None:
            best, best_cover = None, 0.0
            for k, v in self.phrases.items():
                if len(k) < 2 or k not in key:
                    continue
                cover = len(k) / len(key)
                lead = key.startswith(k) and (len(key) - len(k)) <= 6
                tail = key.endswith(k) and (len(key) - len(k)) <= 6
                if cover >= 0.6 and (lead or tail) and cover > best_cover:
                    best, best_cover = v, cover
            hit = best
        if hit is None:
            return None
        return {"atoms": list(hit["atoms"]),
                "intensity": float(hit["intensity"]),
                "top": 0.99, "source": "phrase"}

    # ---- 解析 ----

    def parse_segment(self, seg: str) -> dict:
        """单段：短语 → 模型 → 规则，三层优先级。

        `repeat` / `gap` 只由**显式重复词**决定（`眨眨眼` → 2 次），默认单次。
        """
        repeat, gap = es.detect_repeat(seg)
        routed = self._phrase_route(seg)
        if routed is not None:
            routed["weights"] = self._weights_for(routed["atoms"],
                                                  routed["intensity"])
            routed["repeat"], routed["gap"] = repeat, gap
            return routed
        if self.backend != "rules":
            probs, intensity = self._forward(seg)
            dec = self.decode_probs(probs, intensity)
            dec["intensity"] = intensity
            dec["source"] = "model"
            if dec["atoms"]:
                dec["repeat"], dec["gap"] = repeat, gap
                return dec
        if not self.allow_rules:
            return {"atoms": [], "weights": {}, "top": 0.0,
                    "intensity": 1.0, "source": "none",
                    "repeat": 1, "gap": 0}
        lab = es.label_text(seg)
        return {"atoms": lab["atoms"], "intensity": lab["intensity"],
                "top": 0.5 if lab["atoms"] else 0.0,
                "weights": self._weights_for(lab["atoms"], lab["intensity"]),
                "repeat": repeat, "gap": gap,
                "source": f"rule:{lab['source']}"}

    @staticmethod
    def _weights_for(atoms: list[str], intensity: float) -> dict[str, float]:
        """原子 -> 峰值权重。跨槽独立、峰值=1.0；`intensity` 是「微微/非常」
        的语义强度（0.5 / 1.0 / 1.5→clamp 1.0），**不再按槽打折**。"""
        scale = min(1.0, max(0.1, float(intensity)))
        return {a: round(min(1.0, scale), 4) for a in atoms}

    def segment_text(self, text: str) -> list[str]:
        try:
            from stage_segmenter import split_stage
            segs = [s for s in split_stage(text) if s]
        except Exception:  # noqa: BLE001
            segs = []
        return segs or [text]

# ---------------------------------------------------------------- 编排（morph 生命周期）


def allocate_frames(frames: int, lens: list[int],
                    min_frames: int = es.MIN_SEGMENT_FRAMES) -> list[int]:
    """按时长预算给每段分帧（外部传入为主，内部兜底比例分配）。

    返回每段帧数；若预算装不下所有段（frames < n×min），只保留前 k 段
    （对应动作系统的「砍动作」降级），保证每段放得下最短生命周期。
    """
    n = len(lens)
    if n == 0:
        return []
    frames = max(1, int(frames))
    if frames < n * min_frames:
        n = max(1, frames // min_frames)
        lens = lens[:n]
    total = sum(max(1, x) for x in lens) or len(lens)
    alloc = [max(min_frames, int(round(frames * max(1, x) / total)))
             for x in lens]
    while sum(alloc) > frames and max(alloc) > min_frames:
        alloc[alloc.index(max(alloc))] -= 1
    while sum(alloc) < frames:
        alloc[alloc.index(max(alloc))] += 1
    return alloc


def build_timeline(segments: list[dict], frames: int) -> list[dict]:
    """段落列表 -> 绝对帧位时间轴（每段一个状态）。"""
    if not segments:
        return []
    alloc = allocate_frames(frames, [len(s.get("text") or "") + 1
                                    for s in segments])
    timeline: list[dict] = []
    cursor = 0
    for seg, dur in zip(segments, alloc):
        timeline.append({
            "frame": cursor,
            "text": seg.get("text", ""),
            "atoms": list(seg.get("atoms") or []),
            "weights": dict(seg.get("weights") or {}),
            "intensity": float(seg.get("intensity", 1.0)),
            "source": seg.get("source", ""),
            "top": float(seg.get("top", 0.0)),
            "repeat": int(seg.get("repeat") or 1),
            "gap": int(seg.get("gap") or 0),
            "hold": seg.get("hold"),
            "start": seg.get("start"),
        })
        cursor += dur
    return timeline


def _fit_life(a: int, h: int, r: int, seg_len: int) -> tuple[int, int, int]:
    """把 (attack, hold, release) 压进 seg_len 帧内（每项 ≥1，总和 ≤ seg_len）。

    段太短（< 3 帧）时返回 (0, 0, 0) = 不产表情。
    """
    a, h, r = max(1, int(a)), max(1, int(h)), max(1, int(r))
    if a + h + r <= seg_len:
        return a, h, r
    if seg_len < 3:
        return 0, 0, 0
    scale = seg_len / float(a + h + r)
    a = max(1, int(round(a * scale)))
    h = max(1, int(round(h * scale)))
    r = max(1, int(round(r * scale)))
    while a + h + r > seg_len:              # 进位兜底：保证严格收在段内
        if h > 1:
            h -= 1
        elif r > 1:
            r -= 1
        elif a > 1:
            a -= 1
        else:
            break
    return a, h, r


def schedule_fifo(timeline: list[dict], duration_frames: int,
                  out_frames: int = es.TRANSITION_OUT,
                  in_frames: int = es.TRANSITION_IN,
                  release: bool = True) -> dict[str, list[list[float]]]:
    """每个 morph 独立生命周期：`attack + hold + release` 后**立即归零**。

    与旧实现的关键区别（需求修正）
    ------------------------------
    旧实现把每个 morph 保持到「下一段起点 / 动作总长」，于是眨眼会闭 3.7s、
    「笑眯眯」全程闭眼、嘟嘴保持 2.7s。新实现按
    `expression_schema.MORPH_TIMING` 给**每个 morph 自己的生命周期**，与动作
    总帧数无关：

        [t, 0] [t+a, peak] [t+a+h, peak] [t+a+h+r, 0]      之后保持 0

    · 生命周期必须在**所属段内**完成（超出则等比压缩），因此相邻段的同槽
      morph 天然不重叠 —— 「先出后进」自动成立；
    · `repeat` > 1 时重复 N 次（间隔 `gap`），仅排得下时生效；
    · `hold` 字段可按段覆盖该 morph 的保持帧数（clamp 到 HOLD_RANGE）；
    · `out_frames` / `in_frames` **已废弃不再使用**：每个 morph 的
      attack/release 由 `MORPH_TIMING` 决定（保留参数只为兼容旧调用）。

    timeline 元素：`{frame, atoms, weights?, hold?, repeat?, gap?}`
    """
    tracks: dict[str, list[list[float]]] = {}
    dur = max(1, int(duration_frames))

    def emit(name: str, t0: int, a: int, h: int, r: int, w: float,
             repeat: int, rgap: int, seg_end: int) -> None:
        keys = tracks.setdefault(name, [])
        life = a + h + r
        step = life + rgap
        for k in range(repeat):
            base = t0 + k * step
            if base + life > seg_end:
                break
            keys.append([base, 0.0])
            keys.append([base + a, round(w, 4)])
            keys.append([base + a + h, round(w, 4)])
            keys.append([base + life, 0.0])

    for i, st in enumerate(timeline):
        t = max(0, min(int(st.get("frame", 0)), dur))
        nxt = (int(timeline[i + 1].get("frame", dur))
               if i + 1 < len(timeline) else dur)
        seg_end = max(t, min(nxt, dur))
        seg_len = seg_end - t
        if seg_len < 3:
            continue
        repeat = max(1, int(st.get("repeat") or 1))
        rgap = max(0, int(st.get("gap") or 0))
        hold_override = st.get("hold")
        start_off = max(0, int(st.get("start") or 0))
        weights = st.get("weights") or {}
        for atom in st.get("atoms") or []:
            if atom not in es.ATOM_SLOT:
                continue
            w = float(weights.get(atom, 1.0))
            if w <= 1e-6:
                continue
            a, h, r = es.morph_timing(atom)
            if hold_override is not None:
                h = es.clamp_hold(hold_override)
            a, h, r = _fit_life(a, h, r, seg_len)
            if a == 0:
                continue
            # start 偏移（可对齐语音/动作关键点），不允许把生命周期顶出段外
            off = min(start_off, max(0, seg_len - (a + h + r)))
            emit(atom, t + off, a, h, r, w, repeat, rgap, seg_end)

    # 收尾保险：末帧必为 0（曲线自身已归零，这里只兜越界/浮点残留）
    if release:
        for m, keys in tracks.items():
            keys.sort()
            if keys and keys[-1][1] > 1e-6:
                keys.append([dur, 0.0])

    out: dict[str, list[list[float]]] = {}
    for m, keys in tracks.items():
        keys.sort()
        merged: dict[int, float] = {}       # 同帧去重（保留最后写入值）
        for f, w in keys:
            merged[int(f)] = float(w)
        out[m] = [[f, merged[f]] for f in sorted(merged)]
    return out

# ---------------------------------------------------------------- 采样/眨眼/校验


CLOSE_MORPHS = {"まばたき", "なごみ", "ウィンク", "ウィンク２", "なごみ左",
                "ウィンク右", "ウィンク２右", "なごみ右", "笑い"}
BLINK_MORPH = "まばたき"


def _sample(keys: list[list[float]], frame: int) -> float:
    """关键帧线性插值采样。"""
    if not keys:
        return 0.0
    if frame <= keys[0][0]:
        return float(keys[0][1])
    if frame >= keys[-1][0]:
        return float(keys[-1][1])
    lo, hi = 0, len(keys) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if keys[mid][0] <= frame:
            lo = mid
        else:
            hi = mid
    f0, w0 = keys[lo]
    f1, w1 = keys[hi]
    if f1 == f0:
        return float(w1)
    u = (frame - f0) / float(f1 - f0)
    return float(w0) + (w1 - w0) * u


def to_frames(tracks: dict[str, list[list[float]]],
              duration_frames: int) -> list[dict]:
    """关键帧 -> 逐帧 morph 列表（dense）。"""
    dur = max(1, int(duration_frames))
    frames: list[dict] = []
    for f in range(dur + 1):
        morphs = []
        for name, keys in tracks.items():
            w = _sample(keys, f)
            if w > 1e-4:
                morphs.append({"name": name, "weight": round(min(1.0, w), 4)})
        frames.append({"fi": f, "morphs": morphs})
    return frames


def blink_track(tracks: dict[str, list[list[float]]], duration_frames: int,
                seed: int | None = None, interval: int = 55,
                jitter: int = 18) -> dict[str, list[list[float]]]:
    """自主眨眼（独立轨道）。与「全闭类 eyeOpen」重叠的眨眼直接跳过。"""
    rng = random.Random(seed)
    blocked = [False] * (duration_frames + 2)
    for name, keys in tracks.items():
        if name not in CLOSE_MORPHS:
            continue
        for f in range(duration_frames + 1):
            if _sample(keys, f) > 1e-4:
                blocked[f] = True

    close, hold, reopen = 2, 1, 5
    keys: list[list[float]] = []
    f = rng.randint(5, 20)
    while True:
        end = f + close + hold + reopen
        if end > duration_frames:
            break
        span = range(f, end + 1)
        if not any(blocked[i] for i in span if 0 <= i < len(blocked)):
            keys += [[f, 0.0], [f + close, 1.0],
                     [f + close + hold, 1.0], [end, 0.0]]
        f = end + max(18, rng.randint(interval - jitter, interval + jitter))
    if not keys:
        return {}
    merged: dict[int, float] = {}
    for kf, w in keys:
        merged[int(kf)] = float(w)
    return {BLINK_MORPH: [[k, merged[k]] for k in sorted(merged)]}


def validate_tracks(tracks: dict[str, list[list[float]]],
                    duration_frames: int,
                    ignore: frozenset[str] | set[str] = frozenset()) -> list[str]:
    """核心不变量：任意帧、同一槽内非零 morph ≤ 1（同槽互斥的等价表述）。

    `ignore` 用于豁免「叠加层」：自主眨眼写的是 `まばたき`（属于 eyeOpen 槽），
    它是 0.2s 的瞬时叠加（MMD 里权重相加 = 短暂闭眼），不属于表情状态机。
    因此编排层校验时把 `まばたき` 排除；表情自身的 eyeOpen 仍然严格互斥。
    """
    problems: list[str] = []
    skip = set(ignore)
    for f in range(duration_frames + 1):
        for slot in es.SLOTS:
            live = []
            for a in es.SLOT_ATOMS[slot]:
                if a in skip:
                    continue
                keys = tracks.get(a)
                if keys and _sample(keys, f) > 1e-6:
                    live.append(a)
            if len(live) > 1:
                problems.append(f"frame {f} slot {slot} 多个非零: {live}")
                if len(problems) > 20:
                    return problems
    return problems


def to_morph_records(tracks: dict[str, list[list[float]]]) -> list[tuple]:
    recs = []
    for name, keys in tracks.items():
        for f, w in keys:
            recs.append((name, int(f), float(w)))
    return recs


# ---------------------------------------------------------------- 对外接口


def resolve_frames(frames: int | None, duration: float | None,
                   n_segments: int, fps: int = es.FPS,
                   default_frames: int = 90) -> int:
    """时长：外部 frames > 外部 duration×fps > 内部编排兜底。

    `default_frames` 来自 `server.config.EXPRESSION_DEFAULT_FRAMES`（默认 90）；
    这里不 import config，保持「表情引擎可独立 CLI 运行」。
    """
    if frames:
        return max(es.MIN_SEGMENT_FRAMES, int(frames))
    if duration and duration > 0:
        return max(es.MIN_SEGMENT_FRAMES, int(round(duration * fps)))
    return max(int(default_frames),
               int(es.MIN_SEGMENT_FRAMES * max(1, n_segments)),
               int(30 * max(1, n_segments)))


def fit_frames(want: list[int], total: int) -> tuple[list[int], bool]:
    """把每段期望帧数等比缩放到总和 == total（保序、每段 ≥1）。

    返回 (帧数列表, 是否发生缩放)。与 `allocate_frames` 的区别：
    `allocate_frames` 在预算不足时会**砍段**（text 路径的既定降级行为），
    而外部显式分段/状态时帧数由调用方决定，只缩不砍。
    """
    n = len(want)
    if n == 0:
        return [], False
    total = max(n, int(total))
    want = [max(1, int(w)) for w in want]
    s = sum(want)
    if s == total:
        return want, False
    out = [max(1, int(round(w * total / s))) for w in want]
    while sum(out) > total:
        i = out.index(max(out))
        if out[i] <= 1:
            break
        out[i] -= 1
    while sum(out) < total:
        out[out.index(max(out))] += 1
    return out, True


def resolve_atoms(names: list[str], *, allow_states: bool = True) -> dict:
    """外部传入的名字 -> 合法 morph 原子（同槽去重，保留先出现者）。

    同时接受两种写法（为 P2 的 state 标签空间预留）：
      · morph 名（`ジト目` / `口角上げ` …）—— 一直支持
      · 语义态名（`双闭` / `圆睁` …）—— 由 `expression_schema.STATE_TO_MORPH`
        映射到首选 morph；`睁` 是合法态但映射为空（该槽不加任何 morph）

    返回 `{"atoms", "dropped", "duplicates"}`，供 REST/WS/测试共用。
    """
    state_map = getattr(es, "STATE_TO_MORPH", {}) if allow_states else {}
    kept: list[str] = []
    dropped: list[str] = []
    dups: list[str] = []
    used: set[str] = set()
    for raw in names or []:
        name = str(raw or "").strip()
        if not name:
            continue
        if name in state_map:
            mapped = list(state_map[name] or [])
        elif name in es.ATOM_SLOT:
            mapped = [name]
        else:
            dropped.append(name)
            continue
        if not mapped:              # 「睁」等空映射：合法，但不产生 morph
            continue
        atom = mapped[0]
        slot = es.ATOM_SLOT.get(atom)
        if slot is None:
            dropped.append(name)
            continue
        if slot in used:
            dups.append(name)
            continue
        used.add(slot)
        kept.append(atom)
    return {"atoms": kept, "dropped": dropped, "duplicates": dups}


def scale_timeline(starts: list[int], want: list[int],
                   total: int) -> tuple[list[int], list[int], bool]:
    """时间轴整体等比缩放到 total（起点与段长一起缩，保证不重叠/不越界）。"""
    if not starts:
        return starts, want, False
    total = max(1, int(total))
    span = max(s + w for s, w in zip(starts, want))
    if span == total:
        return starts, want, False
    scale = total / float(max(1, span))
    st = [max(0, int(round(s * scale))) for s in starts]
    wd = [max(1, int(round(w * scale))) for w in want]
    for i in range(1, len(st)):             # 保序：后一段不得压到前一段
        st[i] = max(st[i], st[i - 1] + wd[i - 1])
    over = st[-1] + wd[-1] - total
    if over > 0:                            # 收尾不越界
        wd[-1] = max(1, wd[-1] - over)
        if st[-1] + wd[-1] > total:
            st[-1] = max(0, total - wd[-1])
    return st, wd, True


class ExpressionRenderer:
    """解析 + 编排 + 落盘（REST / WS / CLI 共用）。

    三个入口共用 `_assemble`（眨眼 / 生命周期编排 / 校验 / 组包保持一致）：
      · `build(text)`            —— 自然语言（① 短语 ② 模型 ③ 规则）
      · `build_from_segments()`  —— 外部显式分段（每段 text + frames/duration）
      · `build_from_states()`    —— 外部已定表情（morph/态 + frame/frames）
    优先级由调用方（REST/WS）决定：`states` > `segments` > `text`。
    """

    def __init__(self, engine: ExpressionEngine | None = None,
                 default_frames: int = 90) -> None:
        self.engine = engine or ExpressionEngine()
        self.default_frames = max(1, int(default_frames))

    def parse(self, text: str) -> dict:
        content = extract_stage_content(text)
        segs = self.engine.segment_text(content)
        parsed = [{"text": s, **self.engine.parse_segment(s)} for s in segs]
        return {"text": text, "content": content, "segments": parsed}

    # ---- 共用编排 ----

    def _assemble(self, text: str, timeline: list[dict], total: int, *,
                  fps: int, out_frames: int, in_frames: int,
                  blink: bool, release: bool, dense: bool,
                  seed: int | None = None,
                  warnings: list[str] | None = None,
                  timeline_source: str = "text",
                  dropped: list[str] | None = None) -> dict:
        total = max(1, int(total))
        tracks = schedule_fifo(timeline, total, out_frames, in_frames,
                               release=release)
        warns = list(warnings or [])
        blink_on = bool(blink)
        if blink_on:
            blinks = blink_track(tracks, total, seed=seed)
            if blinks:
                tracks[BLINK_MORPH] = sorted(
                    tracks.get(BLINK_MORPH, []) + blinks[BLINK_MORPH])
                merged: dict[int, float] = {}
                for f, w in tracks[BLINK_MORPH]:
                    merged[int(f)] = float(w)
                tracks[BLINK_MORPH] = [[f, merged[f]] for f in sorted(merged)]

        warns += validate_tracks(
            tracks, total, ignore={BLINK_MORPH} if blink_on else set())[:5]
        seen: set[str] = set()          # 去重但保序（同一 warning 可能多段触发）
        warns = [w for w in warns if not (w in seen or seen.add(w))]
        out = {
            "ok": True,
            "text": text,
            "backend": self.engine.backend,
            "fps": fps,
            "total": total + 1,
            "duration_frames": total,
            "timeline_source": timeline_source,
            "states": timeline,
            "tracks": tracks,
            "dropped": list(dropped or []),
            "warnings": warns,
        }
        out["frames"] = to_frames(tracks, total) if dense else []
        return out

    # ---- ④ DSL 路径（P0 新增；既有 build/segments/states 不变）----

    def build_dsl(self, text: str, *, frames: int | None = None,
                  duration: float | None = None, fps: int = es.FPS,
                  dense: bool = True, seed: int | None = None) -> dict:
        """自然语言 -> DSL -> 稀疏关键帧（P0）。

        与 `build()` 的区别：不做「每槽静态原子 + 统一包络」，而是让 Planner
        输出带节奏的 DSL 树，再由 `expression_dsl.compile_dsl` 编译。
        输出结构与 `_assemble` 对齐，REST/WS 可直接复用。
        """
        import expression_dsl as ed
        from expression_planner import plan_text

        total = None
        if frames:
            total = int(frames)
        elif duration and duration > 0:
            total = int(round(duration * fps))
        dsl = plan_text(text)
        res = ed.compile_dsl(dsl, total_frames=total)
        tracks = res["tracks"]
        dur = int(res["duration_frames"])

        states = []
        for name, keys in tracks.items():
            peak = max((w for _f, w in keys), default=0.0)
            pf = next((f for f, w in keys if abs(w - peak) < 1e-6),
                      keys[0][0])
            states.append({"frame": int(pf), "text": "", "atoms": [name],
                           "weights": {name: round(peak, 4)},
                           "intensity": 1.0, "source": "dsl",
                           "top": round(peak, 4)})
        states.sort(key=lambda st: (st["frame"],
                                    es.ATOM_SLOT.get(st["atoms"][0], "")))

        out = {
            "ok": True,
            "text": text,
            "backend": self.engine.backend,
            "fps": fps,
            "total": dur + 1,
            "duration_frames": dur,
            "timeline_source": "dsl",
            "states": states,
            "tracks": tracks,
            "dropped": [],
            "warnings": res["warnings"],
            "dsl": dsl,
        }
        out["frames"] = to_frames(tracks, dur) if dense else []
        return out

    # ---- ① 自然语言 ----

    def build(self, text: str, *, frames: int | None = None,
              duration: float | None = None, fps: int = es.FPS,
              out_frames: int = es.TRANSITION_OUT,
              in_frames: int = es.TRANSITION_IN,
              blink: bool = True, release: bool = True,
              dense: bool = True, seed: int | None = None) -> dict:
        parsed = self.parse(text)
        segs = parsed["segments"]
        total = resolve_frames(frames, duration, len(segs), fps,
                               self.default_frames)
        timeline = build_timeline(segs, total)
        return self._assemble(
            text, timeline, total, fps=fps, out_frames=out_frames,
            in_frames=in_frames, blink=blink, release=release, dense=dense,
            seed=seed, timeline_source="text",
            dropped=[s["text"] for s in segs if not s["atoms"]])

    # ---- ② 显式分段（外部按句切好并给帧数）----

    def build_from_segments(self, segments: list[dict], *,
                            frames: int | None = None,
                            duration: float | None = None,
                            fps: int = es.FPS,
                            out_frames: int = es.TRANSITION_OUT,
                            in_frames: int = es.TRANSITION_IN,
                            blink: bool = True, release: bool = True,
                            dense: bool = True, seed: int | None = None) -> dict:
        """`segments=[{text, frames?, duration?}]` -> 时间轴。

        帧数规则：段级 `frames` > 段级 `duration×fps` > 按字数分「剩余预算」；
        顶层 `frames/duration` 与段帧数冲突时整体等比缩放（`segments_scaled`）。
        """
        if not segments:
            raise ValueError("segments 不能为空")
        parsed: list[dict] = []
        warns: list[str] = []
        for seg in segments:
            seg = seg or {}
            text = str(seg.get("text") or "").strip()
            if text:
                item = {"text": text, **self.engine.parse_segment(text)}
            else:
                item = {"text": "", "atoms": [], "weights": {},
                        "intensity": 1.0, "top": 0.0, "source": "empty",
                        "repeat": 1, "gap": 0}
            if seg.get("hold") is not None:
                item["hold"] = seg["hold"]
            if seg.get("repeat"):
                item["repeat"] = max(1, int(seg["repeat"]))
            if seg.get("gap") is not None:
                item["gap"] = max(0, int(seg["gap"]))
            if seg.get("start") is not None:
                item["start"] = max(0, int(seg["start"]))
            f = seg.get("frames")
            if f:
                item["frames"] = max(1, int(f))
            elif seg.get("duration"):
                item["frames"] = max(1, int(round(float(seg["duration"]) * fps)))
            parsed.append(item)

        total = None
        want: list[int | None] = [s.get("frames") for s in parsed]
        fixed = sum(w for w in want if w)
        missing = [i for i, w in enumerate(want) if not w]
        if frames:
            total = max(es.MIN_SEGMENT_FRAMES, int(frames))
        elif duration and duration > 0:
            total = max(es.MIN_SEGMENT_FRAMES, int(round(duration * fps)))
        elif not missing:                   # 全显式：总长 = 段帧数之和
            total = max(es.MIN_SEGMENT_FRAMES, fixed)
        else:                               # 有缺省段：内部兜底总长
            total = resolve_frames(None, None, len(parsed), fps,
                                   self.default_frames)
        if missing:                         # 缺省段按字数分剩余预算
            remain = max(len(missing), total - fixed)
            lens = [len(parsed[i]["text"]) + 1 for i in missing]
            alloc, _ = fit_frames(lens, remain)
            for i, a in zip(missing, alloc):
                want[i] = a
        final, scaled = fit_frames([int(w or 1) for w in want], int(total))
        if scaled:
            warns.append("segments_scaled")

        timeline: list[dict] = []
        cursor = 0
        for item, dur in zip(parsed, final):
            timeline.append({
                "frame": cursor,
                "text": item["text"],
                "atoms": list(item.get("atoms") or []),
                "weights": dict(item.get("weights") or {}),
                "intensity": float(item.get("intensity", 1.0)),
                "source": item.get("source", ""),
                "top": float(item.get("top", 0.0)),
                "repeat": int(item.get("repeat") or 1),
                "gap": int(item.get("gap") or 0),
                "hold": item.get("hold"),
                "start": item.get("start"),
            })
            cursor += dur
        return self._assemble(
            "", timeline, total, fps=fps, out_frames=out_frames,
            in_frames=in_frames, blink=blink, release=release, dense=dense,
            seed=seed, warnings=warns, timeline_source="segments",
            dropped=[s["text"] for s in parsed if not s["atoms"]])

    # ---- ③ 外部已定表情（绕过模型）----

    def build_from_states(self, states: list[dict], *,
                          frames: int | None = None,
                          duration: float | None = None,
                          fps: int = es.FPS,
                          out_frames: int = es.TRANSITION_OUT,
                          in_frames: int = es.TRANSITION_IN,
                          blink: bool = True, release: bool = True,
                          dense: bool = True, seed: int | None = None) -> dict:
        """`states=[{atoms, frame?, frames?, intensity?, text?}]` -> 时间轴。

        · `atoms` 接受 morph 名与语义态名，白名单外的进 `dropped`、同槽重复进 warning；
        · `frame` 缺省时按 `frames` 顺序累加；显式 `frame` 则尊重外部绝对位置；
        · 顶层 `frames/duration` 与推导总长冲突 → 整体等比缩放（`timeline_scaled`）；
        · 单段短于 `MIN_SEGMENT_FRAMES` → `segment_short`（生命周期由 `_fit_life` 压进段内）。
        """
        if not states:
            raise ValueError("states 不能为空")
        warns: list[str] = []
        rows: list[dict] = []
        for st in states:
            st = st or {}
            got = resolve_atoms(list(st.get("atoms") or []))
            if got["dropped"]:
                warns.append("dropped_atoms:" + ",".join(got["dropped"][:5]))
            if got["duplicates"]:
                warns.append("duplicate_slot:" + ",".join(got["duplicates"][:5]))
            atoms = got["atoms"]
            raw_i = st.get("intensity")
            inten = 1.0 if raw_i is None else float(raw_i)
            rows.append({
                "text": str(st.get("text") or ""),
                "atoms": atoms,
                "weights": self.engine._weights_for(atoms, inten),
                "intensity": es.intensity_class(inten),
                "source": "states",
                "top": 1.0 if atoms else 0.0,
                "frame": st.get("frame"),
                "frames": st.get("frames"),
                "hold": st.get("hold"),
                "repeat": max(1, int(st.get("repeat") or 1)),
                "gap": max(0, int(st.get("gap") or 0)),
                "start": st.get("start"),
            })

        default_seg = max(es.MIN_SEGMENT_FRAMES,
                          int(self.default_frames) // max(1, len(rows)))
        want: list[int] = []
        for i, r in enumerate(rows):
            f = r.get("frames")
            if f:
                want.append(max(1, int(f)))
                continue
            nxt = next((rows[j].get("frame") for j in range(i + 1, len(rows))
                        if rows[j].get("frame") is not None), None)
            cur = r.get("frame")
            if cur is not None and nxt is not None and int(nxt) > int(cur):
                want.append(int(nxt) - int(cur))
            else:
                want.append(default_seg)

        starts: list[int] = []
        cursor = 0
        for r, w in zip(rows, want):
            cur = r.get("frame")
            starts.append(max(0, int(cur)) if cur is not None else cursor)
            cursor = starts[-1] + w

        span = max(s + w for s, w in zip(starts, want))
        if frames:
            total = max(es.MIN_SEGMENT_FRAMES, int(frames))
        elif duration and duration > 0:
            total = max(es.MIN_SEGMENT_FRAMES, int(round(duration * fps)))
        else:
            total = max(1, span)            # 外部帧数/帧号即总长（不缩放）

        starts, want, scaled = scale_timeline(starts, want, total)
        if scaled:
            warns.append("timeline_scaled")
        for i, w in enumerate(want):
            if w < es.MIN_SEGMENT_FRAMES:
                warns.append(f"segment_short@{i}({w})")

        timeline = [{
            "frame": s,
            "text": r["text"],
            "atoms": list(r["atoms"]),
            "weights": dict(r["weights"]),
            "intensity": float(r["intensity"]),
            "source": r["source"],
            "top": float(r["top"]),
            "repeat": int(r.get("repeat") or 1),
            "gap": int(r.get("gap") or 0),
            "hold": r.get("hold"),
            "start": r.get("start"),
        } for r, s in zip(rows, starts)]
        return self._assemble(
            "", timeline, total, fps=fps, out_frames=out_frames,
            in_frames=in_frames, blink=blink, release=release, dense=dense,
            seed=seed, warnings=warns, timeline_source="states",
            dropped=[r["text"] for r in rows if not r["atoms"] and r["text"]])

    # ---- 落盘 ----

    @staticmethod
    def finish_vmd(res: dict, path: str | Path, model_name: str) -> dict:
        recs = to_morph_records(res["tracks"])
        n_bones = write_vmd([], path, model_name=model_name, morphs=recs)
        res["vmd"] = str(path)
        res["morph_records"] = len(recs)
        res["bone_records"] = n_bones
        return res

    def render_vmd(self, text: str, path: str | Path, *,
                   frames: int | None = None, duration: float | None = None,
                   fps: int = es.FPS, model_name: str = "expression",
                   **kwargs) -> dict:
        res = self.build(text, frames=frames, duration=duration, fps=fps,
                         **kwargs)
        return self.finish_vmd(res, path, model_name)

    def render_vmd_from_states(self, states: list[dict], path: str | Path, *,
                               frames: int | None = None,
                               duration: float | None = None,
                               fps: int = es.FPS,
                               model_name: str = "expression",
                               **kwargs) -> dict:
        res = self.build_from_states(states, frames=frames, duration=duration,
                                     fps=fps, **kwargs)
        return self.finish_vmd(res, path, model_name)

    def render_vmd_from_segments(self, segments: list[dict],
                                 path: str | Path, *,
                                 frames: int | None = None,
                                 duration: float | None = None,
                                 fps: int = es.FPS,
                                 model_name: str = "expression",
                                 **kwargs) -> dict:
        res = self.build_from_segments(segments, frames=frames,
                                       duration=duration, fps=fps, **kwargs)
        return self.finish_vmd(res, path, model_name)


def get_engine(model_dir: str | Path | None = None,
               verbose: bool = True) -> ExpressionEngine:
    if ExpressionEngine._instance is None or model_dir:
        ExpressionEngine._instance = ExpressionEngine(model_dir=model_dir,
                                                      verbose=verbose)
    return ExpressionEngine._instance


def get_renderer(model_dir: str | Path | None = None,
                 verbose: bool = True) -> ExpressionRenderer:
    return ExpressionRenderer(get_engine(model_dir=model_dir,
                                         verbose=verbose))


# ---------------------------------------------------------------- CLI


def _print_summary(res: dict) -> None:
    print(f"backend={res['backend']}  fps={res['fps']}  "
          f"帧数={res['total']}（0..{res['duration_frames']}）")
    for i, st in enumerate(res["states"]):
        atoms = ", ".join(st["atoms"]) or "（无表情）"
        print(f"  seg{i} @{st['frame']:4d}  [{st['source']}] {atoms}  "
              f"weights={st['weights']}  intensity={st['intensity']}")
    print("  轨道:")
    for name, keys in res["tracks"].items():
        print(f"    {name:8s} {keys}")
    if res["dropped"]:
        print(f"  无表情段: {res['dropped']}")
    if res["warnings"]:
        print(f"  ⚠ warnings: {res['warnings'][:3]}")
    if res.get("vmd"):
        print(f"  VMD: {res['vmd']}  morph记录={res['morph_records']}  "
              f"骨骼记录={res['bone_records']}")


def main() -> None:
    ap = argparse.ArgumentParser(description="自然语言 -> 表情 morph VMD")
    ap.add_argument("text", nargs="*", help="文本（括号内舞台指示或整句）")
    ap.add_argument("--frames", type=int, default=0, help="外部帧数（优先）")
    ap.add_argument("--duration", type=float, default=0.0, help="外部时长（秒）")
    ap.add_argument("--fps", type=int, default=es.FPS)
    ap.add_argument("--out", default="", help="输出 VMD 路径（不填则只打印）")
    ap.add_argument("--model-dir", default="", help="模型目录（默认 bge_expr_v1）")
    ap.add_argument("--backend", default="auto",
                    choices=["auto", "onnx", "torch"])
    ap.add_argument("--out-frames", type=int, default=es.TRANSITION_OUT)
    ap.add_argument("--in-frames", type=int, default=es.TRANSITION_IN)
    ap.add_argument("--no-blink", action="store_true")
    ap.add_argument("--no-release", action="store_true")
    ap.add_argument("--json", action="store_true", help="打印完整 JSON")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    text = " ".join(args.text).strip() or "（无语地翻了个白眼）"
    engine = ExpressionEngine(model_dir=args.model_dir or None,
                              backend=args.backend)
    renderer = ExpressionRenderer(engine)
    common = dict(frames=args.frames or None, duration=args.duration or None,
                  fps=args.fps, out_frames=args.out_frames,
                  in_frames=args.in_frames, blink=not args.no_blink,
                  release=not args.no_release, seed=args.seed or None)
    if args.out:
        res = renderer.render_vmd(text, args.out, **common)
    else:
        res = renderer.build(text, dense=False, **common)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        _print_summary(res)


if __name__ == "__main__":
    main()
