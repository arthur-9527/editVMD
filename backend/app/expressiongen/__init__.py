"""进程内**表情生成**引擎（text2motion 表情子系统的最小运行集）。

设计（与 `app/motiongen/` 同构，但**完全自包含**）
--------------------------------------------------
本目录把 `~/raspi_mmd/text2motion` 的**表情子系统**运行期闭包原样搬进来：

    tools/expression_engine.py      推理：短语 → 小模型 → 规则；morph 生命周期（到点归零）
    tools/expression_schema.py      6 槽 / 35 原子 / 情绪配方 / 中文词表（唯一真源）
    tools/expression_head_numpy.py  分类头 numpy 前向（不需要 torch）
    tools/onnx_embedder.py          bge-large ONNX 编码（onnxruntime + tokenizers）
    tools/*.py                      分段 / DSL / 落盘等依赖

    data/                           词表 + 表情分类头 + **独立的 ONNX 编码器副本**

★ 为什么不复用 motiongen 的 ONNX
    两个引擎各自独立、互不共用文件（升级/替换互不影响）。代价是磁盘上多一份
    约 326MB 的 int8 编码器。

入口
----
    from app.expressiongen import generate_expression, render_morph_records

    r = generate_expression("开心地挥挥手", frames=90)
    r["vmd_bytes"]        # 仅 morph 段的 VMD 字节（骨骼段为空）
"""

from __future__ import annotations

import logging
import sys
import tempfile
import threading
import time
from pathlib import Path

log = logging.getLogger("editvmd.expressiongen")

_ROOT = Path(__file__).resolve().parent
_TOOLS = _ROOT / "tools"
_DATA = _ROOT / "data"

