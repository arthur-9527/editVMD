"""工作区接口：单份工程的断点继续（含撤销 / 重做快照）。

设计
----
* 工作区只有一行（id='current'）。
* `PUT` 覆盖式保存：前端带上完整的 past/future 快照与
  客户端单调递增的 `revision`；服务端若发现库里的 revision 更大，
  说明是**乱序到达的旧请求**，直接丢弃，避免把新状态盖回旧状态。
* 历史步数按 `settings.history_limit`（默认 30）裁剪 —— 导入 PMX /
  导入 VMD 也入栈，所以裁剪发生在服务端，前端不需要自己算。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_session
from ..models import HistoryStep, Workspace
from ..schemas import HistoryStepOut, WorkspaceIn, WorkspaceOut

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

_WORKSPACE_ID = "current"


def _load_history(session: Session) -> list[HistoryStep]:
    return list(
        session.scalars(
            select(HistoryStep).order_by(HistoryStep.kind, HistoryStep.seq)
        ).all()
    )


def _to_out(workspace: Workspace, history: list[HistoryStep]) -> WorkspaceOut:
    return WorkspaceOut(
        data=workspace.data,
        active_clip_id=workspace.active_clip_id,
        current_frame=workspace.current_frame,
        selection=workspace.selection or {},
        camera_selected=workspace.camera_selected,
        timeline_mode=workspace.timeline_mode,
        revision=workspace.revision,
        updated_at=workspace.updated_at,
        history=[
            HistoryStepOut(kind=h.kind, seq=h.seq, label=h.label, snapshot=h.snapshot)
            for h in history
        ],
    )


@router.get("", response_model=WorkspaceOut | None)
def get_workspace(session: Session = Depends(get_session)) -> WorkspaceOut | None:
    workspace = session.get(Workspace, _WORKSPACE_ID)
    if workspace is None:
        return None
    return _to_out(workspace, _load_history(session))


@router.put("", response_model=WorkspaceOut)
def put_workspace(payload: WorkspaceIn, session: Session = Depends(get_session)) -> WorkspaceOut:
    workspace = session.get(Workspace, _WORKSPACE_ID)

    # 乱序请求保护：客户端 revision 必须不小于库里的
    if workspace is not None and payload.revision < workspace.revision:
        return _to_out(workspace, _load_history(session))

    if workspace is None:
        workspace = Workspace(id=_WORKSPACE_ID)
        session.add(workspace)

    workspace.data = payload.data
    workspace.active_clip_id = payload.active_clip_id
    workspace.current_frame = payload.current_frame
    workspace.selection = payload.selection
    workspace.camera_selected = payload.camera_selected
    workspace.timeline_mode = payload.timeline_mode
    workspace.revision = payload.revision
    workspace.updated_at = datetime.now(timezone.utc)

    # 覆盖式重写历史：先清空，再写裁剪后的快照
    session.execute(delete(HistoryStep))
    trimmed = _trim_history(payload.history)
    for step in trimmed:
        session.add(
            HistoryStep(
                kind=step.kind,
                seq=step.seq,
                label=step.label,
                snapshot=step.snapshot,
            )
        )

    session.commit()
    return _to_out(workspace, _load_history(session))


@router.delete("")
def clear_workspace(session: Session = Depends(get_session)) -> dict:
    workspace = session.get(Workspace, _WORKSPACE_ID)
    if workspace is not None:
        session.delete(workspace)
    session.execute(delete(HistoryStep))
    session.commit()
    return {"ok": True}


def _trim_history(steps):
    """限制每一步 kind 最多保留 history_limit 条（保留**最新**的）。"""
    limit = max(1, settings.history_limit)
    by_kind: dict[str, list] = {"past": [], "future": []}
    for step in steps:
        by_kind.setdefault(step.kind, []).append(step)
    kept = []
    for kind, rows in by_kind.items():
        rows = sorted(rows, key=lambda s: s.seq)
        kept.extend(rows[-limit:])
    return kept
