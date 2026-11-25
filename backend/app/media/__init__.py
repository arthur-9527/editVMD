"""媒体管线：视频 → MMD 动作（VMD）。

两条能力共用这条管线，区别只在**视频从哪来**：

    能力1（文本 → 动作，AI 专用）
        text ──minimax.i2v(pose.png 固定首帧)──▶ mp4
             ──animchar.motion──▶ Mixamo .glb
             ──glb2vmd──▶ .vmd

    能力2（参考视频 → 动作，UI 悬浮窗）
        用户上传 mp4 ──animchar.motion──▶ .glb ──glb2vmd──▶ .vmd

模块划分：
    minimax.py      MiniMax-H3 图生视频（仅 i2v；Metaso 中转）
    animchar.py     AnimChar 视频动捕（motion-capture → .glb）
    glb2vmd.py      glb→vmd 薄封装（内嵌转换器 + 当前模型 PMX 解析）
    glb2vmd_core/   内嵌的 glb2vmd 源码闭包（进程内调用，不依赖外部目录/venv）
    pipeline.py     video_to_vmd() 串起「动捕 + 转换」
    prompt.py       能力1 的 i2v 提示词模板（人物动作类约束句 / 禁用词）

设计要点（务必保持）：
    * glb2vmd 已**内嵌进本系统**，进程内直接调用，不再 subprocess / 外部目录。
    * 目标 PMX = 当前系统正在用的模型（从后端工作区解析，不作配置项）。
    * 所有失败都以可读中文异常（MediaError）抛出，上层转成工具 / HTTP 错误。
    * 不在这里碰数据库；落库 / 入库由调用方（tools 或 routers）负责。
"""

from __future__ import annotations

from .errors import MediaError

__all__ = ["MediaError"]
