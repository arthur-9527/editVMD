"""glb2vmd 薄封装：把 Mixamo `.glb` 转成 MMD `.vmd`。

★ 已内嵌转换器
    glb2vmd 的源码闭包已复制进 `backend/app/media/glb2vmd_core/`（见该包 __init__），
    本文件**直接进程内调用**，不再 subprocess / 不依赖外部目录或外部 venv。
    依赖 pygltflib / pymeshio 也已随包就位（见 requirements.txt）。

★ PMX 用「当前系统正在用的模型」
    目标模型不是配置项，而是从后端**工作区**解析：
        Workspace('current').data.model.assetId -> ModelAsset -> storage/models/<id>/<pmx>
    正常流程下当前模型必然先「上传到系统」才有 assetId（唯一入口见 App.tsx），
    因此这里能可靠定位。极端情况下返回可读错误。
"""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import settings
from ..models import ModelAsset, Workspace
from .errors import MediaError

log = logging.getLogger("editvmd.media.glb2vmd")


def current_model_pmx(session: Session) -> Path:
    """解析当前系统正在用的 PMX 路径。

    规则：工作区当前模型引用（assetId）-> storage/models/<id>/<pmx_file>。
    注意用 settings.models_dir / id / pmx_file 重建路径，不依赖 DB 里可能过时的绝对目录。
    """
    ws = session.get(Workspace, "current")
    data = (ws.data if ws is not None else None) or {}
    model_ref = data.get("model") or {}
    asset_id = model_ref.get("assetId")
    if not asset_id:
        raise MediaError(
            "当前模型尚未上传到系统，无法定位 PMX。请先在「文件 → 上传模型」把模型存进系统后再生成动作。",
            code="no_current_model",
        )
    asset = session.get(ModelAsset, asset_id)
    if asset is None:
        raise MediaError("当前模型资源已丢失，请重新上传模型", code="no_current_model")

    pmx = settings.models_dir / asset.id / asset.pmx_file
    if not pmx.is_file():
        raise MediaError(f"当前模型的 PMX 文件不存在：{asset.pmx_file}", code="missing_pmx")
    return pmx


def convert(glb: Path, vmd_out: Path, pmx: Path, *, scale: str = "auto") -> Path:
    """`.glb` -> `.vmd`（进程内）。失败抛 MediaError（含可读原因）。"""
    if not glb.is_file():
        raise MediaError(f"glb 文件不存在：{glb}")
    if not pmx.is_file():
        raise MediaError(f"目标 PMX 模型不存在：{pmx}")

    # 延迟 import：转换器会拉起 pygltflib/pymeshio，避免应用启动即加载
    from .glb2vmd_core.run import convert as _convert

    log.info("[glb2vmd] 转换：%s -> %s（PMX=%s）", glb.name, vmd_out.name, pmx.name)
    try:
        _convert(glb, pmx, vmd_out, scale=scale, ref_frame=0, frame_start=0)
    except ValueError as exc:
        raise MediaError(f"glb2vmd 转换失败：{exc}") from None
    except Exception as exc:  # noqa: BLE001 - 底层库异常统一转可读
        log.exception("[glb2vmd] 转换异常")
        raise MediaError(f"glb2vmd 转换异常：{exc}") from None

    if not vmd_out.is_file():
        raise MediaError("glb2vmd 未产出 vmd 文件")
    log.info("[glb2vmd] 完成：%s (%d KB)", vmd_out.name, vmd_out.stat().st_size // 1024)
    return vmd_out


__all__ = ["convert", "current_model_pmx"]
