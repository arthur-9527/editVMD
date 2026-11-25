"""WS /api/ai/ws + REST /api/ai/*。

协议（与参考项目同名，便于对照）：
  前端 -> 后端: message:send / message:cancel / session:new / session:switch
                session:list / session:messages / session:rename / session:delete
  后端 -> 前端: system:status / session:status / session:created
                session:list / session:messages / message:start|text|thinking|
                tool_use|tool_result|complete / system:error

为什么用 WebSocket 而不是 REST 轮询：
流式 token 需要「服务端主动推」，HTTP 只能轮询或 SSE；
SSE 又不便双向（停止 / 切换会话），WS 一步到位。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from . import options as opt
from . import store
from .manager import AISessionManager

log = logging.getLogger("editvmd.ai.router")

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AIBroadcaster:
    """把 session 的广播扇出给所有已连接的 WS 客户端。

    ★ `tool:call` 例外：它必须只发给**该会话所属**的标签页。
      一个 session 可能被多个标签同时打开（需求），所以登记 session→ws 集合，
      工具调用时扇出给这一集合，哪条先回结果就用哪条。
    """

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        # session_id -> 订阅了该会话的 ws 集合
        self._session_clients: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.add(ws)

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)
            # 断开时从所有会话订阅里摘掉
            for subs in self._session_clients.values():
                subs.discard(ws)
            for sid in [s for s, subs in self._session_clients.items() if not subs]:
                self._session_clients.pop(sid, None)

    async def subscribe(self, ws: WebSocket, session_id: str | None) -> None:
        """把 ws 登记到某会话（该 ws 发/切过这个会话）。"""
        if not session_id:
            return
        async with self._lock:
            self._session_clients.setdefault(session_id, set()).add(ws)

    def count(self) -> int:
        return len(self._clients)

    async def _send_many(self, targets: list[WebSocket], payload: str) -> None:
        for ws in targets:
            try:
                await ws.send_text(payload)
            except Exception:  # noqa: BLE001 - 单个连接断开不影响其它
                await self.remove(ws)

    async def __call__(self, msg_type: str, data: dict[str, Any]) -> None:
        """session.py 注入的 BroadcastFn。"""
        payload = json.dumps(
            {"type": msg_type, "data": data}, ensure_ascii=False, default=str
        )
        # ★ tool:call 只发给该会话订阅者；其余广播给所有客户端
        if msg_type == "tool:call":
            sid = str(data.get("session_id") or "")
            targets = list(self._session_clients.get(sid, ())) or list(self._clients)
        else:
            targets = list(self._clients)
        await self._send_many(targets, payload)


# ---------------------------------------------------------------- 运行期单例

_broadcaster = AIBroadcaster()
_manager: AISessionManager | None = None


def get_manager() -> AISessionManager:
    global _manager
    if _manager is None:
        _manager = AISessionManager(_broadcaster)
    return _manager


async def shutdown_manager() -> None:
    global _manager
    if _manager is not None:
        await _manager.shutdown()
        _manager = None


def _db_diagnostics() -> dict[str, Any]:
    """镜像库诊断信息：schema 版本 + 最近一次写/读失败。

    ★ 为什么要暴露：store 里的异常只记日志会让前端以为「没有历史」，
      而不是「数据库结构不对」。把原因透出去，侧边栏能直接提示。
    """
    info: dict[str, Any] = {}
    try:
        from ..migrations import schema_info

        info.update(schema_info())
    except Exception as exc:  # noqa: BLE001
        info["schema_version"] = None
        info["schema_error"] = str(exc)
    info["db_error"] = store.last_error
    return info


def availability() -> dict[str, Any]:
    """统一的可用性判断（REST 与 WS 共用）。"""
    diag = _db_diagnostics()

    if not settings.ai_enabled:
        return {"enabled": False, "available": False, "error": "AI 已在配置中禁用", **diag}
    if not opt.sdk_available():
        return {
            "enabled": True,
            "available": False,
            "error": "未安装 claude-agent-sdk，请执行 scripts/setup-ai.sh",
            **diag,
        }
    if not opt.credentials_present():
        return {
            "enabled": True,
            "available": False,
            "error": "未配置 EDITVMD_AI_API_KEY（DeepSeek API Key），请编辑 backend/.env",
            **diag,
        }
    return {
        "enabled": True,
        "available": True,
        "error": None,
        "model": settings.ai_model,
        "base_url": settings.ai_base_url,
        "workdir": str(settings.ai_workdir),
        "permission_mode": settings.ai_permission_mode,
        "max_turns": settings.ai_max_turns,
        **diag,
    }


# ---------------------------------------------------------------- REST


@router.get("/status")
def ai_status() -> dict[str, Any]:
    """前端启动探测：AI 是否可用、模型名、工作目录。"""
    info = availability()
    manager = get_manager()
    info["active_sessions"] = len(manager.active_snapshot())
    info["clients"] = _broadcaster.count()
    return info


@router.get("/sessions")
def ai_sessions(limit: int = 50, offset: int = 0) -> dict[str, Any]:
    return {"sessions": get_manager().list(limit=limit, offset=offset)}


@router.get("/sessions/{session_id}/messages")
def ai_messages(session_id: str, limit: int = 200, offset: int = 0) -> dict[str, Any]:
    return get_manager().messages(session_id, limit=limit, offset=offset)


@router.patch("/sessions/{session_id}")
def ai_rename(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    ok = get_manager().rename(session_id, str(body.get("title", "")))
    return {"success": ok, "session_id": session_id}


@router.delete("/sessions/{session_id}")
async def ai_delete(session_id: str) -> dict[str, Any]:
    ok = await get_manager().delete(session_id)
    return {"success": ok, "session_id": session_id}


# ---------------------------------------------------------------- 标准骨骼 / 映射


@router.get("/standard-skeleton")
def ai_standard_skeleton() -> dict[str, Any]:
    """标准骨架（youla 抽取，机器可读版）。前端启动时拉一次备用。"""
    from .tools import standard_skeleton as std

    data = std.load()
    return {"ok": True, "source": std.source_text(), "key_bones": std.key_bones(), "data": data}


@router.post("/bone-map")
async def ai_bone_map(body: dict[str, Any]) -> dict[str, Any]:
    """把非标准模型骨骼映射到标准骨骼（一次 LLM，带缓存；失败退化为启发式）。

    body: {model_name?: str, bones: [{name,nameEn?,parent?,pos?,ik?}], pmx_sha256?, asset_id?}
    返回: {ok, human, reason, mapping, unmapped, invalid, source}
    """
    from . import bone_map

    model_name = str(body.get("model_name") or "")
    raw_bones = body.get("bones")
    bones = [b for b in raw_bones if isinstance(b, dict)] if isinstance(raw_bones, list) else []
    pmx_sha256 = body.get("pmx_sha256")
    asset_id = body.get("asset_id")
    try:
        return await bone_map.map_bones(
            model_name,
            bones,
            pmx_sha256=str(pmx_sha256) if pmx_sha256 else None,
            asset_id=str(asset_id) if asset_id else None,
        )
    except Exception as exc:  # noqa: BLE001 - 映射失败不该 500 掉载入链路
        log.warning("[ai] bone-map 失败：%s", exc)
        return {
            "ok": False,
            "human": True,
            "reason": f"骨骼映射失败：{exc}",
            "mapping": {},
            "unmapped": [],
            "invalid": [],
            "source": "error",
        }


# ---------------------------------------------------------------- WebSocket


async def _send(ws: WebSocket, msg_type: str, data: dict[str, Any]) -> None:
    await ws.send_text(json.dumps({"type": msg_type, "data": data}, ensure_ascii=False, default=str))


@router.websocket("/ws")
async def ai_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    await _broadcaster.add(websocket)

    info = availability()
    manager = get_manager()

    # 握手：先告诉前端能不能用
    await _send(
        websocket,
        "system:status",
        {
            **info,
            "active_sessions": manager.active_snapshot(),
            "sessions": manager.list(limit=50),
        },
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await _send(websocket, "system:error", {"error": "消息不是合法 JSON"})
                continue

            msg_type = payload.get("type", "")
            data = payload.get("data", {}) or {}
            try:
                await _handle_client_message(websocket, manager, msg_type, data)
            except Exception as exc:  # noqa: BLE001 - 任何异常都不能打断连接
                log.exception("[ai.ws] 处理 %s 失败: %s", msg_type, exc)
                await _send(websocket, "system:error", {"error": str(exc)})

    except WebSocketDisconnect:
        log.info("[ai.ws] 客户端断开")
    except Exception as exc:  # noqa: BLE001
        log.exception("[ai.ws] 连接异常: %s", exc)
    finally:
        await _broadcaster.remove(websocket)


async def _handle_client_message(
    ws: WebSocket, manager: AISessionManager, msg_type: str, data: dict[str, Any]
) -> None:
    if msg_type == "message:send":
        info = availability()
        if not info["available"]:
            await _send(ws, "system:error", {"error": info["error"]})
            return
        prompt = str(data.get("prompt", "")).strip()
        if not prompt:
            return
        session_id = data.get("session_id") or None
        editor_context = str(data.get("editor_context", "") or "")
        try:
            used_sid = await manager.send(prompt, editor_context, session_id)
        except Exception as exc:  # noqa: BLE001 - 含「上一轮未结束」的串行拒绝
            log.exception("[ai.ws] 发送失败: %s", exc)
            await _send(ws, "system:error", {"error": f"发送失败：{exc}"})
            # 串行被拒 / 失败时把运行态回给前端，避免按钮卡住
            await _send(ws, "session:status", manager.runtime_state(session_id) or {
                "session_id": session_id or "",
                "is_streaming": False,
                "active_tasks": [],
            })
            return
        # ★ 把这条 ws 登记为该会话的订阅者（工具调用只会发回这些标签页）
        await _broadcaster.subscribe(ws, used_sid)
        # ★ 新会话：把真实 session_id 回给前端，避免「每条消息新建一个会话」
        if session_id is None:
            await _send(ws, "session:switch", {"session_id": used_sid})
            await _send(ws, "session:list", {"sessions": manager.list(limit=50)})

    elif msg_type == "tool:result":
        # ★ 浏览器执行完编辑器工具后的回执（反向 RPC 的应答）
        request_id = str(data.get("request_id", ""))
        if not request_id:
            return
        ok = bool(data.get("ok", False))
        result_data = data.get("data")
        error = data.get("error")
        # ★ 按 request_id 在全量会话里找（request_id 全局唯一，不必猜是哪个会话）
        resolved = manager.resolve_tool_result(request_id, ok, result_data, error)
        if not resolved:
            log.debug("[ai.ws] tool:result 无匹配请求: %s", request_id)

    elif msg_type == "message:cancel":
        sid = data.get("session_id") or None
        await manager.interrupt(sid)
        # ★ 校准：无论是否真的在跑，都把运行态回给前端（避免「停止」点不动）
        await manager.resync_status(sid)

    elif msg_type == "task:stop":
        # 停止单个后台任务（监管兜底：正常已被钩子拦掉，不会有任务）
        sid = data.get("session_id") or None
        ok = await manager.stop_task(str(data.get("task_id", "")), sid)
        await _send(ws, "session:status", manager.runtime_state(sid) or {
            "session_id": sid or "",
            "is_streaming": False,
            "active_tasks": [],
            "task_stopped": ok,
        })

    elif msg_type == "session:new":
        sess = await manager.new_session()
        await _send(
            ws,
            "session:created",
            {"session_id": sess.session_id, "success": True},
        )

    elif msg_type == "session:switch":
        sid = str(data.get("session_id", ""))
        if not sid:
            return
        sess = await manager.switch(sid)
        # ★ 切会话也登记订阅：之后这个标签页能收到本会话的工具调用
        await _broadcaster.subscribe(ws, sid)
        # 先回填历史，再广播运行态
        msgs = manager.messages(sid)
        await _send(ws, "session:messages", {**msgs, **{"from": "switch"}})
        await _send(ws, "session:status", sess.runtime_state())

    elif msg_type == "session:list":
        await _send(
            ws,
            "session:list",
            {"sessions": manager.list(limit=int(data.get("limit", 50) or 50))},
        )

    elif msg_type == "session:messages":
        sid = str(data.get("session_id", ""))
        if not sid:
            return
        offset = int(data.get("offset", 0) or 0)
        limit = int(data.get("limit", 200) or 200)
        msgs = manager.messages(sid, limit=limit, offset=offset)
        runtime = manager.runtime_state(sid) or {"is_streaming": False}
        await _send(ws, "session:messages", {**msgs, "is_streaming": runtime.get("is_streaming", False)})

    elif msg_type == "session:rename":
        sid = str(data.get("session_id", ""))
        if sid:
            ok = manager.rename(sid, str(data.get("title", "")))
            await _send(ws, "session:list", {"sessions": manager.list(limit=50), "renamed": ok})

    elif msg_type == "session:delete":
        sid = str(data.get("session_id", ""))
        if sid:
            ok = await manager.delete(sid)
            await _send(
                ws,
                "session:delete",
                {"session_id": sid, "success": ok, "sessions": manager.list(limit=50)},
            )

    else:
        log.debug("[ai.ws] 未知消息类型: %s", msg_type)
