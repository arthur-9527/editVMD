"""侧边栏 AI：基于 claude-agent-sdk 的会话层。

模块职责
--------
    options.py   把 .env / settings 翻译成 ClaudeAgentOptions
    store.py     ai_sessions / ai_messages 的镜像读写（失败绝不阻断对话）
    session.py   一个 Session = 一个 ClaudeSDKClient + 持久消息泵
    manager.py   多会话并发、resume、LRU 回收、列表 / 删除
    router.py    WS /api/ai/ws + REST /api/ai/*

设计原则
--------
* 真值交给 SDK（JSONL），Postgres 只是镜像 + 元信息。
* 不做审批回调：permission_mode=bypassPermissions。
* 文件边界 = `cwd`（settings.ai_workdir），不配 add_dirs。
"""

from __future__ import annotations

__all__ = ["manager", "options", "router", "session", "store"]
