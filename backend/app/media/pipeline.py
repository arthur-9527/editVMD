"""视频 → VMD 管线：动捕 + glb2vmd 转换 → **只产出字节**。

对外三个入口（都返回 VmdResult = 字节 + 元信息）：

    video_file_to_vmd(session, video_path, video_id, name)
        已有 mp4 文件（参考视频窗口上传的）→ 动捕 → glb2vmd → 旁挂 .vmd

    text_to_vmd(session, text, name, *, session_id, ...)
        能力1：text →（minimax.i2v，pose.png 固定首帧）→ mp4 → 动捕 → 旁挂 .vmd

    reference_to_vmd(session, session_id, ref, change, name, *, ...)
        能力3：既有视频（本会话产出）→（minimax.ref2v）→ mp4 → 动捕 → 旁挂 .vmd

★ 三级缓存语义（本文件的核心约定）
    AI / 视频生成的动作**只进「动作库（L2）」**，不进「存盘（L3）」：
      * 不写 storage/vmd/<id>.vmd
      * 不建 VmdAsset 行
    代价是「生成的 VMD 怎么交给前端」—— 前端只轮询 video status，
    所以把它**旁挂**在视频旁边：
      * 视频捕捉：storage/media/capture/actions/<video_id>.vmd
      * AI 视频：  storage/ai_workspace/<session_id>/ai_videos/<video_id>.vmd
      * 都不污染 vmd/ 存盘区，也不出现在「导入 VMD」列表里；
      * 前端按 video_id 拉字节 → parseVmd → 动作库（显示「未存盘」）。
    用户想长期保存时才手动点「存盘」，那一步才写进 storage/vmd（L3）。

★ 视频不再丢弃
    旧版 text_to_vmd 把 mp4 写到临时文件、动捕完 unlink，于是「这段视频」
    下一轮就没了，无法当参考视频再生成。现在 mp4 落到**会话专属目录**
    ai_workspace/<session_id>/ai_videos/ 并登记 VideoAsset（带 session_id）。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TypedDict

from sqlalchemy.orm import Session

from ..config import settings
from ..storage import ai_tmp_dir, write_ai_video_action, write_capture_action
from ..vmd_meta import parse_vmd_meta
from . import ai_videos, animchar, glb2vmd, minimax
from .errors import MediaError
from .prompt import build_i2v_prompt, build_refine_prompt

log = logging.getLogger("editvmd.media.pipeline")


class VmdResult(TypedDict):
    """生成产物的**字节**（而不是一份落盘的 VmdAsset）。"""

    vmd_bytes: bytes
    name: str
    frame_count: int
    bone_count: int
    morph_count: int


def _session_alive(session_id: str | None) -> bool:
    """生成中途会话是否还在（被删就不该再复活目录 / 落库）。"""
    if not session_id:
        return True
    try:
        from ..ai import store

        meta = store.get_session(session_id)
    except Exception:  # noqa: BLE001 - 查询失败按「还活着」处理，不误伤
        return True
    if meta is None:  # 镜像表里没有行：新会话首轮未完成
        return True
    return bool(meta.get("is_active", True))


def _abs(rel_path: str) -> Path:
    """VideoAsset.rel_path（相对 storage 根）→ 绝对路径。"""
    return settings.storage_root / rel_path


def _parent_video_id(session_id: str, ref: str) -> str | None:
    """找出参考视频对应的 video_assets.id（用于记录派生关系）。"""
    raw = (ref or "").strip()
    if len(raw) == 32 and all(c in "0123456789abcdefABCDEF" for c in raw):
        return raw.lower()
    try:
        rel = Path(raw).as_posix()
        for item in ai_videos.list_by_session(session_id, limit=200):
            vid = item.get("video_id")
            if vid and vid in rel:
                return vid
    except Exception:  # noqa: BLE001 - 记录派生关系失败不影响生成
        return None
    return None


def _result(name: str, data: bytes) -> VmdResult:
    meta = parse_vmd_meta(data)
    return {
        "vmd_bytes": data,
        "name": (name or "").strip() or "参考视频动作",
        "frame_count": meta["frame_count"],
        "bone_count": meta["bone_count"],
        "morph_count": meta["morph_count"],
    }


def _video_to_vmd_bytes(session: Session, video_path: Path, *, session_id: str | None = None) -> bytes:
    """动捕 + glb2vmd（PMX = 当前系统模型），返回 vmd 字节。

    ★ 中间产物（glb / 临时 vmd）落进**会话目录**的 tmp/ 下（不再写全局
      media/glb），保证「每个会话只能操控自己的目录」这条边界也覆盖临时文件；
      没有 session_id 时（参考视频窗口上传的）退回全局 media/glb。
    """
    pmx = glb2vmd.current_model_pmx(session)  # 当前系统正在用的模型
    if session_id:
        work = ai_tmp_dir(session_id)
    else:
        work = settings.media_glb_dir
    work.mkdir(parents=True, exist_ok=True)

    glb = work / f"{video_path.stem}.glb"
    animchar.capture_motion(video_path, glb)
    vmd_tmp = glb.with_suffix(".vmd")
    glb2vmd.convert(glb, vmd_tmp, pmx)
    data = vmd_tmp.read_bytes()
    # 清理临时产物（glb + vmd 中间文件）；最终字节由调用方旁挂到视频旁
    for p in (glb, vmd_tmp):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
    return data


def video_file_to_vmd(
    session: Session,
    video_path: Path,
    video_id: str,
    name: str,
    *,
    source_text: str | None = None,
    origin: str = "uploaded",
) -> VmdResult:
    """已有 mp4 → VMD。

    ★ 产物旁挂到 `media/capture/actions/<video_id>.vmd`（不进 storage/vmd）。
      调用方（routers/media._run_convert）据此回填 VideoAsset 状态并 commit。
    """
    data = _video_to_vmd_bytes(session, video_path)
    write_capture_action(video_id, data)
    result = _result(name, data)
    log.info("[pipeline] 视频→VMD（旁挂）video=%s frames=%s", video_id, result["frame_count"])
    return result


def text_to_vmd(
    session: Session,
    text: str,
    name: str,
    *,
    session_id: str,
    duration: int | None = None,
    resolution: str | None = None,
    ratio: str | None = None,
) -> tuple[VmdResult, object]:
    """能力1：text → i2v(pose.png) → mp4(存会话目录) → 动捕 → glb2vmd → 旁挂 VMD。

    Returns:
        (VmdResult, VideoAsset)。VideoAsset 带着 mp4 在会话目录里的位置，
        下一次「视频再编辑」直接用它当参考。
    """
    first_frame = settings.action_first_frame
    if not first_frame.is_file():
        raise MediaError("固定首帧 pose.png 不存在（系统未正确初始化）", code="missing_frame")

    prompt = build_i2v_prompt(text)
    mp4 = minimax.generate_i2v(
        first_frame, prompt,
        duration=duration, resolution=resolution, ratio=ratio,
    )

    # ★ 视频落进会话目录并登记（不再丢弃）
    video = ai_videos.save(session, session_id, mp4, name=name, source_text=text)

    if not _session_alive(session_id):
        ai_videos.mark_failed(session, video, "会话已删除，生成结果未入库")
        session.commit()
        raise MediaError("会话已删除，放弃本次生成")

    try:
        vmd_data = _video_to_vmd_bytes(session, _abs(video.rel_path), session_id=session_id)
    except MediaError as exc:
        ai_videos.mark_failed(session, video, str(exc))
        session.commit()
        raise
    except Exception as exc:  # noqa: BLE001 - 动捕异常也要把视频状态落成 failed
        ai_videos.mark_failed(session, video, f"动捕失败：{exc}")
        session.commit()
        raise

    result = _result(name, vmd_data)
    # 旁挂到会话目录（不进 storage/vmd），并把视频标记为 ready
    write_ai_video_action(session_id, video.id, vmd_data)
    ai_videos.mark_ready(session, video, result["frame_count"])
    session.commit()
    return result, video


def reference_to_vmd(
    session: Session,
    session_id: str,
    ref: str,
    change: str,
    name: str,
    *,
    duration: int | None = None,
    resolution: str | None = None,
    ratio: str | None = None,
) -> tuple[VmdResult, object]:
    """能力3：本会话视频 + 改动描述 → ref2v → mp4 → 动捕 → 旁挂 VMD。

    Args:
        ref: 参考视频（asset_id / 相对会话目录路径 / 会话目录内绝对路径）。
        change: 要改什么（如「挥手幅度再大一点」）。
    Returns:
        (VmdResult, 新 VideoAsset)；新视频的 parent_video_id 指向参考视频。
    """
    ref_path = ai_videos.resolve_reference(session, session_id, ref)
    parent_id = _parent_video_id(session_id, ref)

    prompt = build_refine_prompt(change)
    mp4 = minimax.generate_ref2v(
        ref_path, prompt,
        duration=duration, resolution=resolution, ratio=ratio,
    )
    video = ai_videos.save(
        session, session_id, mp4,
        name=name or f"{ref_path.stem} 调整版",
        source_text=change,
        parent_video_id=parent_id,
    )

    if not _session_alive(session_id):
        ai_videos.mark_failed(session, video, "会话已删除，生成结果未入库")
        session.commit()
        raise MediaError("会话已删除，放弃本次生成")

    try:
        vmd_data = _video_to_vmd_bytes(session, _abs(video.rel_path), session_id=session_id)
    except MediaError as exc:
        ai_videos.mark_failed(session, video, str(exc))
        session.commit()
        raise
    except Exception as exc:  # noqa: BLE001
        ai_videos.mark_failed(session, video, f"动捕失败：{exc}")
        session.commit()
        raise

    result = _result(name, vmd_data)
    write_ai_video_action(session_id, video.id, vmd_data)
    ai_videos.mark_ready(session, video, result["frame_count"])
    session.commit()
    return result, video


__all__ = [
    "VmdResult",
    "video_file_to_vmd",
    "text_to_vmd",
    "reference_to_vmd",
]
