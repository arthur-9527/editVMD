"""进程内动作生成引擎（text2motion 最小运行集）。

设计
----
本目录内嵌了 text2motion 的**运行期代码闭包**（`server/` + `tools/`，原样未改）
与模型/动作库数据（`data/`）。它**不是**可 import 的第三方包，只能靠文件在
`sys.path` 里被 import —— 所以「进程内调用」必然意味着「代码放进本项目」。

入口只有两个：
    engine.get_engine()   懒加载单例（首次约 2s，常驻约 66MB）
    engine.generate(text) 文本 → VMD 字节 + 动作信息

之所以放 `__init__.py` 而不是让调用方自己加 sys.path，是为了保证
`import <本项目>.motiongen.engine` 时两条路径（`motiongen/` 与 `motiongen/tools/`）
已经就位 —— 原代码用 `import dense_ops as dop` 这种**顶层裸模块名**互相引用。
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("editvmd.motiongen")

_ROOT = Path(__file__).resolve().parent
_TOOLS = _ROOT / "tools"

# ★ 顺序：先 tools 后 root。原作者在 dense_cache / part_index 里用
#   `sys.path.insert(0, parent)` 把自己目录加进去，这里等价地保证：
#   - `import dense_ops`（tools 内裸模块名）
#   - `from server.bridge import get_engine`（root 下的 server 包）
#   两种写法都能解析。
for _p in (str(_TOOLS), str(_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# ★ 线程数交给上层配置（settings.t2m_onnx_threads），必须在 server.config 被
#   import 之前落到环境变量里 —— 它会读取 T2M_ONNX_THREADS 并缓存。
def _apply_settings_env() -> None:
    import os

    try:
        from ..config import settings as _s

        os.environ.setdefault("T2M_ONNX_THREADS", str(_s.t2m_onnx_threads))
        if not _s.t2m_enabled:
            os.environ.setdefault("T2M_ENGINE", "v2")
    except Exception:  # noqa: BLE001 - 单独跑本模块（无上层配置）时忽略
        pass


_apply_settings_env()

_engine = None
_load_lock = threading.Lock()
_warmup_started = False


def _load_engine():
    # 延迟到真正调用时才 import：避免后端启动即拉起 onnxruntime（约 0.2s）。
    from server.bridge import get_engine as _bridge_get_engine

    return _bridge_get_engine(verbose=False)


def get_engine():
    """懒加载进程级单例引擎（线程安全）。"""
    global _engine
    if _engine is not None:
        return _engine
    with _load_lock:
        if _engine is None:
            _engine = _load_engine()
    return _engine


def is_loaded() -> bool:
    return _engine is not None


def warmup() -> None:
    """后台线程预热（幂等）。启动时调用，首个请求无需等待模型加载。"""
    global _warmup_started
    if _warmup_started:
        return
    _warmup_started = True

    def _run() -> None:
        try:
            t0 = time.perf_counter()
            get_engine()
            log.info("[motiongen] 预热完成 %.0f ms", (time.perf_counter() - t0) * 1000)
        except Exception as exc:  # noqa: BLE001 - 预热失败不应影响主服务
            log.warning("[motiongen] 预热失败（首次生成会重试）: %s", exc)

    threading.Thread(target=_run, daemon=True, name="motiongen-warmup").start()


def generate(text: str, *, duration: float | None = None,
             compose: bool | str = "auto") -> dict:
    """文本 → 动作。

    返回：
        {"ok": True, "vmd_bytes": bytes, "frames": int,
         "actions": [...], "operation": str}
        {"ok": False, "reason": str, "operation": str}
    """
    s = (text or "").strip()
    if not s:
        return {"ok": False, "reason": "文本为空", "operation": "unsupported"}

    eng = get_engine()
    res = eng.text_to_motion(s, use_stage=True, duration=duration, compose=compose)

    if not res.get("ok"):
        return {
            "ok": False,
            "reason": res.get("error") or res.get("reply") or "未识别出动作",
            "operation": res.get("operation"),
        }

    # ★ 动作 VMD **只含骨骼，不含表情**。
    #   表情由独立的「后端表情小模型」（app/expressiongen/）生成，
    #   再由 generate_vmd 合并成最终 VMD —— 不再依赖本地动作模型自带的
    #   stage 情绪（emotion_engine）来生成表情。
    #   `eng.build_emotion_morphs` 仍保留（供流式预览等别的路径使用），此处不调。
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "output.vmd"
        eng.motion_to_vmd(res["motion"], out)
        data = out.read_bytes()

    return {
        "ok": True,
        "vmd_bytes": data,
        "frames": int(res.get("frames", 0)),
        "actions": res.get("actions", []),
        "operation": res.get("operation") or "command",
    }


__all__ = ["get_engine", "generate", "warmup", "is_loaded"]
