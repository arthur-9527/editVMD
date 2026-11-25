"""舞台指示文本预处理：从 LLM 台词中提取括号内的动作描述 + 情绪。

输入形态：
    "你好（开心的招招手），今天天气真不错（踮起脚）"
    → 提取出 ["开心的招招手", "踮起脚"]

单条括号内容再拆成：
    动作部分（喂给分类器）  +  情绪部分（喂给 morph 管线）

    "开心的招招手" -> action="招招手", emotion="happy", intensity=0.85

若拿到的已是纯括号内容（系统只收括号内），则跳过提取直接解析。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# 中英文括号对
_BRACKET_RE = re.compile(r"[（(]([^）)]*)[）)]")


def extract_stage_directions(text: str) -> list[str]:
    """从台词中提取所有括号内的舞台指示。

    无括号时返回 [原文本]，兼容"已解析好的括号内容"场景。
    """
    if not text:
        return []
    found = [m.strip() for m in _BRACKET_RE.findall(text)]
    found = [f for f in found if f]
    if found:
        return found
    s = text.strip()
    return [s] if s else []


def split_action_emotion(stage: str) -> dict:
    """把一条舞台指示拆成动作文本 + 情绪信息。

    返回:
      {
        "action_text": "招招手",     # 去掉情绪修饰后的动作描述
        "raw": "开心的招招手",        # 原始舞台指示
        "emotion": "happy",
        "intensity": 0.85,
        "mix": None,
        "has_action": True,           # 剥离情绪后是否还剩动作词
      }
    """
    import emotion_parser as ep

    raw = (stage or "").strip()
    if not raw:
        return {"action_text": "", "raw": "", "emotion": "neutral",
                "intensity": 0.85, "mix": None, "has_action": False}

    emo = ep.parse_emotion(raw)
    action = ep.strip_emotion(raw).strip()

    return {
        "action_text": action,
        "raw": raw,
        "emotion": emo["emotion"],
        "intensity": emo["intensity"],
        "mix": emo.get("mix"),
        "has_action": bool(action),
    }


def parse_line(text: str) -> list[dict]:
    """一行台词 -> 多条舞台指示的解析结果。"""
    return [split_action_emotion(s) for s in extract_stage_directions(text)]


if __name__ == "__main__":
    cases = sys.argv[1:] or [
        "你好（开心的招招手），今天天气真不错（踮起脚）",
        "（害羞地低下头）人家不好意思嘛",
        "开心的招招手",
        "（笑了笑）",
        "（生气地用力跺脚三次）",
        "没有括号的普通台词",
    ]
    for c in cases:
        print(f"\n输入: {c}")
        for r in parse_line(c):
            print(f"  raw={r['raw']!r}")
            print(f"    action={r['action_text']!r} emotion={r['emotion']} "
                  f"intensity={r['intensity']} mix={r['mix']} "
                  f"has_action={r['has_action']}")