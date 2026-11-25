"""数据库：SQLAlchemy 2.0 引擎 / 会话 / 建表。

为什么用同步 SQLAlchemy
----------------------
FastAPI 的同步路由跑在线程池里，本项目的数据量（几十条资源、单份工作区）
完全不需要 async ORM；同步接口更少踩连接池与 event loop 的坑。

启动时会等数据库就绪（Docker 里 pg 刚起来需要几秒），带轮询重试，
避免 `dev.sh` 在 db 尚未 ready 时把后端判成启动失败。
"""

from __future__ import annotations

import time
from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def get_session() -> Iterator[Session]:
    """FastAPI 依赖：每请求一个会话，退出时关闭。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def wait_for_db(timeout_seconds: float = 30.0, interval: float = 0.5) -> None:
    """阻塞等待数据库可连接（供启动钩子调用）。"""
    deadline = time.monotonic() + timeout_seconds
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception as exc:  # noqa: BLE001 - 启动期任何连不上都重试
            last_err = exc
            time.sleep(interval)
    raise RuntimeError(f"数据库在 {timeout_seconds}s 内未就绪：{last_err}")


def init_db() -> int:
    """建表 + 迁移（两段都幂等），返回最终 schema 版本号。

    ★ 为什么需要两段
      `create_all` **只建「不存在的表」，永不 ALTER 已有表** ——
      老库加字段（例如 ai_sessions.sdk_session_id）它完全看不见，
      于是 SELECT 会撞 `UndefinedColumn`。所以：

        ① create_all  新库快路径：按 ORM 定义一次性建齐
        ② migrate()   老库慢路径：补 create_all 建不出来的增量变更

      两条路径都幂等，任意顺序重跑都安全。
    """
    import logging

    log = logging.getLogger("editvmd.db")

    # ① 先 import 模型，让它们注册到 Base.metadata
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    # ② 补增量变更（版本化，见 migrations.py）
    from .migrations import migrate

    version = migrate()
    log.info("[db] schema 版本 = v%s", version)
    return version
