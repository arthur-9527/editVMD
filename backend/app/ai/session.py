"""AISession：一个 ClaudeSDKClient + 一条持久消息泵。

对齐参考项目 claude-desktop 的 backend/core/session.py 主干，
砍掉数据库写入点以外的全部（图片、子任务、审批、context_memory）。

生命周期
--------
    start()   -> connect() + asyncio.create_task(_pump())
    send()    -> 落 user 行 -> client.query() -> STREAMING
    _pump()   -> async for msg in client.receive_messages() -> _dispatch()
    stop()    -> 取消泵 -> disconnect()

广播由 broadcast 回调注入（router 层把它实现成「推给所有 WS 客户端」），
这样 session 本身不依赖 FastAPI。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from enum import Enum
from typing import Any, Awaitable, Callable

from . import options as opt
from . import store

log = logging.getLogger("editvmd.ai.session")

BroadcastFn = Callable[[str, dict[str, Any]], Awaitable[None]]


class SessionState(str, Enum):
    IDLE = "idle"
    STREAMING = "streaming"


def new_message_id() -> str:
    return uuid.uuid4().hex


# usage 里「缓存命中 / 写入」这类字段：网关可能用 snake_case，也可能用 camelCase
_USAGE_KEY_ALIASES: dict[str, tuple[str, ...]] = {
    "input_tokens": ("input_tokens", "inputTokens"),
    "output_tokens": ("output_tokens", "outputTokens"),
    "cache_read_input_tokens": ("cache_read_input_tokens", "cacheReadInputTokens"),
    "cache_creation_input_tokens": (
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
    ),
}


def _usage_int(usage: Any, key: str) -> int:
    """从 usage dict 里取整数（兼容 snake_case / camelCase 两种键名，缺省 0）。"""
    if not isinstance(usage, dict):
        return 0
    for k in _USAGE_KEY_ALIASES.get(key, (key,)):
        v = usage.get(k)
        if isinstance(v, (int, float)):
            return int(v)
    return 0


class AISession:
    """一个 SDK 会话。

    session_id 在首轮结束前可能还不是 SDK 真正的 UUID（SDK 在 ResultMessage
    里回传）。所以这里有两个字段：
        self.session_id      应用层 id（可能是临时值）
        self.sdk_session_id  SDK 回传的真实 id
    捕获到真实 id 后通过 on_sdk_session_id 回调让 manager 迁移会话行。
    """

    def __init__(
        self,
        session_id: str,
        *,
        broadcast: BroadcastFn,
        resume: str | None = None,
        on_sdk_session_id: Callable[[str, str], None] | None = None,
    ) -> None:
        self.session_id = session_id
        self.sdk_session_id: str | None = resume
        # ★ 本会话专属工作目录（沙箱）：storage/ai_workspace/<session_id>
        #   它同时是 SDK 的 cwd —— 文件工具默认落在这里，且被沙箱钩子兜住越权。
        self.cwd = opt.settings.ai_session_dir(session_id)
        self._broadcast = broadcast
        self._resume = resume
        self._on_sdk_session_id = on_sdk_session_id

        self._client: Any = None
        self._connected = False
        self._pump_task: asyncio.Task[None] | None = None
        self._state = SessionState.IDLE
        self._last_used = time.time()

        # ★ 编辑器工具桥（MCP 工具 → 浏览器）。在 start() 里随 SDK 会话一起构造。
        self._bridge: Any = None
        # MCP server 配置（构造后缓存，避免重复 build）
        self._mcp_servers: dict[str, Any] | None = None

        # 当前消息的聚合缓冲
        self._current_message_id: str | None = None
        self._current_text: list[str] = []
        self._tool_calls: list[dict[str, Any]] = []
        self._interrupted = False

        # ★ 活跃后台任务登记（task_id -> info）。
        # 正常路径下我们已用 PreToolUse 钩子禁掉 Task/后台，这里只是「监管兜底」：
        # 万一仍有任务启动，前端也要能看见并停止，而不是后台悄悄跑。
        self._active_tasks: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------ 属性

    @property
    def is_connected(self) -> bool:
        return self._connected and self._client is not None

    @property
    def is_streaming(self) -> bool:
        return self._state is SessionState.STREAMING

    @property
    def is_idle(self) -> bool:
        return self._state is SessionState.IDLE and not self._interrupted

    @property
    def last_used(self) -> float:
        return self._last_used

    def runtime_state(self) -> dict[str, Any]:
        """供前端「活跃状态表」校准。"""
        return {
            "session_id": self.session_id,
            "is_streaming": self.is_streaming,
            "sdk_session_id": self.sdk_session_id or "",
            # ★ 前台工具之外的「后台任务」清单（正常为空）；前端据此显示可停止卡片
            "active_tasks": [
                {
                    "task_id": task_id,
                    "description": info.get("description", ""),
                    "task_type": info.get("task_type", "task"),
                    "status": info.get("status", "running"),
                    "progress": info.get("progress", ""),
                    "started_at": info.get("started_at", 0.0),
                }
                for task_id, info in self._active_tasks.items()
            ],
        }

    @property
    def has_active_tasks(self) -> bool:
        """是否有后台任务在跑（供清理时保护）。"""
        return len(self._active_tasks) > 0

    # ------------------------------------------------------------ 生命周期

    async def start(self) -> None:
        """连接 SDK 并启动消息泵。"""
        from claude_agent_sdk import ClaudeSDKClient

        if self._connected:
            return

        # 确保会话沙箱目录存在（ai_videos/ 与 tmp/）
        try:
            from ..storage import ensure_ai_session_dirs

            ensure_ai_session_dirs(self.session_id)
        except Exception as exc:  # noqa: BLE001 - 目录建不出也不阻断连接
            log.warning("[ai] 创建会话目录失败 %s: %s", self.session_id, exc)

        opts = opt.build_options(
            resume=self._resume,
            mcp_servers=self._build_mcp_servers(),
            extra_allowed_tools=self._mcp_allowed_tools(),
            cwd=self.cwd,
        )
        self._client = ClaudeSDKClient(opts)
        await self._client.connect()
        self._connected = True
        self._last_used = time.time()
        self._pump_task = asyncio.create_task(self._pump())
        log.info("[ai] session 已启动: %s (resume=%s)", self.session_id, bool(self._resume))

    # ------------------------------------------------ 编辑器工具（MCP）

    def _build_mcp_servers(self) -> dict[str, Any] | None:
        """构造「本会话专属」的编辑器工具 server。

        ★ 每会话一个实例：它的 bridge 捕获本会话的 session_id，
          因此工具请求只会发给本会话所属的浏览器标签。
        ★ 构造失败（如 SDK 无 create_sdk_mcp_server）时返回 None，
          会话照常可用，只是没有编辑器工具 —— 不能因为工具挂不上就断开对话。
        """
        if self._mcp_servers is not None:
            return self._mcp_servers or None
        try:
            from .tools.bridge import ToolBridge
            from .tools.server import build_server

            self._bridge = ToolBridge(lambda: self.session_id, broadcast=self._broadcast)
            server = build_server(self._bridge)
            self._mcp_servers = {"editvmd": server}
        except Exception as exc:  # noqa: BLE001
            log.exception("[ai] 编辑器工具初始化失败（对话继续，但无编辑能力）: %s", exc)
            self._mcp_servers = {}
        return self._mcp_servers or None

    def _mcp_allowed_tools(self) -> list[str]:
        """编辑器工具在 allowed_tools 里的全名。"""
        try:
            from .tools.server import mcp_tool_names

            return mcp_tool_names()
        except Exception:  # noqa: BLE001
            return []

    def resolve_tool_result(
        self, request_id: str, ok: bool, data: Any = None, error: str | None = None
    ) -> bool:
        """浏览器回传 tool:result 时转给 bridge。"""
        if self._bridge is None:
            return False
        return bool(self._bridge.resolve(request_id, ok, data, error))

    async def stop(self) -> None:
        """停止：取消消息泵 + 断开连接。"""
        # ★ 先把等待中的编辑器工具请求全部失败掉 —— 否则它们会一直等到超时
        if self._bridge is not None:
            try:
                self._bridge.fail_all("会话已停止")
            except Exception:  # noqa: BLE001
                pass
        if self._pump_task is not None:
            self._pump_task.cancel()
            try:
                await self._pump_task
            except BaseException:  # noqa: BLE001 - 取消/异常都吞掉
                pass
            self._pump_task = None

        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception as exc:  # noqa: BLE001
                log.warning("[ai] disconnect 异常 session=%s: %s", self.session_id, exc)
        self._client = None
        self._connected = False
        log.info("[ai] session 已停止: %s", self.session_id)

    async def interrupt(self) -> None:
        """中断当前 turn（会话保持）。"""
        self._interrupted = True
        if self._client is not None and self._connected:
            try:
                await self._client.interrupt()
                log.info("[ai] 已发送中断: session=%s", self.session_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("[ai] 中断失败: %s", exc)

    # ------------------------------------------------------------ 发送

    async def send(self, prompt: str, editor_context: str = "") -> str:
        """发送用户消息，返回 message_id。

        存库分两份：content 是用户原文，raw 里另存 editor_context，
        这样历史回放时不会把上下文标记当成用户说过的话。
        """
        if not self.is_connected:
            raise RuntimeError("会话未连接")

        message_id = new_message_id()
        self._current_message_id = message_id
        self._current_text = []
        self._tool_calls = []
        self._interrupted = False
        self._last_used = time.time()

        # ① 落库（user 原文 + 上下文）
        store.upsert_session(
            self.session_id,
            first_prompt=prompt,
            cwd=str(self.cwd),
            model=opt.settings.ai_model,
            # 恢复历史会话时已知真实 id；新会话这里是 None，稍后由 migrate 迁移
            sdk_session_id=self.sdk_session_id,
        )
        store.append_message(
            self.session_id,
            "user",
            "user",
            prompt,
            raw={"user_text": prompt, "editor_context": editor_context},
        )

        # ② 广播开始
        await self._broadcast(
            "message:start",
            {"message_id": message_id, "role": "user", "session_id": self.session_id},
        )

        # ③ 拼成一条完整 prompt（上下文在前，用户原文在后）
        # ★ 会话专属工作目录放在**动态**的编辑器上下文里，而不是 system prompt。
        #   这样 system（含很长的人设 + 工具描述）对所有会话逐字节一致，
        #   供应商的前缀缓存可以跨会话命中；工作目录依然能传给模型。
        ctx = f"工作目录={self.cwd}"
        if editor_context:
            ctx = f"{ctx} · {editor_context}"
        full_prompt = f"[编辑器上下文] {ctx}\n[用户消息] {prompt}"

        await self._client.query(full_prompt)
        self._state = SessionState.STREAMING
        await self._notify_status()
        return message_id

    # ------------------------------------------------------------ 消息泵

    async def _pump(self) -> None:
        """持续接收 SDK 消息并分发。"""
        try:
            async for msg in self._client.receive_messages():
                await self._dispatch(msg)
        except asyncio.CancelledError:
            log.info("[ai] 消息泵已取消: %s", self.session_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("[ai] 消息泵异常 session=%s: %s", self.session_id, exc)
            # 自愈：复位状态，避免前端按钮卡在「执行中」
            self._state = SessionState.IDLE
            self._interrupted = False
            try:
                if self._client is not None:
                    await self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._client = None
            self._connected = False
            await self._broadcast("system:error", {"error": f"AI 连接异常：{exc}"})
            await self._notify_status()

    async def _dispatch(self, msg: Any) -> None:
        """按消息类型分发。

        ★ 顺序很重要：Task*Message 继承自 SystemMessage，必须先判子类再判父类，
          否则会被 SystemMessage 分支吞掉（参考项目同款坑）。
        ★ UserMessage 里携带的是**工具结果**（ToolResultBlock）——之前直接 pass
          导致前端永远收不到 tool_result，工具行卡在「运行中」。这里必须派发。
        """
        from claude_agent_sdk.types import (
            AssistantMessage,
            ResultMessage,
            SystemMessage,
            TaskNotificationMessage,
            TaskProgressMessage,
            TaskStartedMessage,
            UserMessage,
        )

        self._last_used = time.time()

        if isinstance(msg, AssistantMessage):
            await self._handle_assistant(msg)
        elif isinstance(msg, ResultMessage):
            await self._handle_result(msg)
        elif isinstance(msg, TaskStartedMessage):
            await self._handle_task_started(msg)
        elif isinstance(msg, TaskProgressMessage):
            await self._handle_task_progress(msg)
        elif isinstance(msg, TaskNotificationMessage):
            await self._handle_task_notification(msg)
        elif isinstance(msg, UserMessage):
            await self._handle_user(msg)
        elif isinstance(msg, SystemMessage):
            # 其它系统消息（hook events 等）：忽略
            pass

    async def _handle_user(self, msg: Any) -> None:
        """处理 UserMessage：主要承载工具执行结果（ToolResultBlock）。

        ★ 这是「工具行一直运行中」的根因所在：SDK 把 tool_result 放在下一条
          UserMessage 的 content 里，而不是 AssistantMessage。
        """
        from claude_agent_sdk.types import ToolResultBlock

        content = getattr(msg, "content", None)
        if not isinstance(content, list):
            return

        for block in content:
            if not isinstance(block, ToolResultBlock):
                continue
            matched = ""
            if block.tool_use_id:
                for tc in self._tool_calls:
                    if tc.get("id") == block.tool_use_id:
                        matched = tc.get("tool", "")
                        break
            preview = str(block.content)[:500]
            is_error = bool(getattr(block, "is_error", False))
            store.append_message(
                self.session_id,
                "tool_result",
                "assistant",
                preview,
                raw={
                    "tool": matched,
                    "tool_use_id": block.tool_use_id,
                    "result": preview,
                    "is_error": is_error,
                },
                turn_index=-1,
            )
            await self._broadcast(
                "message:tool_result",
                {
                    "message_id": self._current_message_id,
                    "tool_name": matched,
                    "tool_result": preview,
                    "tool_id": block.tool_use_id,
                    "is_error": is_error,
                    "session_id": self.session_id,
                },
            )

    # ------------------------------------------------ 后台任务（监管兜底）

    async def _handle_task_started(self, msg: Any) -> None:
        """后台任务 / 子 agent 启动（正常已被钩子拦掉，这里只做监管显示）。"""
        task_id = getattr(msg, "task_id", None) or ""
        if not task_id:
            return
        self._active_tasks[task_id] = {
            "description": getattr(msg, "description", "") or "后台任务",
            "task_type": getattr(msg, "task_type", None) or "task",
            "status": "running",
            "started_at": time.time(),
        }
        log.warning("[ai] 检测到后台任务启动（应由钩子拦截）: %s", task_id)
        await self._broadcast(
            "message:task_started",
            {
                "session_id": self.session_id,
                "task_id": task_id,
                "description": self._active_tasks[task_id]["description"],
                "task_type": self._active_tasks[task_id]["task_type"],
                "message_id": self._current_message_id,
            },
        )
        await self._notify_status()

    async def _handle_task_progress(self, msg: Any) -> None:
        task_id = getattr(msg, "task_id", None) or ""
        info = self._active_tasks.get(task_id)
        if info is None:
            return
        usage = getattr(msg, "usage", None)
        if isinstance(usage, dict):
            info["progress"] = f"工具 {usage.get('tool_uses', '?')} 次 · {usage.get('duration_ms', 0)}ms"
        await self._broadcast(
            "message:task_progress",
            {
                "session_id": self.session_id,
                "task_id": task_id,
                "description": getattr(msg, "description", "") or info.get("description", ""),
                "progress": info.get("progress", ""),
                "message_id": self._current_message_id,
            },
        )

    async def _handle_task_notification(self, msg: Any) -> None:
        task_id = getattr(msg, "task_id", None) or ""
        status = getattr(msg, "status", "") or "completed"
        self._active_tasks.pop(task_id, None)
        await self._broadcast(
            "message:task_notification",
            {
                "session_id": self.session_id,
                "task_id": task_id,
                "status": status,
                "result": getattr(msg, "summary", "") or "",
                "message_id": self._current_message_id,
            },
        )
        await self._notify_status()

    async def stop_task(self, task_id: str) -> bool:
        """停止单个后台任务（不影响主会话）。"""
        if not self.is_connected or self._client is None:
            return False
        if task_id not in self._active_tasks:
            return False
        self._active_tasks[task_id]["status"] = "stopping"
        try:
            await self._client.stop_task(task_id)
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("[ai] stop_task 失败 %s: %s", task_id, exc)
            return False

    async def _handle_assistant(self, msg: Any) -> None:
        """处理一个 AssistantMessage 的各个内容块。"""
        from claude_agent_sdk.types import (
            TextBlock,
            ThinkingBlock,
            ToolResultBlock,
            ToolUseBlock,
        )

        for block in msg.content:
            if isinstance(block, TextBlock):
                self._current_text.append(block.text)
                await self._broadcast(
                    "message:text",
                    {
                        "message_id": self._current_message_id,
                        "text": block.text,
                        "is_delta": True,
                        "session_id": self.session_id,
                    },
                )

            elif isinstance(block, ThinkingBlock):
                # 不入库，只广播（前端默认折叠）
                await self._broadcast(
                    "message:thinking",
                    {
                        "message_id": self._current_message_id,
                        "thinking": block.thinking,
                        "session_id": self.session_id,
                    },
                )

            elif isinstance(block, ToolUseBlock):
                self._tool_calls.append(
                    {"tool": block.name, "input": block.input, "id": block.id}
                )
                store.append_message(
                    self.session_id,
                    "tool_use",
                    "assistant",
                    f"{block.name}",
                    raw={"tool": block.name, "input": block.input, "id": block.id},
                    turn_index=-1,
                )
                await self._broadcast(
                    "message:tool_use",
                    {
                        "message_id": self._current_message_id,
                        "tool_name": block.name,
                        "tool_input": block.input,
                        "tool_id": block.id,
                        "session_id": self.session_id,
                    },
                )

            elif isinstance(block, ToolResultBlock):
                matched = ""
                if block.tool_use_id:
                    for tc in self._tool_calls:
                        if tc.get("id") == block.tool_use_id:
                            matched = tc.get("tool", "")
                            break
                preview = str(block.content)[:500]
                store.append_message(
                    self.session_id,
                    "tool_result",
                    "assistant",
                    preview,
                    raw={
                        "tool": matched,
                        "tool_use_id": block.tool_use_id,
                        "result": preview,
                    },
                    turn_index=-1,
                )
                await self._broadcast(
                    "message:tool_result",
                    {
                        "message_id": self._current_message_id,
                        "tool_name": matched,
                        "tool_result": preview,
                        "tool_id": block.tool_use_id,
                        "session_id": self.session_id,
                    },
                )

    async def _handle_result(self, msg: Any) -> None:
        """一轮结束：落助手消息 + 广播 message:complete。"""
        start = time.time()

        # 捕获 SDK 的真实 session_id（首次会话时与临时 id 不同）
        sdk_sid = getattr(msg, "session_id", None)
        if sdk_sid and not self.sdk_session_id:
            self.sdk_session_id = sdk_sid
            log.info("[ai] 捕获 SDK session_id: %s", sdk_sid)
            if self._on_sdk_session_id is not None:
                try:
                    self._on_sdk_session_id(self.session_id, sdk_sid)
                except Exception as exc:  # noqa: BLE001
                    log.warning("[ai] 迁移会话行失败: %s", exc)

        full_text = "".join(self._current_text) or (getattr(msg, "result", "") or "")
        content = full_text.strip()

        is_error = bool(getattr(msg, "is_error", False))
        stop_reason = getattr(msg, "stop_reason", "") or ""
        num_turns = int(getattr(msg, "num_turns", 0) or 0)
        max_turns = opt.settings.ai_max_turns
        max_turns_reached = stop_reason == "max_turns" or (is_error and num_turns >= max_turns)

        # 中断分支
        if self._interrupted:
            self._interrupted = False
            store.append_message(
                self.session_id, "assistant", "assistant", content or "（已中断）"
            )
            await self._broadcast(
                "message:complete",
                {
                    "message_id": self._current_message_id,
                    "success": False,
                    "cancelled": True,
                    "content": content,
                    "session_id": self.session_id,
                },
            )
            self._state = SessionState.IDLE
            await self._notify_status()
            return

        duration = (time.time() - start) * 1000
        cost = float(getattr(msg, "total_cost_usd", 0.0) or 0.0)

        # ★ 缓存观测：网关若返回 prompt caching 用量，记录并在完成消息里带出去，
        #   用于验证「静态 system 前缀 + 工具描述」是否真的被复用（命中率）。
        usage = getattr(msg, "usage", None) or {}
        cache_hit = _usage_int(usage, "cache_read_input_tokens")
        cache_write = _usage_int(usage, "cache_creation_input_tokens")
        input_tokens = _usage_int(usage, "input_tokens")
        output_tokens = _usage_int(usage, "output_tokens")
        if cache_hit or cache_write or input_tokens:
            log.info(
                "[ai] 缓存用量 session=%s 命中=%d 写入=%d 输入=%d 输出=%d",
                self.session_id, cache_hit, cache_write, input_tokens, output_tokens,
            )

        if content:
            store.append_message(
                self.session_id, "assistant", "assistant", content, turn_index=num_turns
            )
        store.set_summary_and_stats(
            self.session_id,
            summary=content[:200] if content else None,
            total_turns=num_turns or None,
            total_cost_usd=cost or None,
        )

        success = (not is_error) or max_turns_reached
        await self._broadcast(
            "message:complete",
            {
                "message_id": self._current_message_id,
                "success": success,
                "content": content,
                "error": getattr(msg, "result", None) if is_error else None,
                "duration_ms": duration,
                "num_turns": num_turns,
                "total_cost_usd": cost,
                "max_turns_reached": max_turns_reached,
                "session_id": self.session_id,
                # ★ 缓存用量（命中 / 写入 / 输入 / 输出），前端可选展示
                "cache_hit_tokens": cache_hit,
                "cache_write_tokens": cache_write,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        )

        self._state = SessionState.IDLE
        await self._notify_status()

    # ------------------------------------------------------------ 广播工具

    async def _notify_status(self) -> None:
        try:
            await self._broadcast("session:status", self.runtime_state())
        except Exception as exc:  # noqa: BLE001
            log.warning("[ai] 广播 session:status 失败: %s", exc)
