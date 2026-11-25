#!/usr/bin/env python3
"""蒸馏推理 v2：分段 + 多标签 + margin 拒识 + 候选集温度加权随机。

相比旧 distill_engine.py:
  1. softmax argmax -> 多标签 sigmoid（一条文本可命中多个动作）
  2. 只返回 1 个 -> 返回有序动作序列（order + delay）
  3. 先分段（stage_segmenter），逐段分类，按段序拼接
  4. 拒绝判定与"选哪个"解耦
  5. accept 组去重

用法:
  from distill_engine_v2 import DistillEngineV2
  eng = DistillEngineV2("data/model/distill/bge_large_v2")
  eng.parse("先摆摆手，又鞠了个躬")
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import label_schema as ls  # noqa: E402
from action_history import HISTORY  # noqa: E402
from stage_segmenter import (  # noqa: E402
    split_stage, is_parallel, split_action_only, is_modifier,
)

# 默认模型目录与 server/config.py 的 DISTILL_V2_DIR 保持一致（v4）
#   v4 = M15 语料扩充重训版（val_F1 0.7731 / holdout hit@any 90.0%）
#   ★ 必须与 server/config.py 的默认值同步，否则工具脚本直跑
#     DistillEngineV2()（不传 model_dir）会加载到旧模型，结论会误导。
DEFAULT_DIR = ROOT / "data" / "model" / "distill" / "bge_large_v4"
BASE_DUR = 4.43
GAP = 0.25


def get_emb_dim(st) -> int:
    for name in ("get_embedding_dimension", "get_sentence_embedding_dimension"):
        fn = getattr(st, name, None)
        if fn is not None:
            try:
                return int(fn())
            except Exception:  # noqa: BLE001
                continue
    raise RuntimeError("无法获取 embedding 维度")


def build_torch_head(in_dim: int, n_ids: int, hidden: int, meta: dict):
    """延迟构造 torch 版分类头（顶层不 import torch，便于无 torch 部署）。

    结构必须与 distill_train_v2.MultiLabelHead 完全一致。
    """
    import torch.nn as nn

    class MultiLabelHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.trunk = nn.Sequential(
                nn.Linear(in_dim, hidden), nn.GELU(), nn.Dropout(0.2),
                nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(0.2),
            )
            self.id_head = nn.Linear(hidden, n_ids)
            self.side_head = nn.Linear(hidden, len(meta.get("side") or ls.SIDE_CLASSES))
            self.speed_head = nn.Linear(hidden, len(meta.get("speed") or ls.SPEED_CLASSES))
            self.strength_head = nn.Linear(
                hidden, len(meta.get("strength") or ls.STRENGTH_CLASSES))
            self.repeat_head = nn.Linear(
                hidden, len(meta.get("repeat") or ls.REPEAT_CLASSES))

        def forward(self, x):
            h = self.trunk(x)
            return (self.id_head(h), self.side_head(h), self.speed_head(h),
                    self.strength_head(h), self.repeat_head(h))

    return MultiLabelHead()


class DistillEngineV2:
    _instance: "DistillEngineV2 | None" = None

    def __init__(self, model_dir: str | Path | None = None,
                 device: str | None = None):
        d = Path(model_dir) if model_dir else DEFAULT_DIR
        if not (d / "head.pt").exists():
            raise FileNotFoundError(
                f"未找到 {d}/head.pt，请先跑 tools/distill_train_v2.py")

        meta = json.loads((d / "labels.json").read_text(encoding="utf-8"))
        self.ids: list[str] = meta["ids"]
        self.emb_model: str = meta["emb_model"]
        self.hidden: int = int(meta.get("hidden", 512))
        self.threshold: float = float(meta.get("threshold", 0.5))
        self.side_classes = meta.get("side", ls.SIDE_CLASSES)
        self.speed_classes = meta.get("speed", ls.SPEED_CLASSES)
        self.strength_classes = meta.get("strength", ls.STRENGTH_CLASSES)
        self.repeat_classes = meta.get("repeat", ls.REPEAT_CLASSES)

        # ---- 后端选择 ----
        #   T2M_EMB_BACKEND=onnx  → onnxruntime int8 + 纯 numpy 分类头（无需 torch）
        #   T2M_EMB_BACKEND=torch → 原路径（sentence-transformers + torch head）
        #   默认 auto：有 head_numpy.npz + ONNX 目录就用 onnx，否则回退 torch
        #
        # 优先读 server.config（服务内运行时），否则读环境变量（工具脚本直跑时）
        import os as _os_env
        try:
            from server import config as _cfg  # noqa: WPS433
            backend = (_cfg.EMB_BACKEND or "auto").strip().lower()
            onnx_dir = Path(_cfg.ONNX_DIR)
            onnx_threads = int(_cfg.ONNX_THREADS)
        except Exception:  # noqa: BLE001
            backend = (_os_env.environ.get("T2M_EMB_BACKEND") or "auto").strip().lower()
            onnx_dir = Path(_os_env.environ.get(
                "T2M_ONNX_DIR",
                str(ROOT / "data" / "model" / "onnx" / "bge-large-zh-v1.5")))
            onnx_threads = int(_os_env.environ.get("T2M_ONNX_THREADS", "2"))

        npz_path = d / "head_numpy.npz"

        if backend == "auto":
            backend = "onnx" if (onnx_dir.exists() and npz_path.exists()) else "torch"
        if backend == "onnx" and not (onnx_dir.exists() and npz_path.exists()):
            raise FileNotFoundError(
                f"ONNX 后端缺产物：dir={onnx_dir} exists={onnx_dir.exists()} "
                f"npz={npz_path} exists={npz_path.exists()}")

        self.backend = backend

        if backend == "onnx":
            from onnx_embedder import OnnxEmbedder
            from convert_head_numpy import NumpyHead
            self.emb = OnnxEmbedder(onnx_dir, intra_threads=onnx_threads)
            self.head = NumpyHead(npz_path)
            self.dim = self.emb.dim
        else:
            import torch  # 仅 torch 路径才导入
            from sentence_transformers import SentenceTransformer
            self.dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
            self.st = SentenceTransformer(self.emb_model, device=self.dev)
            self.dim = get_emb_dim(self.st)
            self.model = build_torch_head(
                self.dim, len(self.ids), self.hidden, meta)
            self.model.load_state_dict(
                torch.load(d / "head.pt", map_location=self.dev))
            self.model.eval()
            self.model.to(self.dev)

        self.by_id: dict[str, list[str]] = {}
        ap = ROOT / "data" / "action_aliases.json"
        if ap.exists():
            try:
                doc = json.loads(ap.read_text(encoding="utf-8"))
                self.by_id = doc.get("by_id", {}) or {}
            except json.JSONDecodeError:
                pass

        # 短语级确定性路由（最高优先级，优先于模型）
        #   用于修正模型对高频口语的系统性偏差，无需重训
        self.phrases: dict[str, list[str]] = {}
        self.reject_verbs: list[str] = []
        pp = ROOT / "data" / "action_phrases.json"
        if pp.exists():
            try:
                pdoc = json.loads(pp.read_text(encoding="utf-8"))
                self.phrases = {
                    self._norm_phrase(k): v
                    for k, v in (pdoc.get("phrases") or {}).items()
                }
                self.reject_verbs = [self._norm_phrase(v)
                                     for v in (pdoc.get("reject_verbs") or [])]
            except json.JSONDecodeError:
                pass

        # 可调参数（来自 tune_threshold.py 45 组网格搜索最优解）
        #   seg_thr=0.28  → holdout 误拒率 9.0%→6.3%
        #   cand_ratio=0.75 → 候选集略宽，配合温度随机
        #   temp=0.7 → top1 略占优，符合"权重差不多随机择一"
        # 可用环境变量覆盖，便于线上快速调
        import os as _os
        self.seg_thr = float(_os.environ.get("T2M_SEG_THR", "0.28"))
        self.cand_ratio = float(_os.environ.get("T2M_CAND_RATIO", "0.75"))
        self.temp = float(_os.environ.get("T2M_SAMPLE_TEMP", "0.7"))
        # 段级相对置信度阈值：0 = 关闭（默认）。
        # 设为 0.55 等值会启用过滤：set_match 略升但 hit@any 下降，净负收益。
        self.seg_rel_thr = float(_os.environ.get("T2M_SEG_REL_THR", "0"))
        self.reject_all = True

        # 动作输出历史（全进程共用，防止同一动作被反复选中）
        self.history = HISTORY

        self._rng = random.Random()

    @classmethod
    def get(cls, model_dir=None) -> "DistillEngineV2":
        if cls._instance is None:
            cls._instance = cls(model_dir)
        return cls._instance

    def _forward(self, text: str):
        """统一前向：返回 (id_probs[202], aux_idx_dict)。

        onnx 后端走 onnxruntime + numpy，torch 后端走原 sentence-transformers 路径。
        """
        if self.backend == "onnx":
            v = self.emb.encode([text])[0]
            out = self.head.forward(v[None, :].astype(np.float32))
            logits_id = out["id"][0]
            probs = 1.0 / (1.0 + np.exp(-logits_id))
            aux_idx = {
                "side": int(out["side"][0].argmax()),
                "speed": int(out["speed"][0].argmax()),
                "strength": int(out["strength"][0].argmax()),
                "repeat": int(out["repeat"][0].argmax()),
            }
            return probs, aux_idx

        import torch
        v = self.st.encode([text], normalize_embeddings=True,
                           show_progress_bar=False,
                           convert_to_numpy=True)[0]
        x = torch.from_numpy(np.asarray([v], dtype=np.float32)).to(self.dev)
        with torch.no_grad():
            oid, oside, ospd, ostr, orep = self.model(x)
        probs = torch.sigmoid(oid)[0].cpu().numpy()
        aux_idx = {
            "side": int(oside[0].argmax()),
            "speed": int(ospd[0].argmax()),
            "strength": int(ostr[0].argmax()),
            "repeat": int(orep[0].argmax()),
        }
        return probs, aux_idx

    @staticmethod
    def _norm_phrase(s: str) -> str:
        """短语归一化：去空白/标点，便于精确匹配。"""
        import re as _re
        return _re.sub(r"[\s，,。.！!？?、；;：:（）()\"'~—\-]+", "", s or "")

    # ---- 副词剥离兜底（M15）----
    #
    # 为什么需要
    #   训练语料里速度/幅度副词只占 ~11%，仍有长尾组合学不到
    #   （实测「迅速跳起来」v4 仍被拒识）。
    #   这类句子的问题不在**动作**，而在**副词**：
    #     快速挥手 → 模型 top1 0.107（拒识）
    #     挥手     → 模型 top1 0.756（正确）
    #
    #   所以当模型给出"无候选"时，剥掉副词再预测一次：
    #     动作 ID 从**剥离后**的文本取（动作识别更准）
    #     speed/strength 从**原句**取（副词信息不丢）
    #
    #   实测收益（v3 上）：快速挥手/快速鼓掌/快速比个心/迅速跳起来 全部救回。
    _ADV_STRIP_RE = None

    @classmethod
    def _adv_strip_re(cls):
        if cls._ADV_STRIP_RE is None:
            import re as _re
            words = (
                "快速地", "飞快地", "迅速地", "慢慢", "缓缓", "快速", "飞快",
                "迅速", "赶紧地", "赶紧", "连忙", "急忙", "用力地", "使劲地",
                "轻轻地", "微微地", "小幅地", "大幅地", "重重地", "狠狠地",
                "猛地", "一下子", "急速", "猛地",
                "用力", "使劲", "轻轻", "微微", "小幅", "大幅", "重重",
                "急速地",
            )
            # 长的优先，避免「快速」抢先匹配「快速地」
            words = sorted(set(words), key=len, reverse=True)
            cls._ADV_STRIP_RE = _re.compile("|".join(words))
        return cls._ADV_STRIP_RE

    def _strip_adverbs(self, text: str) -> str:
        """剥掉速度/幅度副词，返回干净的动作文本（可能等于原文）。"""
        rx = self._adv_strip_re()
        s = rx.sub("", text or "")
        # 去掉剥离后残留的「地」「了」开头/孤立
        import re as _re
        s = _re.sub(r"^[地得]+", "", s.strip())
        s = s.strip(" ，,、地得了着")
        return s if len(s) >= 2 else ""

    def _phrase_route(self, text: str,
                      exact_only: bool = False) -> list[tuple[str, float]] | None:
        """短语路由。

        Args:
          exact_only=True  → 只做整句精确命中（用于「优先覆盖」场景）
          exact_only=False → 精确命中 + 受限包含匹配（用于「兜底救回」场景）

        命中返回 [(id, score), ...]；未命中返回 None 交给模型。
        分数按列表位置递减：0.99, 0.95, 0.91...
        """
        if not self.phrases:
            return None
        key = self._norm_phrase(text)
        if not key:
            return None
        # 精确命中：整句归一化后与短语完全相等
        hit = self.phrases.get(key)

        if exact_only and hit is None:
            return None

        # 包含匹配：仅在短语占整句绝大部分时才允许，否则交给模型
        # 反例（必须拦截）：「边讲边点头」含「点头」但主动作是「讲」；
        #                  「无奈地揉了揉太阳穴」含「揉太阳穴」但应交给模型仲裁。
        # 规则：短语长度 >= 整句 70%，且短语必须出现在句首或句尾附近。
        if hit is None:
            best_key, best_cover = "", 0.0
            L = len(key)
            for k in self.phrases:
                if len(k) < 2 or k not in key:
                    continue
                cover = len(k) / L

                # 规则 A（长短语）：覆盖率 >= 70% 且贴近首尾
                # 规则 B（短动词）：2~3 字的核心动词（如「蹲」「弯腰」）只要在句首
                #                 就允许低覆盖率——因为「蹲在角落揉脚踝」主动作确实是蹲。
                short_verb_lead = (len(k) <= 3 and key.startswith(k))
                if cover >= 0.70:
                    lead_ok = key.startswith(k) and (L - len(k)) <= 6
                    tail_ok = key.endswith(k) and (L - len(k)) <= 6
                    if not (lead_ok or tail_ok):
                        continue
                elif short_verb_lead:
                    # 短动词在句首：覆盖率放宽到 >= 15% 即可
                    if cover < 0.15:
                        continue
                else:
                    continue

                # 越长的短语越优先（避免「蹲」抢「蹲下」）
                score_key = (cover, len(k))
                if score_key > (best_cover, len(best_key)):
                    best_cover, best_key = cover, k
            if not best_key:
                return None
            hit = self.phrases[best_key]
        # 按「历史权重」重排：最近用得少的排前面，拿高分。
        # 这样可接受组（如 走起来 -> [G13-01a, G5-07a]）会真正轮换，
        # 而不是第一个几乎恒定被选中。
        ranked = sorted(hit, key=lambda a: -self.history.penalty(a))
        out = []
        for i, aid in enumerate(ranked):
            # 同组内权重接近，交给温度随机；按优先级略递减
            score = round(0.99 - i * 0.04, 4)
            out.append((aid, score))
        return out

    def _predict_segment(self, text: str) -> dict:
        """单段预测：三层优先级。

        层次（按顺序）：
          1. **精确短语命中**（整句归一化后与 phrases 键完全相等）
             → 直接采用。这类是人工确认过的高频口语（走起来/跳起来/捂脸笑），
               模型训练分布里学不到，必须靠确定性路由。
          2. **模型预测**
             → 有多标签候选就用，这是主力。
          3. **包含匹配兜底**
             → 仅当模型无候选（即将拒识）时，才用「短语 + 修饰」的包含匹配救回。
               避免「边讲边点头」被「点头」这类宽匹配误伤。
        """
        # ① 精确短语命中：优先级最高
        exact = self._phrase_route(text, exact_only=True)
        if exact:
            return {
                "cands": exact,
                "aux": {"side": None, "speed": 1.0,
                        "strength": 1.0, "repeat": 1},
                "routed": "exact",
            }

        probs, aux_idx = self._forward(text)
        oside_val = self.side_classes[aux_idx["side"]]
        ospd_val = self.speed_classes[aux_idx["speed"]]
        ostr_val = self.strength_classes[aux_idx["strength"]]
        orep_val = self.repeat_classes[aux_idx["repeat"]]

        top1 = float(probs.max())
        cands: list[tuple[str, float]] = []
        if top1 >= self.seg_thr:
            base = top1 * self.cand_ratio
            for i, p in enumerate(probs):
                if p >= self.seg_thr and p >= base:
                    cands.append((self.ids[i], float(p)))
            cands.sort(key=lambda kv: -kv[1])

        aux = {
            "side": oside_val,
            "speed": float(ospd_val),
            "strength": float(ostr_val),
            "repeat": int(orep_val),
        }

        # ③ 兜底 A：副词剥离后重试（M15）
        #   模型对「快速挥手」类句子容易压到阈值以下，
        #   但剥掉副词后「挥手」通常有 0.7+ 的强候选。
        #   aux 仍用**原句**的预测，保证 speed=1.5 不丢。
        if not cands:
            stripped = self._strip_adverbs(text)
            if stripped and stripped != text:
                p2, _aux2 = self._forward(stripped)
                top2 = float(p2.max())
                if top2 >= self.seg_thr:
                    base2 = top2 * self.cand_ratio
                    for i, pv in enumerate(p2):
                        if pv >= self.seg_thr and pv >= base2:
                            cands.append((self.ids[i], float(pv)))
                    cands.sort(key=lambda kv: -kv[1])
                    if cands:
                        return {"cands": cands, "aux": aux,
                                "routed": "adverb_strip"}

        # ③ 兜底 B：模型无候选（即将拒识）时才用包含匹配救回
        if not cands:
            routed = self._phrase_route(text)  # 含精确 + 受限包含
            if routed:
                return {"cands": routed, "aux": aux, "routed": "fallback"}

        return {"cands": cands, "aux": aux}

    def _sample(self, cands: list[tuple[str, float]],
                apply_penalty: bool = True) -> tuple[str, float]:
        """温度加权随机；apply_penalty 时再乘「历史权重」。

        - 候选集只有 1 个动作：直接返回，完全跳过权重计算
          （保证「用户就要这一个动作」时不会因历史降权而丢失）。
        - 组合动作场景由调用方传 apply_penalty=False，行为与改动前一致。
        """
        if not cands:
            return None, 0.0
        if len(cands) == 1:
            return cands[0]
        ps = np.array([c[1] for c in cands], dtype=np.float64)
        ps = np.power(ps, 1.0 / max(self.temp, 1e-6))
        if apply_penalty:
            pen = np.array([self.history.penalty(c[0]) for c in cands],
                           dtype=np.float64)
            ps = ps * pen
        s = ps.sum()
        if s <= 0:
            return cands[0]
        ps = ps / s
        idx = self._rng.choices(range(len(cands)), weights=ps.tolist(), k=1)[0]
        return cands[idx]

    def parse(self, text: str, seed: int | None = None) -> dict:
        s = (text or "").strip()
        if not s:
            return {"operation": "unsupported", "actions": [],
                    "reply": "", "confidence": 0.0}

        if any(w in s for w in ("停下", "停止", "别动", "站好", "不动")):
            return {"operation": "release", "actions": [],
                    "reply": "好，停下了。", "confidence": 1.0}

        # 库外动词黑名单：明确做不了的动作直接拒，避免模型误给相近动作
        # （如"跳个芭蕾"曾被判成跳跃）
        _norm_all = self._norm_phrase(s)
        for rv in self.reject_verbs:
            if rv and rv in _norm_all:
                return {"operation": "unsupported", "actions": [],
                        "reply": "这个我还没学会呢。", "confidence": 0.0}

        if seed is not None:
            self._rng = random.Random(seed)

        # ① 切段。
        #    `split_action_only`（过滤修饰分句）经 A/B 实测为负收益：
        #    hit@any 81.8%→79.8%，set_match 29.4%→24.8%，因为它会误删
        #    「露出一点眼睛」这类含状态词但实为动作的段。
        #    故默认不启用；如需实验可设 T2M_USE_MODIFIER_FILTER=1。
        import os as _os2
        if _os2.environ.get("T2M_USE_MODIFIER_FILTER", "0") in ("1", "true", "True"):
            segs = split_action_only(s)
        else:
            segs = split_stage(s)

        # ② 逐段预测，记录每段最高分，用于后续"相对主段"过滤
        preds: list[dict] = []
        for seg in segs:
            res = self._predict_segment(seg)
            cands = res["cands"]
            top = cands[0][1] if cands else 0.0
            preds.append({"seg": seg, "res": res, "top": top})

        # ③ 相对置信度过滤（默认关闭，seg_rel_thr 默认 0 = 不过滤）
        #    A/B 实测：开启后 set_match +1.4pt 但 hit@any -1.7pt，
        #    净收益为负，故默认关闭。修饰段过滤（split_action_only）仍生效。
        if self.seg_rel_thr > 0:
            max_top = max((p["top"] for p in preds), default=0.0)
            if max_top > 0:
                thr = max_top * self.seg_rel_thr
                preds = [p for p in preds if p["top"] >= thr or p["top"] >= 0.95]

        # 只有「单段单动作」场景才启用历史降权 + 记录；
        # 组合句（多段）保持原有随机行为，不受历史影响。
        n_valid_seg = sum(1 for p in preds if p["res"]["cands"])
        apply_penalty = (n_valid_seg == 1)

        actions: list[dict] = []
        cursor = 0.0
        used_ids: set[str] = set()
        conf_max = 0.0

        for p in preds:
            seg = p["seg"]
            res = p["res"]
            cands = res["cands"]
            if not cands:
                continue
            cands = self._dedup_cands(cands, used_ids)
            if not cands:
                continue
            picked_id, picked_p = self._sample(cands, apply_penalty=apply_penalty)
            if not picked_id:
                continue

            aux = res["aux"]
            actions.append({
                "id": picked_id,
                "order": len(actions),
                "side": aux["side"],
                "speed": aux["speed"],
                "strength": aux["strength"],
                "repeat": aux["repeat"],
                "delay": round(cursor, 3),
                "confidence": round(picked_p, 3),
                "segment": seg,
            })
            used_ids.add(picked_id)
            conf_max = max(conf_max, picked_p)

            dur = (BASE_DUR / max(aux["speed"], 0.1) * max(aux["repeat"], 1))
            cursor += dur + GAP

        if not actions:
            reply = "这个我还没学会呢。" if self.reject_all else ""
            return {"operation": "unsupported", "actions": [],
                    "reply": reply, "confidence": 0.0}

        # 输出即记录：仅单个动作时记入历史（组合动作不记录、不参与降权）
        if len(actions) == 1:
            self.history.note(actions[0]["id"], source="user")

        return {"operation": "command", "actions": actions, "reply": "",
                "confidence": round(conf_max, 3), "segments": segs}

    def _dedup_cands(self, cands: list[tuple[str, float]],
                     used: set[str]) -> list[tuple[str, float]]:
        if not used:
            return cands
        out = []
        for cid, p in cands:
            sib = set(self.by_id.get(cid, [])) | {cid}
            if sib & used:
                continue
            out.append((cid, p))
        return out

    def debug(self, text: str) -> dict:
        segs = split_stage(text)
        info = []
        for seg in segs:
            res = self._predict_segment(seg)
            info.append({
                "segment": seg,
                "parallel": is_parallel(seg),
                "cands": [{"id": i, "p": round(p, 4)} for i, p in res["cands"]],
                "aux": res["aux"],
            })
        return {"text": text, "segments": info}


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("texts", nargs="*", default=None)
    ap.add_argument("--model-dir", default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    eng = DistillEngineV2(args.model_dir)
    cases = args.texts or [
        "先摆摆手，又鞠了个躬",
        "一边笑一边鼓掌",
        "开心地挥挥手",
        "委屈地低下头，然后擦了擦眼睛",
        "托着腮帮子，出神地想事情",
        "走起来",
        "走路",
        "开心的跑起来",
        "生气的跳起",
        "捂脸笑",
        "悲伤的捂脸",
    ]
    for t in cases:
        out = eng.parse(t, seed=args.seed)
        acts = out["actions"]
        detail = " + ".join(
            f"{a['id']}(p={a['confidence']},d={a['delay']})" for a in acts
        ) or "REJECT"
        print(f"{t:<24} => {detail}")
        if args.debug:
            print(json.dumps(eng.debug(t), ensure_ascii=False, indent=1))