"""AI 会话视频的落盘 / 归属 / 解析 / 清理。

为什么单独一个模块
------------------
AI 生成的视频有**三重身份**：
    ① 一份 mp4 文件（落在**会话专属目录**里，可被模型当成参考视频回传）；
    ② 一条 `video_assets` 行（带 `session_id`，用于删除会话时连带清理）；
    ③ 一份 VMD 的**字节来源**（旁挂在 media/videos/<id>.vmd，不随会话删除）。

这三件事以前散落在 pipeline / router / manager 里，容易漏。这里统一收口：

    save()              mp4 字节 → 会话目录 + VideoAsset(status="queued")
    resolve_reference() 把模型给的 ref（asset_id / 相对路径 / 绝对路径）
                        **安全地**解析成一个可读的 mp4 路径
    mark_ready()        动捕完成后回填 status="ready" + frame_count（不写 vmd_asset_id）
    delete_by_session() 删会话时：删 video_assets 行 + rmtree 会话目录

★ 安全边界（需求：每个会话只能操控自己的目录）
   `resolve_reference` 只放行两种 ref：
     * 32 位 hex 的 asset_id —— 且必须属于**本会话**，或是一份**上传类**视频
       （参考视频窗口上传的，用户显式给了许可）；
     * 路径 —— resolve 之后必须落在**本会话目录**内。
   其它一切（`../`、绝对路径越界、别的会话的目录）都抛 MediaError，
   错误信息是中文可读的，会原样回给模型，让它自己改。
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import VideoAsset, VmdAsset
from ..storage import (
    PathEscapeError,
    ai_session_root,
    ai_video_path,
    ai_video_rel_path,
    delete_ai_session_dir,
    ensure_ai_session_dirs,
    resolve_under,
)
from .errors import MediaError

log = logging.getLogger("editvmd.media.ai_videos")

# asset_id 的形状：uuid4().hex
_HEX32 = set("0123456789abcdef")


def _looks_like_asset_id(value: str) -> bool:
    return len(value) == 32 and set(value.lower()) <= _HEX32


def _new_id() -> str:
    return uuid.uuid4().hex


# ---------------------------------------------------------------- 写入


def save(
    session: Session,
    session_id: str,
    data: bytes,
    *,
    name: str,
    source_text: str | None = None,
    parent_video_id: str | None = None,
    duration_ms: int | None = None,
) -> VideoAsset:
    """把 mp4 字节写进**本会话目录**，并落一条 VideoAsset（status=queued）。

    注意：不在这里 commit —— 由调用方（pipeline）把「视频 + VMD」放在
    同一事务里提交，避免出现「视频已落库、VMD 没落」的半成品。
    """
    if not data:
        raise MediaError("生成的视频为空")
    if not session_id:
        raise MediaError("缺少会话 id，无法保存视频")

    video_id = _new_id()
    ensure_ai_session_dirs(session_id)
    dest = ai_video_path(session_id, video_id)
    dest.write_bytes(data)

    asset = VideoAsset(
        id=video_id,
        name=(name or "").strip() or f"AI 视频 {video_id[:6]}",
        origin="generated",
        rel_path=ai_video_rel_path(session_id, video_id),
        size_bytes=len(data),
        duration_ms=duration_ms,
        status="queued",
        source_text=source_text,
        session_id=session_id,
        parent_video_id=parent_video_id,
        sha256=hashlib.sha256(data).hexdigest(),
    )
    session.add(asset)
    session.flush()
    log.info("[ai_videos] 保存视频 %s（会话 %s，%d KB）", video_id, session_id, len(data) // 1024)
    return asset


def mark_ready(
    session: Session,
    video: VideoAsset,
    frame_count: int | None = None,
) -> None:
    """动捕完成后回填：status=ready + frame_count。

    ★ 不再写 `vmd_asset_id`：生成物只进「动作库（L2）」，不是一份 storage/vmd
      资源行。VMD 字节**旁挂**在视频旁边（media/videos/<id>.vmd），前端按
      video_id 拉取。`vmd_asset_id` 恒为 null。
    """
    video.status = "ready"
    video.error = None
    if frame_count is not None:
        video.frame_count = frame_count
    session.add(video)
    session.flush()



def mark_failed(session: Session, video: VideoAsset, reason: str) -> None:
    """失败也落库（前端/模型能看到原因），但视频文件保留。"""
    video.status = "failed"
    video.error = reason
    session.add(video)
    session.flush()


# ---------------------------------------------------------------- 解析参考


def resolve_reference(session: Session, session_id: str, ref: str) -> Path:
    """把模型给的 reference 解析成本会话内一个**可读的 mp4 路径**。

    ref 支持三种写法：
        1. 32 位 hex                    → 按 asset_id 查 video_assets
        2. 相对会话目录的路径           → ai_videos/xxx.mp4
        3. 会话目录内的绝对路径         → /.../ai_workspace/<sid>/ai_videos/xxx.mp4

    校验：必须 .mp4、必须存在、必须 ≤ video_max_mb、必须在**本会话**内。
    """
    raw = (ref or "").strip().strip("\"'")
    if not raw:
        raise MediaError("缺少参考视频（reference 为空）")

    # ---- ① asset_id ----
    if _looks_like_asset_id(raw):
        asset = session.get(VideoAsset, raw.lower())
        if asset is None:
            raise MediaError(f"参考视频不存在：{raw}")
        if asset.session_id and asset.session_id != session_id:
            raise MediaError("这段视频属于其它会话，不能作为参考")
        try:
            path = resolve_under(settings.storage_root, asset.rel_path)
        except PathEscapeError as exc:
            raise MediaError(f"视频路径非法：{exc}") from None
        return _validate_video(path)

    # ---- ② / ③ 路径 ----
    root = ai_session_root(session_id).resolve()
    raw_path = Path(raw)
    if raw_path.is_absolute():
        candidate = raw_path.resolve()
    else:
        # 相对路径：按「会话目录」解析（= AI 的 cwd）
        try:
            candidate = resolve_under(root, raw)
        except PathEscapeError:
            raise MediaError(
                f"路径必须在你自己会话的目录内：{raw}"
            ) from None

    try:
        candidate.relative_to(root)
    except ValueError:
        raise MediaError(
            f"路径必须在你自己会话的目录内（不能跨会话 / 越权）：{raw}"
        ) from None

    return _validate_video(candidate)


def _validate_video(path: Path) -> Path:
    if not path.is_file():
        raise MediaError(f"参考视频文件不存在：{path.name}")
    if path.suffix.lower() != ".mp4":
        raise MediaError(f"参考视频必须是 mp4（收到 {path.suffix or '无扩展名'}）")
    size_mb = path.stat().st_size / (1024 * 1024)
    if size_mb > settings.video_max_mb:
        raise MediaError(
            f"参考视频过大（{size_mb:.0f}MB > {settings.video_max_mb}MB），无法再生成"
        )
    return path


# ---------------------------------------------------------------- 清理


def delete_by_session(session_id: str) -> dict:
    """删除会话时调用：删该会话的 video_assets 行 + 整个会话沙箱目录。

    ★ 只删视频，**不删 VMD**（`storage/vmd/*.vmd` 与用户动作库里的片段保留）。
    独立开会话（不接收外部 Session），返回统计信息方便日志核对。
    """
    if not session_id:
        return {"videos": 0, "vmd_kept": 0, "dir_removed": False}

    from ..db import SessionLocal

    removed = 0
    vmd_kept = 0
    try:
        with SessionLocal() as db:
            rows = (
                db.execute(select(VideoAsset).where(VideoAsset.session_id == session_id))
                .scalars()
                .all()
            )
            removed = len(rows)
            vmd_kept = sum(1 for r in rows if r.vmd_asset_id)
            for row in rows:
                db.delete(row)
            db.commit()
    except Exception as exc:  # noqa: BLE001 - 清理失败不阻断会话删除
        log.warning("[ai_videos] 删除会话视频行失败 %s: %s", session_id, exc)

    had_dir = ai_session_root(session_id).is_dir()
    try:
        delete_ai_session_dir(session_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("[ai_videos] 删除会话目录失败 %s: %s", session_id, exc)

    log.info(
        "[ai_videos] 会话 %s 清理完成：删视频 %d 条（保留 VMD %d 份），目录删除=%s",
        session_id, removed, vmd_kept, had_dir,
    )
    return {"videos": removed, "vmd_kept": vmd_kept, "dir_removed": had_dir}


def list_by_session(session_id: str, limit: int = 50) -> list[dict]:
    """列出某会话产出的视频（供工具结果 / 调试用）。"""
    from ..db import SessionLocal

    try:
        with SessionLocal() as db:
            rows = (
                db.execute(
                    select(VideoAsset)
                    .where(VideoAsset.session_id == session_id)
                    .order_by(VideoAsset.created_at.desc())
                    .limit(limit)
                )
                .scalars()
                .all()
            )
            return [
                {
                    "video_id": r.id,
                    "name": r.name,
                    "status": r.status,
                    "frames": r.frame_count,
                    "vmd_asset_id": r.vmd_asset_id,
                }
                for r in rows
            ]
    except Exception as exc:  # noqa: BLE001
        log.warning("[ai_videos] 列出会话视频失败 %s: %s", session_id, exc)
        return []


def vmd_exists(session: Session, vmd_asset_id: str | None) -> bool:
    if not vmd_asset_id:
        return False
    return session.get(VmdAsset, vmd_asset_id) is not None


__all__ = [
    "save",
    "mark_ready",
    "mark_failed",
    "resolve_reference",
    "delete_by_session",
    "list_by_session",
    "vmd_exists",
]
