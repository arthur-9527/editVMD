"""反向 RPC 桥：把 MCP 工具调用转发到浏览器，并等待浏览器回结果。

问题
----
MCP 工具在**后端**（Python）里执行，但真正的编辑器状态在**浏览器**里
（studio-store 的 clip、reze-engine 的骨架）。工具要"改动作 / 读姿势"，
必须把请求送回浏览器那一侧执行。

方案
----
每个 AI 会话（session_id）持有自己的 `ToolBridge`：

    call(tool, args)                          后端 MCP 工具被调用
      → 生成 request_id，记进 self._pending
      → 经 broadcast_fn 广播 {type:"tool:call", data:{request_id, session_id, tool, args}}
      → await Future（浏览器 tool:result 时 resolve）

    resolve(request_id, ok, data|error)        router 收到 tool:result 时调用
      → set_result，await 结束

扇出语义（按需求）
------------------
一个 session 可能同时被多个浏览器标签打开 → 广播给该 session 的**全部** ws；
哪条先回结果就用哪条（其余同 request_id 的结果忽略）。工具结果因此天然同步。
标签页全断 → 超时，返回结构化错误给模型（让它自己重试或换方案）。

线程 / 事件循环
--------------
MCP 工具 handler 与 WS handler 都在同一个 FastAPI 事件循环里跑（SDK 的
in-process server 直接把 handler 当协程 await），所以这里用 asyncio.Future +
asyncio.Lock 即可，不需要跨线程原语。
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger("editvmd.ai.tools.bridge")

BroadcastFn = Callable[[str, dict[str, Any]], Awaitable[None]]

# 工具调用超时（秒）。太短会误杀大生成，太长会让模型一直干等。
DEFAULT_TIMEOUT = 30.0


class ToolBridge:
    """一个 AI 会话 ↔ 浏览器的工具请求/应答通道。"""

    def __init__(
        self,
        session_id_provider: Callable[[], str | None],
        *,
        broadcast: BroadcastFn,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        # ★ session_id 会变：SDK 首轮结束后把临时 id 换成真实 UUID，
        #   manager 里 key 也随之迁移。用回调实时读，别把 id 存成固定值。
        self._session_id_provider = session_id_provider
        self._broadcast = broadcast
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._counter = itertools.count(1)

    @property
    def session_id(self) -> str | None:
        return self._session_id_provider()

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        """发起一次前端调用，返回 {ok, data} 或 {ok:False, error}。

        ★ 永远不抛异常：MCP handler 需要把失败也包成 tool result 返回给模型，
          让它能看到原因（例如"编辑器未连接"）并自行决策。
        """
        session_id = self.session_id
        if not session_id:
            return {"ok": False, "error": "会话尚未建立，无法定位编辑器"}

        request_id = f"{tool}-{next(self._counter)}-{int(time.time() * 1000) % 100000}"
        loop = asyncio.get_event_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = fut

        try:
            await self._broadcast(
                "tool:call",
                {
                    "request_id": request_id,
                    "session_id": session_id,
                    "tool": tool,
                    "args": args,
                },
            )
        except Exception as exc:  # noqa: BLE001 - 广播失败不应卡住
            self._pending.pop(request_id, None)
            log.warning("[tool.bridge] 广播失败 %s: %s", tool, exc)
            return {"ok": False, "error": f"编辑器通道不可用：{exc}"}

        try:
            return await asyncio.wait_for(fut, timeout=self._timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            log.warning("[tool.bridge] 超时 %s (session=%s)", tool, session_id)
            return {
                "ok": False,
                "error": "编辑器未在超时时间内响应（可能未打开页面或连接已断开）",
            }
        except asyncio.CancelledError:
            self._pending.pop(request_id, None)
            raise
        finally:
            self._pending.pop(request_id, None)

    def resolve(self, request_id: str, ok: bool, data: Any = None, error: str | None = None) -> bool:
        """浏览器回结果时调用。返回 True 表示确实有等待中的请求被唤醒。"""
        fut = self._pending.get(request_id)
        if fut is None or fut.done():
            return False
        if not ok:
            fut.set_result({"ok": False, "error": error or "前端执行失败"})
        else:
            fut.set_result({"ok": True, "data": data})
        return True

    def fail_all(self, reason: str) -> None:
        """WS 断开 / 会话停止时，把所有等待中的请求一次性失败掉。"""
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_result({"ok": False, "error": reason})
        self._pending.clear()