# ★ 原代码用 `import expression_schema as es` 这种顶层裸模块名互相引用，
#   因此必须把 tools/ 放进 sys.path；root 也加进去，保持与 motiongen 一致。
for _p in (str(_TOOLS), str(_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ---------------------------------------------------------------- 配置桥接

def _settings():
    """读取上层配置（单独运行本模块时返回 None）。"""
    try:
        from ..config import settings  # 延迟 import，避免循环依赖 / 启动即拉起 onnx
        return settings
    except Exception:  # noqa: BLE001
        return None


def _get(name: str, default):
    s = _settings()
    return getattr(s, name, default) if s is not None else default


def _default_frames() -> int:
    try:
        return max(1, int(_get("expr_default_frames", 90)))
    except Exception:  # noqa: BLE001
        return 90


def _planner_name(explicit: str | None = None) -> str:
    if explicit:
        return str(explicit).strip().lower()
    try:
        return str(_get("expr_planner", "legacy")).strip().lower()
    except Exception:  # noqa: BLE001
        return "legacy"


def _model_dir(planner: str) -> Path:
    """按 planner 选默认模型目录（上层可显式覆盖 expr_model_dir）。"""
    override = str(_get("expr_model_dir", "") or "")
    if override:
        p = Path(override)
        return p if p.is_absolute() else (_ROOT / p).resolve()
    if planner == "head":
        return _DATA / "model" / "expression" / "bge_expr_dsl_v3"
    return _DATA / "model" / "expression" / "bge_expr_v1"


def _onnx_dir() -> Path:
    return _DATA / "model" / "onnx" / "bge-large-zh-v1.5"


# ---------------------------------------------------------------- 单例

_renderer = None
_planner = None
_planner_kind = ""
_load_lock = threading.Lock()
_warmup_started = False


def _load_renderer(planner: str):
    """构造 ExpressionRenderer（线程安全由调用方的锁保证）。"""
    import expression_engine as ee

    neutral_bias = 1.05
    slot_thr = {"pupil": 0.7, "eyeUnder": 0.7}
    backend = "auto"
    try:
        neutral_bias = float(_get("expr_neutral_bias", 1.05))
        backend = str(_get("expr_backend", "auto") or "auto")
    except Exception:  # noqa: BLE001
        pass

    engine = ee.ExpressionEngine(
        model_dir=_model_dir(planner),
        backend=backend,
        verbose=False,
        neutral_bias=neutral_bias,
        slot_threshold=slot_thr,
    )
    return ee.ExpressionRenderer(engine, default_frames=_default_frames())


def get_renderer(planner: str | None = None):
    """懒加载进程级单例（thread-safe）。默认按配置选 legacy。"""
    global _renderer, _planner_kind
    kind = _planner_name(planner)
    if _renderer is not None and kind == _planner_kind:
        return _renderer
    with _load_lock:
        if _renderer is None or kind != _planner_kind:
            t0 = time.perf_counter()
            _renderer = _load_renderer(kind)
            _planner_kind = kind
            log.info(
                "[expressiongen] 引擎就绪 planner=%s backend=%s %.0f ms",
                kind, _renderer.engine.backend,
                (time.perf_counter() - t0) * 1000,
            )
    return _renderer


def get_head_planner():
    """可选的多头 planner（仅 expr_planner=head 时使用）。"""
    global _planner
    if _planner is not None:
        return _planner
    with _load_lock:
        if _planner is None:
            from expression_planner_head import HeadPlanner

            _planner = HeadPlanner(
                model_dir=_DATA / "model" / "expression" / "bge_expr_dsl_v3",
                emb_onnx_dir=_onnx_dir(),
                verbose=False,
                neutral_bias=3.0,
                union_rule=True,
            )
    return _planner


def is_loaded() -> bool:
    return _renderer is not None


def warmup() -> None:
    """后台线程预热（幂等）。启动时调用，首个请求无需等待模型加载。"""
    global _warmup_started
    if _warmup_started:
        return
    _warmup_started = True

    def _run() -> None:
        try:
            t0 = time.perf_counter()
            get_renderer()
            log.info("[expressiongen] 预热完成 %.0f ms",
                     (time.perf_counter() - t0) * 1000)
        except Exception as exc:  # noqa: BLE001 - 预热失败不影响主服务
            log.warning("[expressiongen] 预热失败（首次生成会重试）: %s", exc)

    threading.Thread(target=_run, daemon=True,
                     name="expressiongen-warmup").start()


# ---------------------------------------------------------------- 生成

def _build_result(text: str, *, planner: str, frames, duration,
                  blink: bool, seed) -> dict:
    """按 planner 渲染出统一结构（tracks + states + warnings）。"""
    if planner == "head":
        import expression_dsl as ed

        hp = get_head_planner()
        if hp.available:
            flat = hp.plan(text)
            res = ed.compile_dsl(
                flat, total_frames=(int(frames) if frames else None))
            states = []
            for name, keys in res["tracks"].items():
                peak = max((w for _f, w in keys), default=0.0)
                pf = next((f for f, w in keys if abs(w - peak) < 1e-6),
                          keys[0][0])
                states.append({"frame": int(pf), "text": "", "atoms": [name],
                               "weights": {name: round(peak, 4)},
                               "intensity": 1.0, "source": "dsl",
                               "top": round(peak, 4)})
            states.sort(key=lambda s: s["frame"])
            return {
                "text": text,
                "backend": "head",
                "fps": ed.FPS,
                "total": int(res["duration_frames"]) + 1,
                "duration_frames": int(res["duration_frames"]),
                "timeline_source": "head",
                "states": states,
                "tracks": res["tracks"],
                "dropped": [],
                "warnings": res.get("warnings") or [],
                "dsl": flat,
            }
        # 多头不可用 → 退回规则 DSL
        planner = "dsl"

    r = get_renderer(planner)
    if planner == "dsl":
        return r.build_dsl(text, frames=frames, duration=duration,
                           dense=False, seed=seed)
    return r.build(text, frames=frames, duration=duration,
                   blink=blink, release=True, dense=False, seed=seed)


def render_morph_records(
    text: str,
    frames: int,
    *,
    blink: bool = True,
    seed: int | None = None,
    planner: str | None = None,
) -> tuple[list, dict]:
    """情绪文本 -> (morph 记录, 结果)。**不落盘**。

    morph 记录格式 == `vmd_export.write_vmd(morphs=...)`：
        [(morph_name_jp, frame, weight), ...]
    """
    from expression_engine import to_morph_records

    res = _build_result(
        text, planner=_planner_name(planner), frames=max(1, int(frames)),
        duration=None, blink=blink, seed=seed,
    )
    return to_morph_records(res["tracks"]), res


def generate_expression(
    text: str,
    *,
    frames: int | None = None,
    duration: float | None = None,
    blink: bool = True,
    seed: int | None = None,
    planner: str | None = None,
    model_name: str = "expression",
) -> dict:
    """情绪文本 -> **morph-only VMD 字节**（骨骼段为空）。"""
    s = (text or "").strip()
    if not s:
        return {"ok": False, "reason": "文本为空"}

    kind = _planner_name(planner)
    try:
        res = _build_result(
            s, planner=kind,
            frames=(int(frames) if frames else None),
            duration=duration, blink=blink, seed=seed,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("[expressiongen] 生成失败 %r", s)
        return {"ok": False, "reason": str(exc)}

    tracks = res.get("tracks") or {}
    if not tracks:
        return {
            "ok": False,
            "reason": "没有识别出可用的表情",
            "backend": res.get("backend"),
            "states": res.get("states") or [],
            "dropped": res.get("dropped") or [],
            "warnings": res.get("warnings") or [],
        }

    from expression_engine import to_morph_records
    import vmd_export

    recs = to_morph_records(tracks)
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "expression.vmd"
        vmd_export.write_vmd([], out,
                             model_name=model_name or "expression",
                             morphs=recs)
        data = out.read_bytes()

    return {
        "ok": True,
        "vmd_bytes": data,
        "frames": int(res.get("total") or 0),
        "duration_frames": int(res.get("duration_frames") or 0),
        "morph_count": len(recs),
        "bone_count": 0,
        "backend": res.get("backend"),
        "timeline_source": res.get("timeline_source"),
        "planner": kind,
        "states": res.get("states") or [],
        "tracks": res.get("tracks") or {},
        "dropped": res.get("dropped") or [],
        "warnings": res.get("warnings") or [],
    }


__all__ = [
    "get_renderer",
    "get_head_planner",
    "generate_expression",
    "render_morph_records",
    "warmup",
    "is_loaded",
]

