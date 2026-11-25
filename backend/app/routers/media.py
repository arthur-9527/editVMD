"""参考视频接口：上传 / 列表 / 预览 / 生成动作 / 删除。

语义（务必保持）
----------------
* 「参考视频 → 动作」是**用户显式操作**（UI 悬浮窗三个按钮），不对外暴露成 AI 工具。
* **一视频一动作**：每个视频只生成一次。转换成功即把 status 置 ready；
  之后再来转换会被 409 拒绝；删除视频会**连带删除**它生成的旁挂动作文件。
* ★ 生成物只进「动作库（L2）」：转换产物**旁挂**在 media/videos/<id>.vmd，
  不写 storage/vmd、不建 VmdAsset（三级缓存语义）。前端按 video_id 拉字节入库。
* 转换是重活（动捕 1~3 分钟 + 转换十几秒），走后台线程异步执行，
  接口立即返回 202，前端轮询 `GET /videos` 看 status。

上传用 JSON + base64（沿用项目惯例，本机无 python-multipart）。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal, get_session
from ..models import VideoAsset
from ..schemas import VideoAssetOut, VideoUploadIn
from ..storage import (
    PathEscapeError,
    delete_video,
    delete_video_vmd,
    resolve_under,
    video_rel_path,
    video_vmd_path,
    write_video,
)
from ..media import MediaError
from ..media import pipeline

log = logging.getLogger("editvmd.routers.media")

router = APIRouter(prefix="/api/media", tags=["media"])


def _decode_b64(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, "视频不是合法的 base64") from exc


def _out(v: VideoAsset) -> VideoAssetOut:
    return VideoAssetOut.model_validate(v)


# ---------------------------------------------------------------- 列表 / 预览


@router.get("/videos", response_model=list[VideoAssetOut])
def list_videos(session: Session = Depends(get_session)) -> list[VideoAssetOut]:
    rows = session.scalars(select(VideoAsset).order_by(VideoAsset.created_at.desc())).all()
    return [_out(r) for r in rows]


@router.get("/videos/pose")
def first_frame_image() -> FileResponse:
    """固定首帧 pose.png（供参考视频窗口展示「文本→动作」用的起始帧）。"""
    path = settings.action_first_frame
    if not path.is_file():
        raise HTTPException(404, "固定首帧 pose.png 不存在")
    return FileResponse(path, media_type="image/png", filename="pose.png")


@router.get("/videos/{video_id}/raw")
def video_raw(video_id: str, session: Session = Depends(get_session)) -> FileResponse:
    asset = session.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, "视频不存在")
    try:
        path = resolve_under(settings.storage_root, asset.rel_path)
    except PathEscapeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not path.is_file():
        raise HTTPException(404, "视频文件已丢失")
    return FileResponse(path, media_type="video/mp4")


@router.get("/videos/{video_id}/vmd")
def video_vmd(video_id: str, session: Session = Depends(get_session)) -> Response:
    """取「视频→动作」生成的 VMD 字节（旁挂在 media/videos/<id>.vmd）。

    ★ 这份 VMD **只属于动作库（L2）**，不是 storage/vmd 里的存盘文件 ——
      前端拉走字节后 `parseVmd → 动作库`（显示「未存盘」）。
      这里以 application/octet-stream 返回原始字节。
    """
    asset = session.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, "视频不存在")
    if asset.status != "ready":
        raise HTTPException(409, "该视频还没有生成动作")
    path = video_vmd_path(video_id)
    if not path.is_file():
        raise HTTPException(404, "动作文件已丢失")
    return Response(content=path.read_bytes(), media_type="application/octet-stream")


# ---------------------------------------------------------------- 上传


@router.post("/videos/upload", response_model=VideoAssetOut)
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
    path = write_video(asset_id, data)
    digest = hashlib.sha256(data).hexdigest()
    name = (payload.name or "").strip() or f"参考视频 {asset_id[:6]}"

    asset = VideoAsset(
        id=asset_id,
        name=name,
        origin="uploaded",
        rel_path=video_rel_path(asset_id),
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
    """后台任务：动捕 + glb2vmd → 落 VMD → 回填 video_assets。"""
    session = SessionLocal()
    try:
        asset = session.get(VideoAsset, video_id)
        if asset is None:
            return
        video_path = resolve_under(settings.storage_root, asset.rel_path)
        try:
            # ★ 只产出字节并旁挂 media/videos/<id>.vmd，不建 VmdAsset、不写 storage/vmd
            result = pipeline.video_file_to_vmd(session, video_path, video_id, asset.name)
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

        asset.status = "ready"
        asset.error = None
        asset.frame_count = result["frame_count"]
        # ★ vmd_asset_id 保持 null（生成物不落 storage/vmd，只旁挂字节）
        session.commit()
        log.info("[media] 转换完成 %s（旁挂 vmd，%s 帧）", video_id, result["frame_count"])
    finally:
        session.close()


@router.post("/videos/{video_id}/convert", status_code=202)
def convert_video(
    video_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    """触发一次「视频 → 动作」。已生成 / 生成中一律 409（一视频一 VMD）。"""
    asset = session.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, "视频不存在")
    if asset.status == "ready" or asset.vmd_asset_id:
        raise HTTPException(409, "该视频已经生成过动作，不能重复生成")
    if asset.status == "converting":
        raise HTTPException(409, "该视频正在生成动作，请稍候")

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



# ---------------------------------------------------------------- 删除（连带 VMD）


@router.delete("/videos/{video_id}")
def delete_video_asset(video_id: str, session: Session = Depends(get_session)) -> dict:
    """删除视频，并**连带删除**它生成的 VMD（文件 + DB 行）。"""
    asset = session.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, "视频不存在")

    rel_video = asset.rel_path

    # 旁挂的生成动作（media/videos/<id>.vmd）也一起删掉
    had_vmd = video_vmd_path(video_id).is_file()

    # 删视频记录（生成物不再建 VmdAsset，所以没有额外 DB 行要删）
    session.delete(asset)
    session.commit()

    delete_video(rel_video)
    delete_video_vmd(video_id)

    log.info("[media] 删除视频 %s（连带旁挂 VMD=%s）", video_id, had_vmd)
    return {"ok": True, "removed_vmd": had_vmd}


__all__ = ["router"]
