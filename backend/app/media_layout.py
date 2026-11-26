"""一次性历史媒体目录迁移。

背景
----
旧版把所有参考视频与「视频→动作」生成的旁挂 VMD 都放在
`storage/media/videos/` 下，AI 视频的 VMD 也写在同一目录 ——
于是视频捕捉列表、AI 视频、生成动作混在一起。

新版目录（本模块负责把旧数据搬过去）：

    storage/media/capture/videos/<id>.mp4       参考视频窗口上传的视频
    storage/media/capture/actions/<id>.vmd      视频捕捉生成的动作
    storage/ai_workspace/<sid>/ai_videos/<id>.mp4|.vmd   AI 视频与动作

设计要点
--------
* **幂等**：目标已存在就跳过；源不存在但目标存在时只修数据库 rel_path。
* **不丢用户文件**：只移动 `video_assets` 里登记过的文件；无法归属的孤儿
  文件原样留在旧目录，只打印日志。
* **失败不阻断启动**：调用方捕获异常即可；接口侧仍保留旧路径回退。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from sqlalchemy import select

from .config import settings
from .db import SessionLocal
from .models import VideoAsset
from .storage import (
    PathEscapeError,
    ai_session_dir_exists,
    ai_video_action_path,
    ai_video_path,
    ai_video_rel_path,
    capture_action_path,
    capture_video_path,
    capture_video_rel_path,
    ensure_ai_session_dirs,
    legacy_media_action_path,
    legacy_media_video_path,
    resolve_under,
)

log = logging.getLogger("editvmd.media_layout")


def _move(src: Path, dst: Path) -> str:
    """把 src 移到 dst。

    返回 "moved" / "exists"（目标已存在）/ "missing"（源不存在）。
    """
    if dst.is_file():
        return "exists"
    if not src.is_file():
        return "missing"
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        # 同一 storage 根内通常同一文件系统，os.replace 最原子；
        # shutil.move 能兜住跨设备（Docker 挂载点）的情况。
        shutil.move(str(src), str(dst))
    except OSError as exc:  # noqa: BLE001 - 单个文件失败不阻断整次迁移
        log.warning("[media_layout] 移动失败 %s → %s：%s", src, dst, exc)
        return "error"
    return "moved"


def _capture_video_source(asset: VideoAsset) -> Path | None:
    """旧版捕捉视频路径（优先按 DB 里记录的 rel_path）。"""
    try:
        path = resolve_under(settings.storage_root, asset.rel_path)
    except PathEscapeError:
        path = None
    if path is not None and path.is_file():
        return path
    legacy = legacy_media_video_path(asset.id)
    return legacy if legacy.is_file() else path


def _migrate_capture(asset: VideoAsset, stats: dict[str, int]) -> None:
    desired_rel = capture_video_rel_path(asset.id)
    desired = capture_video_path(asset.id)

    src = _capture_video_source(asset)
    if src is not None and src.resolve() != desired.resolve():
        result = _move(src, desired)
        if result == "moved":
            stats["videos_moved"] += 1
        elif result == "exists":
            stats["videos_already"] += 1
        elif result == "missing":
            stats["videos_missing"] += 1
    elif desired.is_file():
        stats["videos_already"] += 1
    else:
        stats["videos_missing"] += 1

    # 动作旁挂：旧媒体目录 → capture/actions
    legacy_action = legacy_media_action_path(asset.id)
    result = _move(legacy_action, capture_action_path(asset.id))
    if result == "moved":
        stats["actions_moved"] += 1
    elif result == "exists":
        stats["actions_already"] += 1

    # 文件搬完再修 rel_path；目标不存在时保持旧值，读接口仍能 404 报错
    if desired.is_file() and asset.rel_path != desired_rel:
        asset.rel_path = desired_rel


def _migrate_ai(asset: VideoAsset, stats: dict[str, int]) -> None:
    session_id = asset.session_id
    if not session_id:
        return

    desired_rel = ai_video_rel_path(session_id, asset.id)
    desired = ai_video_path(session_id, asset.id)

    src = _capture_video_source(asset)
    if src is not None and src.resolve() != desired.resolve():
        result = _move(src, desired)
        if result == "moved":
            stats["videos_moved"] += 1
        elif result == "exists":
            stats["videos_already"] += 1
        elif result == "missing":
            stats["videos_missing"] += 1
    elif desired.is_file():
        stats["videos_already"] += 1
    else:
        stats["videos_missing"] += 1

    if desired.is_file() and asset.rel_path != desired_rel:
        asset.rel_path = desired_rel

    # AI 动作旁挂：旧 media/videos/<id>.vmd → 会话目录内的 ai_videos/<id>.vmd
    legacy_action = legacy_media_action_path(asset.id)
    if not legacy_action.is_file():
        return
    if not ai_session_dir_exists(session_id):
        # 会话目录已不存在（会话被删）→ 不把它塞回一个已删目录，留给人工/旧目录
        stats["orphan_actions"] += 1
        log.warning(
            "[media_layout] 会话目录不存在，保留旧 AI 动作文件：%s", legacy_action
        )
        return
    ensure_ai_session_dirs(session_id)
    result = _move(legacy_action, ai_video_action_path(session_id, asset.id))
    if result == "moved":
        stats["actions_moved"] += 1
    elif result == "exists":
        stats["actions_already"] += 1


def migrate_legacy_layout() -> dict[str, int]:
    """把旧目录里的历史视频/动作迁到新布局（幂等，可重复启动）。"""
    stats = {
        "videos_moved": 0,
        "videos_already": 0,
        "videos_missing": 0,
        "actions_moved": 0,
        "actions_already": 0,
        "orphan_actions": 0,
        "rows": 0,
    }

    with SessionLocal() as session:
        rows = session.execute(select(VideoAsset)).scalars().all()
        stats["rows"] = len(rows)
        for asset in rows:
            if asset.session_id:
                _migrate_ai(asset, stats)
            else:
                _migrate_capture(asset, stats)
            session.add(asset)
        session.commit()

    # 旧目录里剩下的、数据库没登记过的文件：不动，只提示
    legacy_dir = settings.media_videos_dir
    if legacy_dir.is_dir():
        leftovers = [p for p in legacy_dir.iterdir() if p.is_file()]
        if leftovers:
            log.warning(
                "[media_layout] 旧目录仍有 %d 个未登记文件（保持原样）：%s",
                len(leftovers),
                ", ".join(sorted(p.name for p in leftovers)[:8]),
            )

    log.info("[media_layout] 迁移统计：%s", stats)
    return stats


__all__ = ["migrate_legacy_layout"]
