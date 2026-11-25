"""资源接口：模型上传 / 列表 / 文件清单 / 单文件读取；VMD 上传 / 保存 / 列表 / 读取。

上传 vs 保存
-----------
* `POST /api/models/upload` —— 外来 PMX 文件夹（JSON：文件清单 + base64）→ 模型资源
* `POST /api/vmd/upload`     —— 外来 VMD（JSON base64）→ origin=uploaded
* `POST /api/vmd/save`       —— 系统生成 VMD（JSON base64）→ origin=generated

「导入」不在后端做：前端拿到文件清单 / 字节后自己重建 File 交给引擎，
所以这里只负责「读」。

★ 不用 multipart（本机缺 python-multipart）：统一 JSON + base64。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_session
from ..models import ModelAsset, VmdAsset
from ..schemas import (
    ModelAssetOut,
    ModelFilesOut,
    ModelUploadIn,
    Origin,
    StorageInfo,
    VmdAssetOut,
    VmdOverwriteIn,
    VmdRenameIn,
    VmdSaveIn,
    VmdUploadIn,
)
from ..storage import (
    PathEscapeError,
    delete_model_dir,
    delete_vmd,
    disk_usage,
    model_dir,
    read_vmd,
    resolve_under,
    save_model_files,
    sha256_of,
    vmd_rel_path,
    write_vmd,
)
from ..vmd_meta import parse_vmd_meta

router = APIRouter(prefix="/api", tags=["assets"])


def _decode_b64(value: str, what: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, f"{what} 不是合法的 base64") from exc


def _model_out(asset: ModelAsset, reused: bool = False) -> ModelAssetOut:
    return ModelAssetOut(
        id=asset.id,
        name=asset.name,
        pmx_file=asset.pmx_file,
        bone_count=asset.bone_count,
        morph_count=asset.morph_count,
        size_bytes=asset.size_bytes,
        file_count=len(asset.manifest or []),
        created_at=asset.created_at,
        reused=reused,
    )


# ---------------------------------------------------------------- 存储信息


@router.get("/storage/info", response_model=StorageInfo)
def storage_info() -> StorageInfo:
    usage = disk_usage()
    return StorageInfo(
        root=usage["root"],
        file_count=usage["file_count"],
        total_bytes=usage["total_bytes"],
        history_limit=settings.history_limit,
    )


# ---------------------------------------------------------------- 模型


@router.post("/models/upload", response_model=ModelAssetOut)
def upload_model(payload: ModelUploadIn, session: Session = Depends(get_session)) -> ModelAssetOut:
    """上传 PMX 文件夹（保留相对目录结构）。"""
    if not payload.files:
        raise HTTPException(400, "没有文件")

    # 找主 PMX：显式指定优先，否则取第一个 .pmx
    pmx_rel = payload.pmx_file
    if not pmx_rel:
        pmx_rel = next(
            (f.rel_path for f in payload.files if f.rel_path.lower().endswith(".pmx")),
            None,
        )
    if not pmx_rel:
        raise HTTPException(400, "所选文件夹里没有 .pmx 文件")

    # ---------------------------------------------------------------- 查重
    # 前端在发送前算好主 PMX 的 SHA-256，并带上总体积与文件数。
    # 三者全部相同才认定为同一份模型 —— 只比 sha256 会误伤「同 PMX 换了贴图」
    # 的情况，只比体积又太容易撞车。
    # 命中则直接复用已有记录：不写盘、不插新行，省掉几十 MB 的传输。
    if payload.pmx_sha256:
        candidates = session.scalars(
            select(ModelAsset).where(ModelAsset.sha256 == payload.pmx_sha256)
        ).all()
        for candidate in candidates:
            if (
                payload.size_bytes is not None
                and candidate.size_bytes == payload.size_bytes
                and payload.file_count is not None
                and len(candidate.manifest or []) == payload.file_count
            ):
                # 校验磁盘还在（用户可能手工删过 storage 目录）
                if model_dir(candidate.id).is_dir():
                    return _model_out(candidate, reused=True)

    model_id = uuid.uuid4().hex
    files: list[tuple[str, bytes]] = [
        (f.rel_path, _decode_b64(f.data_base64, f.rel_path)) for f in payload.files
    ]

    target, manifest, total = save_model_files(model_id, files)
    try:
        pmx_abs = resolve_under(target, pmx_rel)
    except PathEscapeError as exc:
        delete_model_dir(model_id)
        raise HTTPException(400, str(exc)) from exc
    if not pmx_abs.is_file():
        delete_model_dir(model_id)
        raise HTTPException(400, f"主 PMX 不在上传文件中：{pmx_rel}")

    asset = ModelAsset(
        id=model_id,
        name=payload.name or pmx_abs.stem,
        dir=str(target),
        pmx_file=pmx_rel.replace("\\", "/"),
        manifest=manifest,
        bone_count=payload.bone_count,
        morph_count=payload.morph_count,
        size_bytes=total,
        sha256=sha256_of(pmx_abs),
    )
    session.add(asset)
    session.commit()
    return _model_out(asset)


@router.get("/models", response_model=list[ModelAssetOut])
def list_models(session: Session = Depends(get_session)) -> list[ModelAssetOut]:
    rows = session.scalars(select(ModelAsset).order_by(ModelAsset.created_at.desc())).all()
    return [_model_out(r) for r in rows]


@router.get("/models/{model_id}/files", response_model=ModelFilesOut)
def model_files(model_id: str, session: Session = Depends(get_session)) -> ModelFilesOut:
    asset = session.get(ModelAsset, model_id)
    if asset is None:
        raise HTTPException(404, "模型不存在")
    return ModelFilesOut(
        id=asset.id,
        name=asset.name,
        pmx_file=asset.pmx_file,
        files=[{"rel_path": m["rel_path"], "size": m["size"]} for m in (asset.manifest or [])],
    )


@router.get("/models/{model_id}/raw")
def model_raw(
    model_id: str,
    path: str = Query(..., description="相对模型目录的文件路径"),
    session: Session = Depends(get_session),
) -> Response:
    asset = session.get(ModelAsset, model_id)
    if asset is None:
        raise HTTPException(404, "模型不存在")
    try:
        abs_path = resolve_under(model_dir(model_id), path)
    except PathEscapeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not abs_path.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(abs_path, filename=abs_path.name)


@router.delete("/models/{model_id}")
def remove_model(model_id: str, session: Session = Depends(get_session)) -> dict:
    asset = session.get(ModelAsset, model_id)
    if asset is None:
        raise HTTPException(404, "模型不存在")
    session.delete(asset)
    session.commit()
    delete_model_dir(model_id)
    return {"ok": True}


# ---------------------------------------------------------------- VMD


def _vmd_out(asset: VmdAsset) -> VmdAssetOut:
    return VmdAssetOut.model_validate(asset)


@router.post("/vmd/upload", response_model=VmdAssetOut)
def upload_vmd(payload: VmdUploadIn, session: Session = Depends(get_session)) -> VmdAssetOut:
    data = _decode_b64(payload.data_base64, "VMD")
    if not data:
        raise HTTPException(400, "空文件")

    # ---------------------------------------------------------------- 查重
    # VMD 是单文件，直接用内容 SHA-256 判定即可（客户端可预先算好传来，
    # 省掉一次落盘后再读一遍）。命中则复用已有记录、不写盘。
    digest = payload.sha256 or hashlib.sha256(data).hexdigest()
    existing = session.scalars(
        select(VmdAsset).where(VmdAsset.sha256 == digest)
    ).first()
    if existing is not None and resolve_under(settings.storage_root, existing.rel_path).is_file():
        return VmdAssetOut.model_validate(existing).model_copy(update={"reused": True})

    asset_id = uuid.uuid4().hex
    path = write_vmd(asset_id, data)
    meta = parse_vmd_meta(data)
    asset = VmdAsset(
        id=asset_id,
        name=payload.name or meta.get("model_name") or "motion",
        origin="uploaded",
        rel_path=vmd_rel_path(asset_id),
        size_bytes=len(data),
        frame_count=meta["frame_count"],
        bone_count=meta["bone_count"],
        morph_count=meta["morph_count"],
        model_id=payload.model_id,
        sha256=digest,
    )
    session.add(asset)
    session.commit()
    return _vmd_out(asset)


@router.post("/vmd/save", response_model=VmdAssetOut)
def save_vmd(payload: VmdSaveIn, session: Session = Depends(get_session)) -> VmdAssetOut:
    """系统生成 VMD：base64 → storage/vmd/<id>.vmd → origin=generated。"""
    data = _decode_b64(payload.data_base64, "data_base64")
    if not data:
        raise HTTPException(400, "空数据")

    # ---------------------------------------------------------------- 查重
    # 「保存到系统」也可能反复保存同一份未改动的动作 —— 内容相同就不必再存一份。
    # ★ 但「改名另存」必须真的产生新文件（force_new）：内容可能没变，
    #   若复用旧记录，用户起的新名字会被静默丢掉。
    digest = payload.sha256 or hashlib.sha256(data).hexdigest()
    if not payload.force_new:
        existing = session.scalars(
            select(VmdAsset).where(VmdAsset.sha256 == digest)
        ).first()
        if existing is not None and resolve_under(settings.storage_root, existing.rel_path).is_file():
            return VmdAssetOut.model_validate(existing).model_copy(update={"reused": True})

    asset_id = uuid.uuid4().hex
    path = write_vmd(asset_id, data)
    meta = parse_vmd_meta(data)
    asset = VmdAsset(
        id=asset_id,
        name=payload.name,
        origin="generated",
        rel_path=vmd_rel_path(asset_id),
        size_bytes=len(data),
        frame_count=payload.frame_count if payload.frame_count is not None else meta["frame_count"],
        bone_count=payload.bone_count if payload.bone_count is not None else meta["bone_count"],
        morph_count=payload.morph_count if payload.morph_count is not None else meta["morph_count"],
        model_id=payload.model_id,
        source_asset_id=payload.source_asset_id,
        sha256=digest,
    )
    session.add(asset)
    session.commit()
    return _vmd_out(asset)


@router.put("/vmd/{asset_id}", response_model=VmdAssetOut)
def overwrite_vmd(
    asset_id: str,
    payload: VmdOverwriteIn,
    session: Session = Depends(get_session),
) -> VmdAssetOut:
    """**原地覆盖**已有 VMD：文件身份（id / rel_path）不变，只更新内容。

    ★ 与 `POST /vmd/save` 的区别
      save 是「新建一份」，按内容 sha256 去重（内容相同就复用别的记录）。
      overwrite 是「这一份被更新了」——内容必然会变，若也去重，就会换一个 id，
      调用方手里的引用立刻失效、旧记录变孤儿。
      所以这里按 asset_id 定位，绝不换 id。
    """
    asset = session.get(VmdAsset, asset_id)
    if asset is None:
        raise HTTPException(404, "VMD 不存在")

    data = _decode_b64(payload.data_base64, "data_base64")
    if not data:
        raise HTTPException(400, "空数据")

    # 覆盖同一个路径：写盘而不是新建文件
    path = resolve_under(settings.storage_root, asset.rel_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

    meta = parse_vmd_meta(data)
    if payload.name:
        asset.name = payload.name
    asset.size_bytes = len(data)
    asset.frame_count = payload.frame_count if payload.frame_count is not None else meta["frame_count"]
    asset.bone_count = payload.bone_count if payload.bone_count is not None else meta["bone_count"]
    asset.morph_count = payload.morph_count if payload.morph_count is not None else meta["morph_count"]
    asset.sha256 = payload.sha256 or hashlib.sha256(data).hexdigest()
    # 用户编辑后保存的产物一律算「系统生成」
    asset.origin = "generated"

    session.commit()
    return _vmd_out(asset)


@router.patch("/vmd/{asset_id}", response_model=VmdAssetOut)
def rename_vmd(
    asset_id: str,
    payload: VmdRenameIn,
    session: Session = Depends(get_session),
) -> VmdAssetOut:
    """**只改名字**，不读写文件。

    ★ 与 `PUT /vmd/{asset_id}`（overwrite）的区别
      overwrite 会用请求体里的字节重写 `rel_path` —— 那是「内容更新」。
      改名只是元数据变化：文件身份（id / rel_path）、内容、哈希都不该动。
      所以这里单独一条 PATCH，只更新 `name` 列。
    """
    asset = session.get(VmdAsset, asset_id)
    if asset is None:
        raise HTTPException(404, "VMD 不存在")
    asset.name = payload.name
    session.commit()
    return _vmd_out(asset)


@router.get("/vmd", response_model=list[VmdAssetOut])
def list_vmd(
    origin: Origin | None = Query(default=None),
    session: Session = Depends(get_session),
) -> list[VmdAssetOut]:
    stmt = select(VmdAsset).order_by(VmdAsset.created_at.desc())
    if origin is not None:
        stmt = stmt.where(VmdAsset.origin == origin)
    rows = session.scalars(stmt).all()
    return [_vmd_out(r) for r in rows]


@router.get("/vmd/{asset_id}/raw")
def vmd_raw(asset_id: str, session: Session = Depends(get_session)) -> Response:
    asset = session.get(VmdAsset, asset_id)
    if asset is None:
        raise HTTPException(404, "VMD 不存在")
    try:
        data = read_vmd(asset.rel_path)
    except (FileNotFoundError, PathEscapeError) as exc:
        raise HTTPException(404, "文件已丢失") from exc
    return Response(content=data, media_type="application/octet-stream")


@router.delete("/vmd/{asset_id}")
def remove_vmd(asset_id: str, session: Session = Depends(get_session)) -> dict:
    asset = session.get(VmdAsset, asset_id)
    if asset is None:
        raise HTTPException(404, "VMD 不存在")
    rel = asset.rel_path
    session.delete(asset)
    session.commit()
    delete_vmd(rel)
    return {"ok": True}
