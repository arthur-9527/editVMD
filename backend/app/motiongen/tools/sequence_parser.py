"""组合指令解析：把"先挥手，再鞠躬"切成多个动作。

支持的分隔词:
  先…再…然后…最后…
  先…然后…
  一…二…（少用）

切分策略:
  1. 按顺序词（先/再/然后/接着/最后/之后）切分
  2. 每段独立走语义识别
  3. 按切分顺序拼接，自动累加 delay
"""
from __future__ import annotations

import re

# 顺序词（按出现顺序切分）
SEQ_WORDS = ["先", "首先", "然后", "接着", "再", "之后", "最后", "随后"]

# 切分正则：在顺序词前后切开
_SPLIT_RE = re.compile(
    r"(?:首先|先|然后|接着|随后|之后|最后|再)")


def split_sequence(text: str) -> list[str]:
    """把一句话切成多段动作描述。

    "先挥挥手，再鞠个躬" -> ["挥挥手", "鞠个躬"]
    "挥挥手然后鞠躬" -> ["挥挥手", "鞠躬"]
    单动作 "挥挥手" -> ["挥挥手"]
    """
    s = text.strip()
    if not s:
        return []

    # 先去掉标点，保留中文
    s_clean = re.sub(r"[，,。.！!？?、；;：:]+", " ", s)

    # 找所有顺序词的位置
    parts = _SPLIT_RE.split(s_clean)
    parts = [p.strip() for p in parts if p.strip()]

    # 如果切出来只有 1 段，说明是单动作
    if len(parts) <= 1:
        return [s]

    # 过滤掉纯语气词段
    NOISE = {"吧", "呢", "啊", "哦", "了", "的", "好"}
    parts = [p for p in parts if p not in NOISE and len(p) >= 2]
    return parts if parts else [s]


def is_multi(text: str) -> bool:
    """判断是否是组合指令。"""
    return len(split_sequence(text)) > 1


def parse_sequence(text: str, engine, default_gap: float = 0.3) -> dict:
    """解析组合指令。

    返回:
      {
        "operation": "command" | "unsupported" | "chat",
        "actions": [{id, speed, strength, repeat, delay}, ...],
        "segments": [...],   # 每段的原始文本与识别结果
      }
    """
    segments = split_sequence(text)
    if not segments:
        return {"operation": "chat", "actions": [], "segments": []}

    # 单动作走原逻辑
    if len(segments) == 1:
        out = engine.parse(text)
        out["segments"] = [{"text": text, "result": out.get("operation")}]
        return out

    actions = []
    seg_info = []
    cursor = 0.0  # 累计时间（秒）

    for seg in segments:
        out = engine.parse(seg)
        op = out.get("operation")
        seg_info.append({"text": seg, "operation": op,
                         "confidence": out.get("confidence")})

        if op != "command" or not out.get("actions"):
            continue

        act = dict(out["actions"][0])
        act["delay"] = round(cursor, 3)
        actions.append(act)

        # 估算本段时长，用于下一段的 delay
        # 基础 4.43 秒（133 帧），按 speed 与 repeat 调整
        base = 4.43
        dur = base / max(act.get("speed", 1.0), 0.1) * max(act.get("repeat", 1), 1)
        cursor += dur + default_gap

    if not actions:
        return {"operation": "unsupported", "actions": [],
                "segments": seg_info, "confidence": 0.0}

    return {
        "operation": "command",
        "actions": actions,
        "segments": seg_info,
        "confidence": 1.0,
    }