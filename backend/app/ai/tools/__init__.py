"""AI 可调用的编辑器工具集。

模块划分：
    bridge.py     反向 RPC：MCP 工具 ↔ 浏览器 WebSocket 请求/应答
    bone_ref.py   MMD 标准骨骼字典（日 / 英 / 中 + 说明 + 分组）
    server.py     in-process MCP server，注册全部工具

设计要点（务必保持）：
    - 工具本身是**薄转发**：真正的执行在浏览器（studio-store / reze-engine）。
      后端不知道 clip 结构，只负责把 args 送给前端、把结果转成 MCP content。
    - 所以新增工具时，后端只加一条规格，前端 tools.ts 里加一个分派分支。
"""

from __future__ import annotations
