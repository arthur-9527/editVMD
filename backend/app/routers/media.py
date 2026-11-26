"""视频捕捉接口：上传 / 列表 / 预览 / 生成动作 / 删除 / 丢弃生成物。

语义（务必保持）
----------------
* 「参考视频 → 动作」是**用户显式操作**（UI 悬浮窗按钮），不对外暴露成 AI 工具。
* **一视频一动作**：每个视频只生成一次。转换成功即把 status 置 ready；
  之后再来转换会被 409 拒绝；删除视频会**连带删除**它生成的动作文件；
  用户在动作库删掉动作时，前端会调「丢弃生成物」接口把视频退回 queued，
  于是可以重新生成。
* ★ 视频捕捉有**独立目录与独立接口**（`/api/media/capture/videos/*`）：
      storage/media/capture/videos/<id>.mp4    上传的视频
      storage/media/capture/actions/<id>.vmd   生成的动作（旁挂，只进动作库 L2）
  AI 生成的视频与动作在 `storage/ai_workspace/<sid>/ai_videos/`，
  列表与接口都只认上述 capture 行，AI 产物不会混进「参考视频」窗口。
* 生成物只进「动作库（L2）」：不写 storage/vmd、不建 VmdAsset。
  前端按 video_id 拉字节入库；只有用户手动存盘才进 L3。
* 转换是重活（动捕 1~3 分钟 + 转换十几秒），走后台线程异步执行，
  接口立即返回 202，前端轮询 `GET /capture/videos` 看 status。
* `/raw` 支持 HTTP Range（206），否则浏览器 `<video>` 无法 seek，
  历史视频会出现长时间黑屏 / 卡顿。

上传用 JSON + base64（沿用项目惯例，本机无 python-multipart）。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import uuid
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal, get_session
from ..models import VideoAsset
from ..schemas import VideoAssetOut, VideoUploadIn
from ..storage import (
    PathEscapeError,
    capture_action_path,
    capture_video_rel_path,
    delete_capture_action,
    delete_capture_video,
    delete_legacy_media_file,
    legacy_action_rel_path,
    legacy_media_action_path,
    legacy_media_video_path,
    resolve_under,
    write_capture_video,
)
from ..media import MediaError
from ..media import pipeline

log = logging.getLogger("editvmd.routers.media")

router = APIRouter(prefix="/api/media", tags=["media"])

# 视频文件是不可变资源（文件名就是 id），可长期缓存；这也能显著减少
# 切换历史视频时的重复下载。
_VIDEO_CACHE_CONTROL = "private, max-age=31536000, immutable"


def _decode_b64(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, "视频不是合法的 base64") from exc


def _out(v: VideoAsset) -> VideoAssetOut:
    return VideoAssetOut.model_validate(v)


def _capture_video_file(asset: VideoAsset) -> Path | None:
    """按 DB 的 rel_path 找视频文件；找不到回退旧目录（迁移未完成时）。"""
    try:
        path = resolve_under(settings.storage_root, asset.rel_path)
        if path.is_file():
            return path
    except PathEscapeError:
        pass
    legacy = legacy_media_video_path(asset.id)
    return legacy if legacy.is_file() else None


def _capture_action_file(video_id: str) -> Path | None:
    """生成动作文件：新目录优先，回退旧 `media/videos/<id>.vmd`。"""
    path = capture_action_path(video_id)
    if path.is_file():
        return path
    legacy = legacy_media_action_path(video_id)
    return legacy if legacy.is_file() else None


def _get_capture_video(session: Session, video_id: str) -> VideoAsset:
    """取一条**视频捕捉**记录；AI 生成的视频一律拒绝。"""
    asset = session.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, "视频不存在")
    if asset.origin != "uploaded" or asset.session_id:
        raise HTTPException(409, "该视频不是参考视频窗口上传的捕捉视频")
    return asset



# ---------------------------------------------------------------- HTTP Range


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    """解析 `Range: bytes=...`；无法解析返回 None，越界返回 (-1, -1)。"""
    raw = header.strip()
    if not raw.lower().startswith("bytes="):
        return None
    spec = raw[6:].split(",", 1)[0].strip()
    if "-" not in spec:
        return None
    start_s, end_s = spec.split("-", 1)
    try:
        if start_s == "":
            # 后缀区间：bytes=-500 → 最后 500 字节
            suffix = int(end_s)
            if suffix <= 0:
                return (-1, -1)
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    if start >= size or start < 0:
        return (-1, -1)
    if end < start:
        return (-1, -1)
    return start, min(end, size - 1)


def _file_chunks(
    path: Path, start: int, length: int, chunk_size: int = 256 * 1024
) -> Iterator[bytes]:
    remaining = length
    with path.open("rb") as fh:
        fh.seek(start)
        while remaining > 0:
            chunk = fh.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def ranged_video_response(path: Path, request: Request) -> Response:
    """带 Range 支持的视频响应。

    ★ 为什么要自己实现：FastAPI 0.109 / Starlette 0.35 的 `FileResponse`
      完全不解析 Range，浏览器每次 seek 都会重新拉整个文件 —— 这正是
      「切换历史视频黑屏很久」的根因。
    """
    size = path.stat().st_size
    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": _VIDEO_CACHE_CONTROL,
        "Content-Type": "video/mp4",
    }

    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type="video/mp4", headers=base_headers)

    parsed = _parse_range(range_header, size)
    if parsed is None:
        # 不认识的 Range：退回完整响应
        return FileResponse(path, media_type="video/mp4", headers=base_headers)
    start, end = parsed
    if start < 0:
        return Response(
            status_code=416,
            headers={**base_headers, "Content-Range": f"bytes */{size}"},
        )

    length = end - start + 1
    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(length),
    }
    return StreamingResponse(
        _file_chunks(path, start, length),
        status_code=206,
        headers=headers,
    )


# ---------------------------------------------------------------- 列表 / 预览


@router.get("/capture/videos", response_model=list[VideoAssetOut])
def list_videos(session: Session = Depends(get_session)) -> list[VideoAssetOut]:
    """只列**参考视频窗口上传**的视频；AI 生成的视频不在此列。"""
    rows = session.scalars(
        select(VideoAsset)
        .where(VideoAsset.session_id.is_(None), VideoAsset.origin == "uploaded")
        .order_by(VideoAsset.created_at.desc())
    ).all()

    # ★ 生成动作文件被外部删掉（例如用户手动清理）时把状态退回 queued，
    #   否则「生成动作」按钮会一直置灰。
    changed = False
    for row in rows:
        if row.status == "ready" and _capture_action_file(row.id) is None:
            row.status = "queued"
            row.frame_count = None
            row.error = None
            changed = True
    if changed:
        session.commit()

    return [_out(r) for r in rows]


@router.get("/pose")
def first_frame_image() -> FileResponse:
    """固定首帧 pose.png（供「文本→动作」展示起始帧）。"""
    path = settings.action_first_frame
    if not path.is_file():
        raise HTTPException(404, "固定首帧 pose.png 不存在")
    return FileResponse(path, media_type="image/png", filename="pose.png")


@router.get("/capture/videos/{video_id}/raw")
def video_raw(
    video_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> Response:
    """视频流（支持 HTTP Range）。"""
    asset = _get_capture_video(session, video_id)
    path = _capture_video_file(asset)
    if path is None:
        raise HTTPException(404, "视频文件已丢失")
    return ranged_video_response(path, request)


@router.get("/capture/videos/{video_id}/vmd")
def video_vmd(video_id: str, session: Session = Depends(get_session)) -> Response:
    """取「视频→动作」生成的 VMD 字节（旁挂 capture/actions/<id>.vmd）。

    ★ 这份 VMD **只属于动作库（L2）**：前端拉走字节后 `parseVmd → 动作库`。
    """
    asset = _get_capture_video(session, video_id)
    if asset.status != "ready":
        raise HTTPException(409, "该视频还没有生成动作")
    path = _capture_action_file(video_id)
    if path is None:
        raise HTTPException(404, "动作文件已丢失")
    return Response(content=path.read_bytes(), media_type="application/octet-stream")


# ---------------------------------------------------------------- 上传


@router.post("/capture/videos/upload", response_model=VideoAssetOut)
def upload_video(payload: VideoUploadIn, session: Session = Depends(get_session)) -> VideoAssetOut:
    data = _decode_b64(payload.data_base64)
    if not data:
        raise HTTPException(400, "空视频")

    size_mb = len(data) / (1024 * 1024)
    if size_mb > settings.video_max_mb:
        raise HTTPException(400, f"视频过大（{size_mb:.0f}MB > {settings.video_max_mb}MB）")
    if payload.duration_ms and payload.duration_ms > settings.video_max_seconds * 1000:
        raise HTTPException(400, f"视频过长（超过 {settings.video_max_seconds}s）")

    asset_id = uuid.uuid4().hex
    write_capture_video(asset_id, data)
    digest = hashlib.sha256(data).hexdigest()
    name = (payload.name or "").strip() or f"参考视频 {asset_id[:6]}"

    asset = VideoAsset(
        id=asset_id,
        name=name,
        origin="uploaded",
        rel_path=capture_video_rel_path(asset_id),
        size_bytes=len(data),
        duration_ms=payload.duration_ms,
        status="queued",
        sha256=digest,
    )
    session.add(asset)
    session.commit()
    log.info("[media] 上传参考视频 %s (%d KB)", asset_id, len(data) // 1024)
    return _out(asset)


# ---------------------------------------------------------------- 生成动作（后台）


def _run_convert(video_id: str) -> None:
    """后台任务：动捕 + glb2vmd → 落 capture/actions → 回填 video_assets。"""
    session = SessionLocal()
    try:
        asset = session.get(VideoAsset, video_id)
        if asset is None:
            return
        path = _capture_video_file(asset)
        if path is None:
            asset.status = "failed"
            asset.error = "视频文件已丢失"
            session.commit()
            return
        try:
            # ★ 只产出字节并旁挂 capture/actions/<id>.vmd，不建 VmdAsset、不写 storage/vmd
            result = pipeline.video_file_to_vmd(session, path, video_id, asset.name)
        except MediaError as exc:
            asset.status = "failed"
            asset.error = str(exc)
            session.commit()
            log.warning("[media] 转换失败 %s: %s", video_id, exc)
            return
        except Exception as exc:  # noqa: BLE001
            asset.status = "failed"
            asset.error = f"转换异常：{exc}"
            session.commit()
            log.exception("[media] 转换异常 %s", video_id)
            return

        # 新产物已写入 capture/actions；旧目录的残留一并清掉
        delete_legacy_media_file(legacy_action_rel_path(video_id))

        asset.status = "ready"
        asset.error = None
        asset.frame_count = result["frame_count"]
        # ★ vmd_asset_id 保持 null（生成物不落 storage/vmd，只旁挂字节）
        session.commit()
        log.info("[media] 转换完成 %s（capture/actions，%s 帧）", video_id, result["frame_count"])
    finally:
        session.close()


@router.post("/capture/videos/{video_id}/convert", status_code=202)
def convert_video(video_id: str, session: Session = Depends(get_session)) -> dict:
    """触发一次「视频 → 动作」。已生成 / 生成中一律 409（一视频一动作）。"""
    asset = _get_capture_video(session, video_id)
    if asset.status == "converting":
        raise HTTPException(409, "该视频正在生成动作，请稍候")
    if asset.status == "ready" and _capture_action_file(video_id) is not None:
        raise HTTPException(409, "该视频已经生成过动作，不能重复生成")

    asset.status = "converting"
    asset.error = None
    session.commit()

    # 后台线程异步跑（动捕 1~3 分钟 + 转换十几秒），接口立即返回。
    # 自建 daemon 线程而非 BackgroundTasks：转换可能跑几分钟，不想与请求
    # 生命周期耦合；_run_convert 内部自建 DB 会话，线程安全。
    import threading

    threading.Thread(
        target=_run_convert, args=(video_id,), daemon=True, name=f"convert-{video_id[:6]}"
    ).start()
    return {"ok": True, "status": "converting", "video_id": video_id}


# ---------------------------------------------------------------- 丢弃生成物


@router.delete("/capture/videos/{video_id}/action")
def discard_generated_action(video_id: str, session: Session = Depends(get_session)) -> dict:
    """丢弃该视频已生成的动作，把它退回「待生成」。

    ★ 前端在用户从动作库删掉这条视频动作时调用 —— 删除即「这份动作没有
      了」，视频要能重新生成。
    """
    asset = _get_capture_video(session, video_id)
    removed = delete_capture_action(video_id)
    legacy = legacy_media_action_path(video_id)
    if legacy.is_file():
        legacy.unlink(missing_ok=True)

    asset.status = "queued"
    asset.error = None
    asset.frame_count = None
    asset.vmd_asset_id = None
    session.commit()
    log.info("[media] 丢弃视频生成动作 %s（removed=%s）", video_id, removed)
    return {"ok": True, "status": "queued", "removed": removed}


# ---------------------------------------------------------------- 删除（连带动作）


@router.delete("/capture/videos/{video_id}")
def delete_video_asset(video_id: str, session: Session = Depends(get_session)) -> dict:
    """删除视频，并**连带删除**它生成的动作文件。"""
    asset = _get_capture_video(session, video_id)

    rel_video = asset.rel_path
    had_action = _capture_action_file(video_id) is not None

    session.delete(asset)
    session.commit()

    delete_capture_video(rel_video)
    delete_capture_action(video_id)
    delete_legacy_media_file(legacy_action_rel_path(video_id))
    legacy_video = legacy_media_video_path(video_id)
    if legacy_video.is_file():
        legacy_video.unlink(missing_ok=True)

    log.info("[media] 删除视频 %s（连带动作=%s）", video_id, had_action)
    return {"ok": True, "removed_vmd": had_action}


__all__ = ["router"]
