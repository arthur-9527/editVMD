"""后端本地执行的「动作生成模型」工具。

与其它编辑器工具的区别（重要）
----------------------------
`tools/server.py` 里的绝大多数工具是**薄转发**：后端把 (tool, args) 经 WS
发给浏览器，由前端 `ai/tools.ts` 执行。但本工具**不走浏览器** —— 它在后端
进程内调用 `app.motiongen`（内嵌的 text2motion 推理引擎）直接产出 VMD 字节。

★ 生成物只进「动作库（L2）」
    本函数**不写 storage/vmd、不建 VmdAsset**（那是用户显式存盘的 L3 冷数据）。
    只把字节 base64 回给 server 层，由 server 层通过桥接工具
    `import_vmd_bytes` 交给浏览器 parseVmd → 动作库（显示「未存盘」）。

「无法生成」的语义
-----------------
引擎对非动作指令 / 库外动作返回 ok=False（如「今天天气真不错」「跳个芭蕾」）。
这里不抛异常、不静默降级成参数化拼装，而是把原因如实交给模型，
由模型回复用户「无法生成：…」。

★ 动作 VMD 只含骨骼、不含表情
    `motiongen.generate` 已**不再**用本地模型的 stage 情绪生成 morph
    （见 backend/app/motiongen/__init__.py）。带表情的动作由 AI 把描述拆成
    「动作提示词 + 表情提示词」，动作工具把 expression 透传给前端表情引擎，
    按动作帧数生成并覆盖 morph。因此本工具返回的 `morph_count` 恒为 0，属正常。
"""

from __future__ import annotations

import logging
import time

from ...config import settings
from ...vmd_meta import parse_vmd_meta

log = logging.getLogger("editvmd.ai.tools.motion_model")


def available() -> bool:
    """配置开关 + 依赖是否就绪（依赖缺失时返回 False）。"""
    if not settings.t2m_enabled:
        return False
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return (settings.motiongen_dir / "data" / "clean" / "library_clean.npz").is_file()


def generate(
    text: str,
    *,
    name: str | None = None,
    duration: float | None = None,
) -> dict:
    """生成本地动作模型的**字节**（不落盘、不入库）。

    返回（成功）:
        {ok: True, name, frames, bone_count, morph_count, vmd_bytes,
         actions, operation, elapsed_ms}
    返回（无法生成）:
        {ok: False, reason, operation}
    """
    text = (text or "").strip()
    if not text:
        return {"ok": False, "reason": "没有提供动作描述", "operation": "unsupported"}

    if not available():
        return {
            "ok": False,
            "reason": "动作生成模型不可用（未安装 onnxruntime/tokenizers，或已在配置中禁用）",
            "operation": "unavailable",
        }

    # 延迟 import：motiongen 会拉起 onnxruntime，避免应用启动即加载
    from ...motiongen import generate as _generate

    t0 = time.perf_counter()
    result = _generate(text, duration=duration, compose="auto")
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    if not result.get("ok"):
        raw = str(result.get("reason") or "").strip()
        log.info("[motion_model] 无法生成 %r: %s", text, raw)
        # 面向用户的口语化原因（不暴露内部 operation 名）
        if not raw or "unsupported" in raw or "非动作指令" in raw:
            human = "没识别出可以做的动作（可能是舞蹈、杂技这类不支持的动作）"
        else:
            human = raw
        return {
            "ok": False,
            "reason": human,
            "operation": result.get("operation"),
            "elapsed_ms": elapsed_ms,
        }

    data: bytes = result["vmd_bytes"]
    meta = parse_vmd_meta(data)
    asset_name = (name or "").strip() or _default_name(text)

    log.info(
        "[motion_model] 生成成功 %r frames=%s %.0fms",
        text, result.get("frames") or meta["frame_count"], elapsed_ms,
    )
    return {
        "ok": True,
        "name": asset_name,
        "frames": result.get("frames") or meta["frame_count"],
        "bone_count": meta["bone_count"],
        "morph_count": meta["morph_count"],
        "vmd_bytes": data,
        "actions": result.get("actions", []),
        "operation": result.get("operation"),
        "text": text,
        "elapsed_ms": elapsed_ms,
    }


def _default_name(text: str) -> str:
    """用指令本身当片段名，过长截断。"""
    cleaned = " ".join(text.split())
    if len(cleaned) > 24:
        cleaned = cleaned[:24] + "…"
    return cleaned or "AI 生成动作"


__all__ = ["generate", "available"]

