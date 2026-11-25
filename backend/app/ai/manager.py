"""AISessionManager：多会话并发 + resume + LRU 回收。

对齐参考项目 claude-desktop 的 `backend/core/session_manager.py`，
但只保留单进程内需要的部分：
    get_or_create(session_id|None)  新建 / 复用 / resume
    reset()                         新对话 = 丢掉当前并新建
    list/rename/delete              走 store 镜像表
    cleanup()                       LRU 淘汰超过 ai_max_sessions 的会话

每个 Session 仍是一个独立的 ClaudeSDKClient（SDK 原生支持多 client 并发），
切走不再 stop，切回直接复用，这样「后台跑着的会话」不会被打断。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any

from ..config import settings
from . import store
from .session import AISession, BroadcastFn

log = logging.getLogger("editvmd.ai.manager")


class AISessionManager:
    """管理所有活跃 Session。"""

    def __init__(self, broadcast: BroadcastFn) -> None:
        self._broadcast = broadcast
        self._sessions: dict[str, AISession] = {}
        self._active_id: str | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------ 查询

    @property
    def active_session(self) -> AISession | None:
        if self._active_id:
            return self._sessions.get(self._active_id)
        return None

    def runtime_state(self, session_id: str) -> dict[str, Any] | None:
        sess = self._sessions.get(session_id)
        return sess.runtime_state() if sess else None

    def active_snapshot(self) -> list[dict[str, Any]]:
        return [s.runtime_state() for s in self._sessions.values()]

    def is_running(self, session_id: str) -> bool:
        """该会话是否「正在跑一轮」（流式输出中）。

        ★ 语义必须是 is_streaming，而不是 is_connected：
          SDK 会话建好后即保持连接，用 is_connected 会让历史列表永远显示
          「运行中」。is_streaming 只在真正生成时才是 True。
        """
        sess = self._sessions.get(session_id)
        return bool(sess and sess.is_streaming)

    # ------------------------------------------------------------ 获取 / 新建

    async def get_or_create(
        self,
        session_id: str | None = None,
        *,
        resume: str | None = None,
    ) -> AISession:
        """拿到一个可用的会话。

        Args:
            session_id: 应用层 id；None 表示新对话。
            resume: SDK 真实 UUID（切回历史会话时传它）。
        """
        async with self._lock:
            sid = session_id or uuid.uuid4().hex

            existing = self._sessions.get(sid)
            if existing is not None:
                if not existing.is_connected:
                    log.warning("[ai.manager] 会话已断连，重建: %s", sid)
                    await existing.stop()
                    self._sessions.pop(sid, None)
                    return await self._create(sid, resume=_resume_of(sid, resume))
                self._active_id = sid
                return existing

            return await self._create(sid, resume=_resume_of(sid, resume))

    async def _create(self, session_id: str, *, resume: str | None) -> AISession:
        def _on_sdk_sid(old: str, new: str) -> None:
            """SDK 回传真实 UUID 后**只记录**，不迁移、不换 key。

            ★ 为什么不换 key（这是「AI 没有记忆」的根因）：
              前端拿到的是我们回给它的 `session:switch`（= `old`）。若把内存
              会话改挂到 `new` 下，下一轮前端带着 `old` 来就命中不了
              `self._sessions`，于是每轮都新建一个会话、上下文清零。
              正确做法：会话 key 始终是前端看到的 id，只把 SDK 真实 UUID
              存进 `sdk_session_id`（列 + 对象），供 LRU / 重启后 resume 用。
            """
            if not new:
                return
            sess = self._sessions.get(old)
            if sess is not None:
                sess.sdk_session_id = new
            store.upsert_session(old, sdk_session_id=new)

        sess = AISession(
            session_id,
            broadcast=self._broadcast,
            resume=resume,
            on_sdk_session_id=_on_sdk_sid,
        )
        await sess.start()

        # ★ 惰性落库：**不**在这里写 ai_sessions。
        #   否则每次点「＋」/切会话都会插入一条 message_count=0、first_prompt 为空的行，
        #   历史列表就会被一堆「(无标题)」占满。
        #   真正的落库发生在首条 send()（那里带上 first_prompt 与后续的 sdk_session_id）。
        self._sessions[session_id] = sess
        self._active_id = session_id
        await self._cleanup_lru()
        log.info(
            "[ai.manager] 创建会话 %s (resume=%s, 活跃=%d)",
            session_id,
            bool(resume),
            len(self._sessions),
        )
        return sess

    # ------------------------------------------------------------ 会话操作

    async def switch(self, session_id: str) -> AISession:
        """切到某个历史会话；不在内存里就用 sdk_session_id resume。"""
        meta = store.get_session(session_id) or {}
        resume = meta.get("sdk_session_id") or None
        # 旧数据没有 sdk_session_id 时，假设 session_id 本身就是 UUID
        if not resume and _looks_like_uuid(session_id):
            resume = session_id
        return await self.get_or_create(session_id, resume=resume)

    async def new_session(self) -> AISession:
        """新对话：不与旧会话共享上下文（新 client + 新 UUID）。"""
        return await self.get_or_create(None)

    async def send(self, prompt: str, editor_context: str, session_id: str | None) -> str:
        """发送消息（session_id 为空时自动新建会话）。

        ★ 串行闸门：同一会话上一轮还没结束时直接拒绝，保证「一次只跑一条」，
          不会出现两轮同时流式、工具交错的无监管状态。
        ★ 返回**实际使用的 session_id**：前端首次发消息时还没有 id，
          router 据此回一条 session:switch，避免「每条消息都新建一个会话」。
        """
        sess = await self.get_or_create(session_id) if session_id else await self.new_session()
        if settings.ai_serial and sess.is_streaming:
            raise RuntimeError("上一轮还在执行中，请等待完成或先停止")
        await sess.send(prompt, editor_context)
        return sess.session_id

    async def interrupt(self, session_id: str | None = None) -> str | None:
        """中断指定会话（为空则当前活跃会话）。"""
        sess = self._sessions.get(session_id) if session_id else self.active_session
        if sess and sess.is_streaming:
            await sess.interrupt()
            return sess.session_id
        return None

    def resolve_tool_result(
        self, request_id: str, ok: bool, data: Any = None, error: str | None = None
    ) -> bool:
        """把浏览器回传的 tool:result 派发给持有该 request_id 的会话。

        ★ request_id 全局唯一，遍历所有活跃会话即可，不必猜是哪个。
        """
        for sess in list(self._sessions.values()):
            if sess.resolve_tool_result(request_id, ok, data, error):
                return True
        return False

    async def resync_status(self, session_id: str | None = None) -> None:
        """主动广播一次该会话运行态（用于「停止」无效时的前端校准）。

        典型场景：前端以为在跑、后端其实已 idle（超时 / 断流），
        此时再点停止不该毫无反应，至少要把执行态复位。
        """
        sess = self._sessions.get(session_id) if session_id else self.active_session
        if sess is not None:
            await self._broadcast("session:status", sess.runtime_state())

    async def stop_task(self, task_id: str, session_id: str | None = None) -> bool:
        """停止某个后台任务（不影响主会话）。"""
        sess = self._sessions.get(session_id) if session_id else self.active_session
        if sess is None:
            return False
        return await sess.stop_task(task_id)

    async def delete(self, session_id: str) -> bool:
        """软删除镜像行 + 停掉内存里的会话（并让 SDK 删掉 JSONL）。"""
        sess = self._sessions.pop(session_id, None)
        if sess is not None:
            await sess.stop()
            if self._active_id == session_id:
                self._active_id = None

        # ★ 会话 key 是应用层 id，SDK 的 JSONL 用的是 sdk_session_id；
        #   只有拿到真实 UUID 才能删掉磁盘上那份记录。
        meta = store.get_session(session_id) or {}
        sdk_sid = (sess.sdk_session_id if sess is not None else None) or meta.get("sdk_session_id") or session_id
        ok = store.deactivate_session(session_id)

        # ★ 先软删（is_active=False），再清理视频文件与整个会话沙箱目录。
        #   只删视频；生成的 VMD 在 storage/vmd/ 与用户动作库里，**保留**。
        try:
            from ..media import ai_videos

            ai_videos.delete_by_session(session_id)
        except Exception as exc:  # noqa: BLE001 - 清理失败不影响删除流程
            log.warning("[ai.manager] 清理会话视频失败 %s: %s", session_id, exc)

        try:
            from claude_agent_sdk import delete_session as sdk_delete_session

            sdk_delete_session(sdk_sid)
        except Exception as exc:  # noqa: BLE001 - SDK 删不掉不影响本地镜像删除
            # ★ 「not found」是正常情况：会话从未落盘 JSONL（首轮未完成就删）、
            #   或已被删过。这不该刷 warning —— 用户会误以为删除失败而反复点。
            msg = str(exc)
            if "not found" in msg.lower():
                log.debug("[ai.manager] SDK delete_session 无记录（可忽略）%s", sdk_sid)
            else:
                log.warning("[ai.manager] SDK delete_session 失败 %s: %s", sdk_sid, msg)
        return ok

    def rename(self, session_id: str, title: str) -> bool:
        return store.rename_session(session_id, title)

    def list(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        rows = store.list_sessions(limit=limit, offset=offset)
        for r in rows:
            r["is_running"] = self.is_running(r["session_id"])
        return rows

    def messages(self, session_id: str, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        """分页消息；镜像为空时回落到 SDK 的 JSONL。"""
        msgs, total = store.list_messages(session_id, limit=limit, offset=offset)
        if not msgs:
            try:
                from claude_agent_sdk import get_session_messages

                # ★ SDK 的 JSONL 以 sdk_session_id 命名，不是应用层 id；
                #   目录用的是**该会话自己的 cwd**（每个会话一个目录），
                #   老数据 cwd 为空时回落到 ai_workdir。
                meta = store.get_session(session_id) or {}
                sdk_sid = meta.get("sdk_session_id") or session_id
                directory = _session_cwd(meta)
                raw = get_session_messages(session_id=sdk_sid, directory=str(directory))
                sdk_msgs = [
                    {
                        "uuid": getattr(m, "uuid", "") or "",
                        "type": getattr(m, "type", "user") or "user",
                        "role": getattr(m, "role", "user") or "user",
                        "content": _extract_text(m),
                        "raw": None,
                        "turn_index": 0,
                        "created_at": 0.0,
                    }
                    for m in (raw or [])
                ]
                return {
                    "session_id": session_id,
                    "messages": list(reversed(sdk_msgs)),
                    "total_count": len(sdk_msgs),
                    "offset": 0,
                    "has_more": False,
                }
            except Exception as exc:  # noqa: BLE001 - 回落失败就返回空
                log.debug("[ai.manager] SDK 消息回落失败: %s", exc)

        return {
            "session_id": session_id,
            "messages": msgs,
            "total_count": total,
            "offset": offset,
            "has_more": offset + len(msgs) < total,
        }

    # ------------------------------------------------------------ 清理

    async def _cleanup_lru(self) -> None:
        """超过 ai_max_sessions 时淘汰最久未用的非活跃会话。"""
        limit = max(1, settings.ai_max_sessions)
        if len(self._sessions) <= limit:
            return

        candidates = [
            (sid, s)
            for sid, s in self._sessions.items()
            if sid != self._active_id and not s.is_streaming
        ]
        candidates.sort(key=lambda x: x[1].last_used)
        while len(self._sessions) > limit and candidates:
            sid, sess = candidates.pop(0)
            await sess.stop()
            self._sessions.pop(sid, None)
            log.info("[ai.manager] LRU 淘汰会话: %s", sid)

    async def shutdown(self) -> None:
        """进程退出时停掉所有会话。"""
        sessions = list(self._sessions.values())
        self._sessions.clear()
        self._active_id = None
        for sess in sessions:
            try:
                await sess.stop()
            except Exception as exc:  # noqa: BLE001
                log.warning("[ai.manager] 关闭会话失败 %s: %s", sess.session_id, exc)


def _session_cwd(meta: dict[str, Any]) -> Path:
    """该会话 JSONL / 工作目录：优先用镜像库记的 cwd，否则按 session_id 推。

    ★ 老数据（升级前）cwd 为空或指向 ai_workdir：礼貌回落到 ai_workdir，
      否则读不到已有 JSONL（历史消息会「凭空消失」）。
    """
    recorded = str(meta.get("cwd") or "").strip()
    sid = str(meta.get("session_id") or "").strip()
    if recorded:
        recorded_path = Path(recorded)
        # 会话专属目录必须以 session_id 结尾；不是的话按老数据回落
        if sid and recorded_path.name == sid:
            return recorded_path
    # 回落：老会话统一放在 ai_workdir 根
    return settings.ai_workdir


def _resume_of(session_id: str, resume: str | None) -> str | None:
    """会话不在内存时，从镜像库补出 resume 用的 SDK UUID。

    ★ 没有它的话，被 LRU 回收 / 进程重启后即使前端带着同一个 session_id
      回来，也会因为 SDK 没拿到 `resume` 而新建会话、丢上下文。
    """
    if resume:
        return resume
    try:
        meta = store.get_session(session_id) or {}
    except Exception:  # noqa: BLE001
        meta = {}
    sdk = meta.get("sdk_session_id") or None
    if sdk:
        return sdk
    # 旧数据：应用层 id 本身就是 SDK UUID
    return session_id if _looks_like_uuid(session_id) else None


def _looks_like_uuid(value: str) -> bool:
    import re

    return bool(
        re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            value,
            re.I,
        )
    )


def _extract_text(msg: Any) -> str:
    """从 SDK 消息对象里尽量取出文本。"""
    content = getattr(msg, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)
    return ""
