"""版本化表结构迁移（参考 claude-desktop 的 `backend/database/db.py`）。

为什么不用 Alembic
------------------
* 单机部署，不存在 downgrade 需求；
* 变更形态只有「加表 / 加列 / 加索引」三种，带 `IF NOT EXISTS` 天然幂等；
* 参考项目 6 个版本同样用手写 SQL + 版本号，已过实践验证。

为什么不能只用 `create_all`
---------------------------
`Base.metadata.create_all()` **只建「不存在的表」，永不 ALTER 已有表**。
`ai_sessions` 缺 `sdk_session_id` 导致 `SELECT` 撞 `UndefinedColumn`，
就是这条盲区造成的。所以：

    create_all   负责「新库一次性建齐」（快路径，不用手写 CREATE）
    migrate()    负责「老库补增量变更」（慢路径，幂等）

两者都幂等，任意顺序重跑都安全。

版本语义与 Alembic 的 `alembic_version` 一致，将来要切换可直接对齐版本号。
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from .db import engine

log = logging.getLogger("editvmd.db.migrations")

# 目标版本：改迁移时同步 +1
CURRENT_SCHEMA_VERSION = 3

# (版本号, 说明, SQL 列表)
#   * 同一版本的 SQL 在一个事务里执行，失败整版回滚，不留半成品
#   * 新增迁移时**只追加**，绝不修改已发布的版本
MIGRATIONS: list[tuple[int, str, list[str]]] = [
    (
        1,
        "baseline：既有表由 create_all 建出，这里只做版本打标",
        [],
    ),
    (
        2,
        "ai_sessions 补 SDK 真实会话 id（resume 依赖它）",
        [
            "ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS sdk_session_id VARCHAR(64)",
        ],
    ),
    (
        3,
        "video_assets 补会话归属（AI 视频按会话隔离、删会话连带删视频）",
        [
            "ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS session_id VARCHAR(64)",
            "ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS parent_video_id VARCHAR(32)",
            "CREATE INDEX IF NOT EXISTS ix_video_session ON video_assets (session_id)",
        ],
    ),
]

# Postgres 里「已存在」类错误的 SQLSTATE：
#   42P07 duplicate_table / 42701 duplicate_column / 42P06 duplicate_schema
_DUPLICATE_CODES = {"42P07", "42701", "42P06"}

_VERSION_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  DOUBLE PRECISION NOT NULL,
    description TEXT
)
"""


def _is_duplicate_error(exc: Exception) -> bool:
    """判断是否为「对象已存在」——是则视为成功（幂等）。

    优先看 SQLSTATE（跨 Postgres 版本稳定），
    再回落到 message 里的 'already exists'（兼容旧驱动）。
    """
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "pgcode", None) or getattr(orig, "sqlstate", None)
    if code in _DUPLICATE_CODES:
        return True
    return "already exists" in str(exc).lower()


def _current_version() -> int:
    with engine.connect() as conn:
        row = conn.execute(text("SELECT COALESCE(MAX(version), 0) FROM schema_version")).scalar()
    return int(row or 0)


def _record(version: int, description: str) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO schema_version (version, applied_at, description)
                VALUES (:v, :t, :d)
                ON CONFLICT (version) DO UPDATE
                    SET applied_at = EXCLUDED.applied_at,
                        description = EXCLUDED.description
                """
            ),
            {"v": version, "t": time.time(), "d": description},
        )


def _has_business_tables() -> bool:
    """库里是否已有业务表（用于识别「create_all 建出来的老库」）。

    判据用 ai_sessions：它是本次引入的全部新表里最早存在的那张。
    老库有可能连 ai_* 都还没有（更早期版本），那种情况走正常 v1→v2。
    """
    with engine.connect() as conn:
        row = conn.execute(text("SELECT to_regclass('public.ai_sessions') IS NOT NULL")).scalar()
    return bool(row)


def _ensure_version_table() -> None:
    with engine.begin() as conn:
        conn.execute(text(_VERSION_TABLE_DDL))
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_schema_version_applied "
                "ON schema_version (applied_at)"
            )
        )


def migrate() -> int:
    """把数据库推进到 CURRENT_SCHEMA_VERSION，返回最终版本号。

    幂等：已应用的版本会被跳过；重复执行不产生副作用。
    """
    _ensure_version_table()
    current = _current_version()

    # ---- baseline：老库已有业务表，却没有任何版本记录 ----
    # 这些表不是 v1 建的，直接记 v1 为已应用，避免重跑建表语句。
    if current == 0 and _has_business_tables():
        _record(1, "baseline（检测到既有表，跳过建表）")
        current = 1
        log.info("[db] 检测到既有表，已记录 baseline = v1")

    if current >= CURRENT_SCHEMA_VERSION:
        log.info("[db] schema 已是最新：v%s", current)
        return current

    for version, description, statements in MIGRATIONS:
        if version <= current:
            continue

        log.info("[db] 执行迁移 v%s → v%s（%s）", current, version, description)
        try:
            with engine.begin() as conn:
                for sql in statements:
                    try:
                        conn.execute(text(sql))
                    except ProgrammingError as exc:
                        if _is_duplicate_error(exc):
                            continue
                        raise
        except Exception as exc:  # noqa: BLE001 - 迁移失败必须让启动失败，不能带着旧结构跑
            log.error("[db] 迁移 v%s 失败：%s", version, exc)
            raise

        _record(version, description)
        current = version
        log.info("[db] ✅ 迁移 v%s 完成", version)

    return current


def schema_info() -> dict[str, Any]:
    """供 /api/ai/status 暴露的只读快照（失败不抛异常）。"""
    try:
        _ensure_version_table()
        return {"schema_version": _current_version(), "schema_error": None}
    except Exception as exc:  # noqa: BLE001
        return {"schema_version": None, "schema_error": str(exc)}
