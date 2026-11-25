"""后端本地执行的「情绪生成模型」工具。

本工具**不走浏览器**：它在后端进程内调用 `app.expressiongen`（内嵌的
text2motion 表情子系统）直接产出**仅 morph 段**的 VMD 字节。

★ 生成物只进「动作库（L2）」
    不写 storage/vmd、不建 VmdAsset；字节由 server 层通过桥接工具
    `import_emotion_vmd_bytes` 交给浏览器 parseVmd → 动作库。

与 `motion_model.py` 对称：
    available()          配置开关 + 依赖 + 模型是否存在
    generate()           情绪文本 -> morph-only VMD 字节
    render_records()     情绪文本 -> morph 关键帧记录（供 generate_vmd 合并）
"""

from __future__ import annotations

import logging
import time

from ...config import settings
from ...vmd_meta import parse_vmd_meta

log = logging.getLogger("editvmd.ai.tools.expression_model")


def available() -> bool:
    """配置开关 + 依赖 + 模型文件是否齐备。"""
    if not getattr(settings, "expr_enabled", True):
        return False
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    from ...expressiongen import _DATA  # 内嵌数据根

    return (_DATA / "model" / "expression" / "bge_expr_v1"
            / "head_numpy.npz").is_file()


def generate(
    text: str,
    *,
    name: str | None = None,
    frames: int | None = None,
    duration: float | None = None,
    blink: bool = True,
    seed: int | None = None,
) -> dict:
    """情绪文本 -> morph-only VMD 的**字节**（不落盘、不入库）。"""
    text = (text or "").strip()
    if not text:
        return {"ok": False, "reason": "没有提供情绪/表情描述"}

    if not available():
        return {
            "ok": False,
            "reason": "表情生成模型不可用（未安装 onnxruntime/tokenizers，或已在配置中禁用）",
        }

    from ...expressiongen import generate_expression as _generate

    t0 = time.perf_counter()
    result = _generate(
        text,
        frames=(int(frames) if frames else None),
        duration=(float(duration) if duration else None),
        blink=bool(blink),
        seed=seed,
    )
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    if not result.get("ok"):
        raw = str(result.get("reason") or "").strip()
        log.info("[expression_model] 无法生成 %r: %s", text, raw)
        return {
            "ok": False,
            "reason": raw or "没有识别出可用的表情",
            "elapsed_ms": elapsed_ms,
        }

    data: bytes = result["vmd_bytes"]
    meta = parse_vmd_meta(data)
    asset_name = (name or "").strip() or _default_name(text)

    log.info(
        "[expression_model] 生成成功 %r frames=%s morphs=%s %.0fms",
        text, result.get("frames") or meta["frame_count"],
        meta["morph_count"], elapsed_ms,
    )
    return {
        "ok": True,
        "name": asset_name,
        "frames": result.get("frames") or meta["frame_count"],
        "bone_count": 0,
        "morph_count": meta["morph_count"] or result.get("morph_count", 0),
        "vmd_bytes": data,
        "backend": result.get("backend"),
        "timeline_source": result.get("timeline_source"),
        "states": result.get("states") or [],
        "dropped": result.get("dropped") or [],
        "warnings": result.get("warnings") or [],
        "text": text,
        "elapsed_ms": elapsed_ms,
    }


def render_records(
    text: str,
    frames: int,
    *,
    blink: bool = True,
    seed: int | None = None,
) -> dict:
    """情绪文本 -> morph 关键帧记录（供 `generate_vmd` 合并到动作 VMD）。"""
    text = (text or "").strip()
    if not text:
        return {"ok": False, "reason": "没有提供情绪/表情描述", "records": []}
    if not available():
        return {"ok": False, "reason": "表情生成模型不可用", "records": []}

    from ...expressiongen import render_morph_records

    records, res = render_morph_records(
        text, max(1, int(frames)), blink=bool(blink), seed=seed,
    )
    if not records:
        return {
            "ok": False,
            "reason": "没有识别出可用的表情",
            "records": [],
            "backend": res.get("backend"),
            "states": res.get("states") or [],
        }
    return {
        "ok": True,
        "records": records,
        "backend": res.get("backend"),
        "timeline_source": res.get("timeline_source"),
        "states": res.get("states") or [],
        "dropped": res.get("dropped") or [],
        "warnings": res.get("warnings") or [],
    }


def _default_name(text: str) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) > 24:
        cleaned = cleaned[:24] + "…"
    return cleaned or "AI 生成表情"


__all__ = ["available", "generate", "render_records"]
