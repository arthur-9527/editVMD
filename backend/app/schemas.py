"""Pydantic 请求 / 响应模型。

与 ORM 分离：前端只看到这里定义的形状，改表结构不会直接泄漏到 API。

★ 上传接口全部用「JSON + base64」而不是 multipart —— 本机没有
  python-multipart 且装不上（PEP 668 + 网络受限）。前端把 Blob 读成
  ArrayBuffer 再转 base64 即可，链路反而更简单一致。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Origin = Literal["uploaded", "generated"]


# ---------------------------------------------------------------- 存储


class StorageInfo(BaseModel):
    root: str
    file_count: int
    total_bytes: int
    history_limit: int


# ---------------------------------------------------------------- 模型


class ModelFileEntry(BaseModel):
    rel_path: str
    size: int


class ModelFileIn(BaseModel):
    """上传时单个文件：相对路径 + base64 内容。"""

    rel_path: str
    data_base64: str


class ModelUploadIn(BaseModel):
    """上传 PMX 文件夹：一次性把目录里所有文件传上来（保留相对结构）。

    查重指纹（三者全等才认定为同一模型，命中则复用已有记录、不写盘）：
        pmx_sha256  前端对主 PMX 算的 SHA-256；crypto.subtle 不可用时为空
        size_bytes  全部文件体积之和
        file_count  文件数量
    """

    name: str | None = None
    pmx_file: str | None = Field(default=None, description="主 PMX 的相对路径；缺省取第一个 .pmx")
    files: list[ModelFileIn]
    bone_count: int | None = None
    morph_count: int | None = None
    pmx_sha256: str | None = Field(default=None, description="主 PMX 指纹，用于查重")
    size_bytes: int | None = Field(default=None, description="全部文件体积之和，用于查重")
    file_count: int | None = Field(default=None, description="文件数量，用于查重")


class ModelAssetOut(BaseModel):
    id: str
    name: str
    pmx_file: str
    bone_count: int | None = None
    morph_count: int | None = None
    size_bytes: int
    file_count: int = 0
    created_at: datetime
    # ★ True 表示命中了已有的同指纹记录，服务端没有重复写盘
    reused: bool = False

    model_config = {"from_attributes": True}


class ModelFilesOut(BaseModel):
    id: str
    name: str
    pmx_file: str
    files: list[ModelFileEntry]


# ---------------------------------------------------------------- VMD


class VmdAssetOut(BaseModel):
    id: str
    name: str
    origin: Origin
    size_bytes: int
    frame_count: int | None = None
    bone_count: int | None = None
    morph_count: int | None = None
    model_id: str | None = None
    source_asset_id: str | None = None
    created_at: datetime
    # ★ 内容指纹（SHA-256 十六进制）。
    #   前端拿它和「动作库条目上次同步时记下的 savedHash」比对，判断
    #   「L2 动作库 ↔ L3 存盘」是否一致 —— 不一致 / L3 无此文件 → 显示「未存盘」。
    sha256: str | None = None
    # ★ True 表示命中了已有的同 sha256 记录，服务端没有重复写盘
    reused: bool = False

    model_config = {"from_attributes": True}


class VmdUploadIn(BaseModel):
    """上传外来 VMD（origin=uploaded）。"""

    name: str | None = None
    data_base64: str
    model_id: str | None = None
    # 客户端可预先算好的 SHA-256（十六进制）；不传则服务端落盘后自行计算
    sha256: str | None = None


class VmdRenameIn(BaseModel):
    """只改名字，**不碰文件内容**。

    ★ 为什么必须单独开一个接口
      `PUT /vmd/{asset_id}` 会重写文件字节；用它做改名等于用「读出来的内容」
      覆盖原文件，一旦前端手里的内容与磁盘上的不一致（例如只加载了可见区间、
      或解析时丢了尾部空段落），改名就会静默截断用户的文件。
      改名只应该动数据库里的 `name` 一列。
    """

    name: str = Field(min_length=1, max_length=255)


class VmdOverwriteIn(BaseModel):
    """原地覆盖系统里已有的 VMD（保持文件身份不变）。

    ★ 为什么不能复用 `VmdSaveIn`
      `save` 按内容 sha256 去重：内容一变就当成新文件、换一个 id，
      原来那条就成了孤儿。而「覆盖」的语义恰恰是「同一个文件被更新」，
      所以这里必须按 asset_id 定位，不走查重。
    """

    data_base64: str
    name: str | None = Field(default=None, max_length=255)
    frame_count: int | None = None
    bone_count: int | None = None
    morph_count: int | None = None
    sha256: str | None = None


class VmdSaveIn(BaseModel):
    """系统生成 VMD（origin=generated）。"""

    name: str = Field(min_length=1, max_length=255)
    data_base64: str
    frame_count: int | None = None
    bone_count: int | None = None
    morph_count: int | None = None
    model_id: str | None = None
    source_asset_id: str | None = None
    # 客户端可预先算好的 SHA-256（十六进制）；不传则服务端落盘后自行计算
    sha256: str | None = None
    # ★ 强制新建：跳过「内容相同就复用已有记录」的查重。
    #   「改名 -> 存盘 = 另存为新文件」时内容可能一字未改，若仍走查重，
    #   服务端会复用旧记录（连名字都是旧的），用户起的新名字就丢了。
    force_new: bool = False


# ---------------------------------------------------------------- 参考视频（视频 → 动作）

VideoStatus = Literal["queued", "converting", "ready", "failed"]


class VideoUploadIn(BaseModel):
    """上传参考视频（JSON + base64，沿用项目惯例，不依赖 multipart）。"""

    name: str | None = None
    data_base64: str
    # 客户端可选的时长（毫秒），服务端无 ffprobe 时用于展示 / 校验
    duration_ms: int | None = None


class VideoAssetOut(BaseModel):
    id: str
    name: str
    origin: Literal["uploaded", "generated"]
    size_bytes: int
    duration_ms: int | None = None
    frame_count: int | None = None
    status: VideoStatus
    error: str | None = None
    source_text: str | None = None
    # ★ AI 会话归属：AI 生成的视频记它；参考视频窗口上传的为空。
    session_id: str | None = None
    # ★ 由哪段视频再生成而来（首次生成为空）
    parent_video_id: str | None = None
    vmd_asset_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- 工作区


class HistoryStepIn(BaseModel):
    kind: Literal["past", "future"]
    seq: int
    label: str = ""
    snapshot: dict[str, Any]


class HistoryStepOut(HistoryStepIn):
    model_config = {"from_attributes": True}


class WorkspaceIn(BaseModel):
    data: dict[str, Any]
    active_clip_id: str | None = None
    current_frame: int = 0
    selection: dict[str, Any] = Field(default_factory=dict)
    camera_selected: bool = False
    timeline_mode: Literal["keys", "arrange"] = "keys"
    revision: int = 0
    history: list[HistoryStepIn] = Field(default_factory=list)


class WorkspaceOut(BaseModel):
    data: dict[str, Any]
    active_clip_id: str | None = None
    current_frame: int
    selection: dict[str, Any]
    camera_selected: bool
    timeline_mode: str
    revision: int
    updated_at: datetime
    history: list[HistoryStepOut] = Field(default_factory=list)
