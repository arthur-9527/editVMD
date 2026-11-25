"""从文本里抽取情绪标签 + 强度，供 morph 表情管线使用。

与动作解析解耦：动作识别走 semantic_engine（embedding），
情绪识别走本模块（词表 + 修饰结构），两者互不干扰。

用法:
  parse_emotion("开心地挥挥手")  -> {"emotion": "happy", "intensity": 0.9, "mix": None}
  parse_emotion("有点害羞")      -> {"emotion": "shy", "intensity": 0.5, "mix": None}
  parse_emotion("又生气又难过")  -> {"emotion": "angry", "intensity": 0.85,
                                     "mix": {"angry": 0.5, "sad": 0.5}}
  strip_emotion("开心地挥挥手")  -> "挥挥手"
"""
from __future__ import annotations

import re

# 情绪词表：情绪 -> 中文关键词（越长越优先命中）
EMOTION_WORDS: dict[str, list[str]] = {
    "happy": [
        "开心", "高兴", "快乐", "愉快", "兴奋", "喜悦", "欢喜", "笑眯眯",
        "笑容", "乐呵呵", "美滋滋", "兴高采烈", "得意", "骄傲",
    ],
    "angry": [
        "生气", "愤怒", "恼怒", "气愤", "恼火", "火大", "暴躁", "不耐烦",
        "不满", "愤愤", "怒气",
    ],
    "sad": [
        "难过", "伤心", "悲伤", "失落", "沮丧", "低落", "忧郁", "委屈",
        "痛苦", "悲痛", "消沉",
    ],
    "surprised": [
        "惊讶", "吃惊", "震惊", "意外", "诧异", "惊奇", "错愕", "吓了一跳",
    ],
    "shy": [
        "害羞", "羞涩", "腼腆", "不好意思", "脸红", "害臊", "羞怯", "娇羞",
    ],
    "neutral": [
        "平静", "淡定", "冷静", "淡淡", "淡然", "从容", "面无表情",
        "无所谓", "平淡", "随意",
    ],
}

# 强度修饰
STRONG = ["非常", "特别", "超级", "极其", "十分", "十分地", "很", "太", "极"]
WEAK = ["有点", "有些", "稍微", "稍稍", "略微", "一点", "微微", "略有"]

# 连接词：剥离情绪词后可能残留的孤立连接字，一并清掉
_CONNECT_RE = re.compile(r"[又和与且也同]+")


def _match_emotion(text: str) -> list[tuple[str, str, int]]:
    """返回命中的 (emotion, 词, 位置)，按位置排序。"""
    s = text
    hits = []
    taken = [False] * len(s)
    # 按词长降序匹配，避免 "开心" 抢 "不开心" 里的字（虽然后者不在表里）
    all_words = [(w, e) for e, ws in EMOTION_WORDS.items() for w in ws]
    all_words.sort(key=lambda x: -len(x[0]))
    for w, e in all_words:
        start = 0
        while True:
            idx = s.find(w, start)
            if idx < 0:
                break
            if not any(taken[idx: idx + len(w)]):
                for k in range(idx, idx + len(w)):
                    taken[k] = True
                hits.append((e, w, idx))
            start = idx + 1
    hits.sort(key=lambda x: x[2])
    return hits


def _intensity_near(text: str, word: str) -> float:
    """在情绪词附近找强度修饰，返回强度倍率。"""
    idx = text.find(word)
    if idx < 0:
        return 1.0
    win_start = max(0, idx - 6)
    window = text[win_start: idx]
    for w in STRONG:
        if w in window:
            return 1.0
    for w in WEAK:
        if w in window:
            return 0.55
    return 0.85


def parse_emotion(text: str, default_intensity: float = 0.85) -> dict:
    """解析文本中的情绪，返回 {emotion, intensity, mix}。"""
    hits = _match_emotion(text)
    if not hits:
        return {"emotion": "neutral", "intensity": default_intensity, "mix": None}

    # 去重情绪标签（同情绪多词只算一次）
    seen: list[str] = []
    scores: dict[str, float] = {}
    for e, w, _ in hits:
        k = _intensity_near(text, w)
        if e not in seen:
            seen.append(e)
            scores[e] = k
        else:
            scores[e] = max(scores[e], k)

    intensity = round(min(1.0, max(scores.values())), 3)
    if len(seen) == 1:
        return {"emotion": seen[0], "intensity": intensity, "mix": None}

    # 多情绪混合（最多取前两种）
    picked = seen[:2]
    total = sum(scores[e] for e in picked)
    mix = {e: round(scores[e] / total, 3) for e in picked}
    return {"emotion": picked[0], "intensity": intensity, "mix": mix}


def strip_emotion(text: str) -> str:
    """剥掉情绪副词，避免干扰动作语义匹配。

    "开心地挥挥手" -> "挥挥手"
    "有点害羞地捂脸" -> "捂脸"
    整句都是情绪时回退原句（交给动作识别自行拒绝）。
    """
    hits = _match_emotion(text)
    if not hits:
        return text.strip()

    s = text
    spans: list[tuple[int, int]] = []
    for _e, w, idx in hits:
        start, end = idx, idx + len(w)
        # 向前吞掉紧邻的强度修饰
        for sw in sorted(STRONG + WEAK, key=len, reverse=True):
            if s[:start].endswith(sw):
                start -= len(sw)
                break
        # 向后吞掉"地/得/着/的"（"开心的招招手" 里的"的"也要剥掉）
        while end < len(s) and s[end] in "地得着的":
            end += 1
        spans.append((start, end))

    # 合并重叠区间后删除
    spans.sort()
    merged: list[tuple[int, int]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    out, last = [], 0
    for a, b in merged:
        out.append(s[last:a])
        last = b
    out.append(s[last:])
    s = "".join(out)

    s = _CONNECT_RE.sub("", s)
    s = re.sub(r"\s+", "", s)
    return s if s else text.strip()


if __name__ == "__main__":
    import sys

    cases = sys.argv[1:] or [
        "开心地挥挥手", "有点生气", "非常难过地鞠躬", "又害羞又开心",
        "无所谓地耸耸肩", "平淡地点点头", "吃惊地张大嘴", "又气又急",
    ]
    for c in cases:
        pe = parse_emotion(c)
        print(f"{c!r:24s} -> emotion={pe['emotion']:10s} "
              f"intensity={pe['intensity']} mix={pe['mix']}  "
              f"strip={strip_emotion(c)!r}")