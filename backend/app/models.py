"""ORM 模型：资源（模型 / VMD）+ 单份工作区 + 撤销栈。

设计要点
--------
* 资源的**文件本体**在 storage/ 下，DB 只存元数据与相对路径；
  `manifest` 记录目录里每个文件的相对路径与大小，供前端「导入」时逐个拉取。
* `origin` 只有两种：`uploaded`（外来的）/ `generated`（系统生成的）。
  「导入」对两者一视同仁 —— 这正是把「上传」与「导入」分开的落点。
* 工作区是**单份**的（id 恒为 'current'），断点继续只围绕它，
  不需要多工程列表。
* 撤销栈以 JSON 快照保存在 `history_steps`，服务端按 history_limit 裁剪。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- 模型资源


class ModelAsset(Base):
    """上传的 PMX 模型（含贴图目录）。"""

    __tablename__ = "models"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # storage/models/<id>
    dir: Mapped[str] = mapped_column(String(512), nullable=False)
    # 主 PMX 的**相对**路径（相对 dir），例如 "初音ミク.pmx"
    pmx_file: Mapped[str] = mapped_column(String(512), nullable=False)
    # [{ "rel_path": "...", "size": 123 }, ...]
    manifest: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    bone_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    morph_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)


# ---------------------------------------------------------------- VMD 资源


class VmdAsset(Base):
    """一份 VMD。

    `origin`:
        uploaded  —— 用户从外部上传
        generated —— 编辑器「保存到系统」生成的
    """

    __tablename__ = "vmd_assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    origin: Mapped[str] = mapped_column(String(16), nullable=False, default="uploaded")
    # storage/vmd/<id>.vmd 的相对路径（相对 storage 根）
    rel_path: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    frame_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bone_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    morph_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 关联模型（可空）：导入模型后可把 VMD 挂到它下面做过滤
    model_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("models.id", ondelete="SET NULL"), nullable=True
    )
    # 生成物的来源（例如从哪个 VMD 派生的）；上传物为空
    source_asset_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (Index("ix_vmd_origin", "origin"),)


# ---------------------------------------------------------------- 视频资源（参考视频 → 动作）


class VideoAsset(Base):
    """一份参考视频（用户上传 或 AI 生成）。

    ★ 与 VMD 的关系在语义上是 **1:1**：一个视频只生成一次动作。
      生成物只进「动作库（L2）」，旁挂在媒体旁边（capture/actions 或会话目录里），
      **不建 VmdAsset**，所以 `vmd_asset_id` 恒为 null（字段保留兼容旧数据）。

    status:
        queued      —— 刚上传 / 用户删掉了动作，等待生成
        converting  —— 正在动捕 + 转换
        ready       —— 已生成动作（旁挂文件存在）
        failed      —— 生成失败（error 记录原因）

    origin:
        uploaded  —— 参考视频窗口上传
        generated —— 能力1（文本→动作）由 MiniMax i2v 生成
    """

    __tablename__ = "video_assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    origin: Mapped[str] = mapped_column(String(16), nullable=False, default="uploaded")
    # storage/media/capture/videos/<id>.mp4 或 ai_workspace/<sid>/ai_videos/<id>.mp4
    # （相对 storage 根）
    rel_path: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    frame_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 能力1 的原始文本（参考视频为空）
    source_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ★ 归属会话：AI 会话生成的视频记它；参考视频窗口上传的为空。
    #   删除会话时按它清理视频（文件在 ai_workspace/<session_id>/ai_videos 下）。
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # ★ 再生成的来源视频：从哪段视频派生而来（首次生成为空）。
    parent_video_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # ★ 一视频一 VMD：生成成功后指向 vmd_assets.id；UNIQUE 防止二次生成
    vmd_asset_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("vmd_assets.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        Index("ix_video_status", "status"),
        Index("ix_video_session", "session_id"),
    )


# ---------------------------------------------------------------- 工作区


class Workspace(Base):
    """单份工作区（断点继续）。

    id 恒为 'current'。`data` 是前端 Project 的 JSON，
    另存若干「视图状态」字段，恢复时可精确定位到上次离开的画面。
    """

    __tablename__ = "workspace"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default="current")
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    active_clip_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    current_frame: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    selection: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    camera_selected: Mapped[bool] = mapped_column(default=False, nullable=False)
    timeline_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="keys")
    # 客户端单调递增的版本号：防乱序覆盖
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class HistoryStep(Base):
    """撤销 / 重做快照。

    kind:
        past   —— 变更前的快照
        future —— 重做栈
    `snapshot` 结构由前端定义：{clip, project, model, label}
    """

    __tablename__ = "history_steps"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False, default="")
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (Index("ix_history_kind_seq", "kind", "seq"),)


# ---------------------------------------------------------------- AI 会话（镜像层）
#
# 真值仍是 SDK 自己写的 JSONL（claude CLI 的 ~/.claude/projects/<cwd>/<id>.jsonl），
# `resume` 读的也是它。下面两张表只是**只读镜像 + 元信息**，用于：
#   * 历史列表 / 分页 / 搜索（JSONL 做不到）
#   * 自定义标题（JSONL 里改不了）
#   * 软删除（可撤销）
# 因此：写入失败绝不阻断对话（store.py 内全部 try/except）。


class AiSession(Base):
    """一个 AI 会话的元信息（session_id 即 SDK 的 UUID）。"""

    __tablename__ = "ai_sessions"

    # 应用层 id（前端看到的 key；resume 必须用 sdk_session_id）
    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # SDK 回传的真实 UUID（JSONL 文件名 / resume 参数）；首轮结束前为空
    sdk_session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 自定义标题；为空时前端回落到 first_prompt
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 末条助手回复的摘要（前端列表副标题用）
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 首条用户消息（默认标题来源：前 30 字）
    first_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 记录 cwd 与 model：resume 时必须对得上
    cwd: Mapped[str | None] = mapped_column(String(512), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_turns: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_cost_usd: Mapped[float] = mapped_column(nullable=False, default=0.0)
    # 软删除：False 表示已删除（可从历史面板彻底清掉）
    is_active: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )

    __table_args__ = (
        Index("ix_ai_sessions_active_updated", "is_active", "updated_at"),
    )


class AiMessage(Base):
    """一条消息 / 内容块（按 type 区分粒度，对齐参考项目）。

    type:
        user         —— 用户原文
        assistant    —— 助手最终文本
        thinking     —— 思考片段（仅并入 raw，前端折叠；默认不单独建行）
        tool_use     —— {tool, input, id}
        tool_result  —— {tool, tool_use_id, result}
    `raw` 存完整结构（用户消息这里放 {user_text, editor_context}）。
    """

    __tablename__ = "ai_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("ai_sessions.session_id", ondelete="CASCADE"), nullable=False
    )
    uuid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    raw: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)

    __table_args__ = (
        Index("ix_ai_messages_session_created", "session_id", "created_at"),
    )
