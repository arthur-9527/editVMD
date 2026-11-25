"""ai_sessions / ai_messages 的镜像读写。

★ 设计约束：任何一次写库失败都只能记日志，绝不能让对话失败。
  真值在 SDK 的 JSONL 里，这里丢了数据最多是「历史面板少一行」，
  而对话中断是用户直接能感知的事故。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import func, or_, select

from ..db import SessionLocal
from ..models import AiMessage, AiSession

log = logging.getLogger("editvmd.ai.store")

DEFAULT_LIST_LIMIT = 50

# ★ 可观测性：最近一次镜像库异常。
#   写库失败只记日志会让前端表现成「没有历史」而非「坏了」，
#   这里把原因留给人看，由 /api/ai/status 暴露给侧边栏。
last_error: str | None = None


def _remember_error(where: str, exc: BaseException) -> None:
    """记录异常（供 status 展示），同时照常打日志。"""
    global last_error
    last_error = f"{where}: {exc}"
    log.warning("[ai.store] %s 失败: %s", where, exc)


def clear_error() -> None:
    """成功一次就清掉，避免过期的错误一直挂着。"""
    global last_error
    last_error = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- 会话


def upsert_session(
    session_id: str,
    *,
    first_prompt: str | None = None,
    summary: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    title: str | None = None,
    sdk_session_id: str | None = None,
    total_turns: int | None = None,
    total_cost_usd: float | None = None,
) -> None:
    """创建或更新会话元信息（幂等）。"""
    if not session_id:
        return
    try:
        with SessionLocal() as db:
            row = db.get(AiSession, session_id)
            if row is None:
                row = AiSession(
                    session_id=session_id,
                    title=title,
                    summary=summary,
                    first_prompt=first_prompt,
                    cwd=cwd,
                    model=model,
                    sdk_session_id=sdk_session_id,
                    message_count=0,
                    total_turns=total_turns or 0,
                    total_cost_usd=total_cost_usd or 0.0,
                    is_active=True,
                )
                db.add(row)
            else:
                if title is not None:
                    row.title = title
                if summary is not None:
                    row.summary = summary
                # 首条用户消息只写一次（它就是默认标题来源）
                if first_prompt and not row.first_prompt:
                    row.first_prompt = first_prompt
                if cwd:
                    row.cwd = cwd
                if model:
                    row.model = model
                if sdk_session_id:
                    row.sdk_session_id = sdk_session_id
                if total_turns:
                    row.total_turns = total_turns
                if total_cost_usd:
                    row.total_cost_usd = total_cost_usd
                row.is_active = True
                row.updated_at = _now()
            db.commit()
    except Exception as exc:  # noqa: BLE001 - 落库失败不阻断对话
        _remember_error("upsert_session", exc)


def rename_session(session_id: str, title: str) -> bool:
    """改名（只动 title 一列）。"""
    try:
        with SessionLocal() as db:
            row = db.get(AiSession, session_id)
            if row is None:
                return False
            row.title = title.strip()[:255] or None
            row.updated_at = _now()
            db.commit()
            return True
    except Exception as exc:  # noqa: BLE001
        _remember_error("rename_session", exc)
        return False


def deactivate_session(session_id: str) -> bool:
    """软删除会话，并清掉它的镜像消息。"""
    try:
        with SessionLocal() as db:
            row = db.get(AiSession, session_id)
            if row is None:
                return False
            row.is_active = False
            row.updated_at = _now()
            db.query(AiMessage).filter(AiMessage.session_id == session_id).delete(
                synchronize_session=False
            )
            db.commit()
            return True
    except Exception as exc:  # noqa: BLE001
        _remember_error("deactivate_session", exc)
        return False


def get_session(session_id: str) -> dict[str, Any] | None:
    """读取单个会话（用于 resume 时核对 cwd）。"""
    try:
        with SessionLocal() as db:
            row = db.get(AiSession, session_id)
            return _session_to_dict(row) if row else None
    except Exception as exc:  # noqa: BLE001
        _remember_error("get_session", exc)
        return None


def list_sessions(limit: int = DEFAULT_LIST_LIMIT, offset: int = 0) -> list[dict[str, Any]]:
    """按最后更新时间倒序列出活跃会话。"""
    try:
        with SessionLocal() as db:
            # ★ 过滤「空会话」：message_count=0 且没有 first_prompt 的行不展示。
            #   这类行是历史遗留（早期版本一建会话就落库）产生的「(无标题)」，
            #   对用户没有意义；新逻辑已改为惰性落库，不会再产生。
            rows = (
                db.execute(
                    select(AiSession)
                    .where(AiSession.is_active.is_(True))
                    .where(
                        or_(
                            AiSession.message_count > 0,
                            AiSession.first_prompt.isnot(None),
                        )
                    )
                    .order_by(AiSession.updated_at.desc())
                    .limit(limit)
                    .offset(offset)
                )
                .scalars()
                .all()
            )
            clear_error()
            return [_session_to_dict(r) for r in rows]
    except Exception as exc:  # noqa: BLE001
        _remember_error("list_sessions", exc)
        return []


def _session_to_dict(row: AiSession) -> dict[str, Any]:
    first = (row.first_prompt or "").strip()
    return {
        "session_id": row.session_id,
        "title": row.title or (first[:30] if first else ""),
        "sdk_session_id": row.sdk_session_id or "",
        "summary": row.summary or "",
        "first_prompt": row.first_prompt or "",
        "cwd": row.cwd or "",
        "model": row.model or "",
        "message_count": row.message_count or 0,
        "total_turns": row.total_turns or 0,
        "total_cost_usd": row.total_cost_usd or 0.0,
        "updated_at": row.updated_at.timestamp() if row.updated_at else 0.0,
        "created_at": row.created_at.timestamp() if row.created_at else 0.0,
    }


# ---------------------------------------------------------------- 消息


def append_message(
    session_id: str,
    msg_type: str,
    role: str,
    content: str = "",
    *,
    uuid: str | None = None,
    raw: dict[str, Any] | None = None,
    turn_index: int = 0,
) -> None:
    """追加一条消息，并同步 message_count / updated_at。"""
    if not session_id:
        return
    try:
        with SessionLocal() as db:
            sess = db.get(AiSession, session_id)
            if sess is None:
                sess = AiSession(
                    session_id=session_id,
                    is_active=True,
                    message_count=0,
                    total_turns=0,
                    total_cost_usd=0.0,
                )
                db.add(sess)
                db.flush()

            db.add(
                AiMessage(
                    session_id=session_id,
                    uuid=uuid,
                    type=msg_type,
                    role=role,
                    content=content or "",
                    raw=raw,
                    turn_index=turn_index,
                )
            )
            sess.message_count = (sess.message_count or 0) + 1
            sess.updated_at = _now()
            db.commit()
    except Exception as exc:  # noqa: BLE001
        _remember_error("append_message", exc)


def set_summary_and_stats(
    session_id: str,
    *,
    summary: str | None = None,
    total_turns: int | None = None,
    total_cost_usd: float | None = None,
) -> None:
    """一轮结束后更新摘要与统计。"""
    try:
        with SessionLocal() as db:
            row = db.get(AiSession, session_id)
            if row is None:
                return
            if summary is not None:
                row.summary = summary[:1000]
            if total_turns:
                row.total_turns = total_turns
            if total_cost_usd:
                row.total_cost_usd = total_cost_usd
            row.updated_at = _now()
            db.commit()
    except Exception as exc:  # noqa: BLE001
        _remember_error("set_summary_and_stats", exc)


def list_messages(
    session_id: str,
    limit: int = 200,
    offset: int = 0,
    types: Iterable[str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """分页读消息（DESC，最新在前；前端再 reverse）。

    Returns:
        (messages, total_count)
    """
    try:
        with SessionLocal() as db:
            base = select(AiMessage).where(AiMessage.session_id == session_id)
            count_q = select(func.count(AiMessage.id)).where(AiMessage.session_id == session_id)
            if types:
                wanted = list(types)
                base = base.where(AiMessage.type.in_(wanted))
                count_q = count_q.where(AiMessage.type.in_(wanted))

            rows = (
                db.execute(
                    base.order_by(AiMessage.created_at.desc(), AiMessage.id.desc())
                    .limit(limit)
                    .offset(offset)
                )
                .scalars()
                .all()
            )
            total = db.execute(count_q).scalar_one()
            out = [
                {
                    "id": r.id,
                    "uuid": r.uuid or "",
                    "type": r.type,
                    "role": r.role,
                    "content": r.content or "",
                    "raw": r.raw or None,
                    "turn_index": r.turn_index,
                    "created_at": r.created_at.timestamp() if r.created_at else 0.0,
                }
                for r in rows
            ]
            clear_error()
            return out, int(total)
    except Exception as exc:  # noqa: BLE001
        _remember_error("list_messages", exc)
        return [], 0


def migrate_session_id(old_id: str, new_id: str) -> str:
    """SDK 在首轮结束后回传真实 UUID，把临时会话行迁到真实 id 下。

    迁移要同时改 ai_sessions 主键与 ai_messages 外键，
    所以是「新建行 + 搬消息 + 删旧行」，放在同一事务里。
    """
    if not old_id or not new_id or old_id == new_id:
        return new_id
    try:
        with SessionLocal() as db:
            old = db.get(AiSession, old_id)
            if old is None:
                return new_id
            existing = db.get(AiSession, new_id)
            if existing is None:
                existing = AiSession(
                    session_id=new_id,
                    sdk_session_id=new_id,
                    title=old.title,
                    summary=old.summary,
                    first_prompt=old.first_prompt,
                    cwd=old.cwd,
                    model=old.model,
                    message_count=old.message_count,
                    total_turns=old.total_turns,
                    total_cost_usd=old.total_cost_usd,
                    is_active=True,
                )
                db.add(existing)
            db.flush()
            # 搬消息（外键必须先有会话行：上一步 flush 已插入）
            db.query(AiMessage).filter(AiMessage.session_id == old_id).update(
                {AiMessage.session_id: new_id}, synchronize_session=False
            )
            db.delete(old)
            db.commit()
            log.info("[ai.store] 会话 id 迁移: %s -> %s", old_id, new_id)
            return new_id
    except Exception as exc:  # noqa: BLE001
        _remember_error("migrate_session_id", exc)
        return old_id
