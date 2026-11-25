#!/usr/bin/env python3
"""括号内动作片段的分段解析 v2。

解决的问题
  括号内的描述天然是「一串动作」，例如:
      先摆摆手，又鞠了个躬
      低头看了看手，又抬起头，轻轻叹了口气
      一边笑一边鼓掌

  而分类器只能回答"这段文本像哪个动作"，给不出顺序。
  所以必须先把整句切成若干「动作段」，逐段分类，再按段序拼回动作序列。

与旧 sequence_parser 的区别
  旧版只认「先/再/然后/接着/随后/之后/最后」这类书面顺序词，
  覆盖不到口语里最常见的「，又」「，就」「一边…一边…」。

本模块提供
  split_stage(text) -> list[str]     把一段描述切成若干动作段
  is_parallel(seg) -> bool           该段是否是「一边…一边」并列复合段

设计要点
  1. 「一边A一边B」表示同时发生 → 不切开，整段返回，
     交给段内多正标签分类器判断（可同时命中两个动作）
  2. 逗号后接连接词（又/就/便/然后/接着/随后/顺势/随即/连忙/跟着）→ 切
  3. 纯逗号（无连接词）→ 也切，但保留连接词剥离后的干净文本；
     若切出的某段被分类器判为"无动作"（状态描述），上层直接丢弃即可
  4. 不切的情况：逗号前后都很短且属于同一语义单元（如"低头，看了看手"仍切）
"""
from __future__ import annotations

import re

# 出现在逗号后、表示"紧接着下一个动作"的连接词
_JOINERS = [
    "然后又", "接着又", "随后又", "又", "然后就", "接着", "随后",
    "之后", "最后", "随即", "顺势", "连忙", "赶紧", "跟着", "就", "便",
]

# 并列标记：一边…一边… / 一面…一面… / 边…边…
_PARALLEL_RE = re.compile(r"(?:一边|一面|边).+?(?:一边|一面|边)")

# 切分点：中文/英文逗号、分号、顿号
_SPLIT_PUNCT = re.compile(r"[，,；;、]")

# 无标点也能切开的「顺序连接词」
#
# 为什么需要（M14）
#   模型蒸馏语料几乎全是带逗号的句子（实测「先.+再」无逗号句 **0 条**），
#   于是「先挥手再走路」「挥手然后走路」这类口语输入会整段送分类，
#   只回归出 1 个动作，后面的动作直接丢掉。
#
#   这里用**零宽断言**在连接词前面切开，连接词本身留在后一段，
#   由 _clean() 的 _LEAD_STRIP 剥掉，得到干净的动作段。
#
#   注意 `再` 前面必须是"已完成一件事"的语境，否则「再来一次」会被误切。
# 用**捕获组**切分（re.split 会把捕获内容保留在结果里），
# 这样连接词跟着后一段走，再交给 _clean() 剥掉。
# 不用 lookbehind：Python 的 lookbehind 要求定宽，`再` 前面长度不定。
_SPLIT_CONNECTIVE = re.compile(
    r"(然后又|接着又|随后又|然后就|然后才|紧接着|然后|接着|随后|最后|先是|之后|再)"
)

# 句首/句尾需要剥掉的残留连接词与语气
_LEAD_STRIP = re.compile(
    r"^(?:然后又|接着又|随后又|然后就|然后|先是|先是又|首先|先|再|又|就|便|"
    r"接着|随后|之后|最后|随即|顺势|连忙|赶紧|跟着)"
)
_TAIL_STRIP = re.compile(r"(?:然后又|接着|随后|之后|最后|再)$")


# ============ 修饰性分句识别（v1.1 新增）============
#
# 背景：括号描述里大量「状态/神态/结果」分句，例如
#   「抬起手挥了挥，又放下」     ← 「放下」是结果状态，不是独立动作
#   「抬起手示意，眼睛亮亮的」    ← 「眼睛亮亮的」是神态
#   「轻轻欠身，声音也放低了」    ← 「声音放低」是状态
# 若这些分句被独立送分类，模型会强行给出动作（放下→挥手驱赶、
# 眼睛亮亮→揉眼睛），导致 set_match 只有 29%。
#
# 策略：切段时显式标记 modifier，引擎直接跳过（不送模型）。

_MODIFIER_PATTERNS = [
    # 结果/收势
    "又放下", "放下手", "放下", "松开", "停住", "停在空中", "落回",
    # 神态/表情
    "眼睛亮", "眼睛看着", "眼神", "目光", "眼里", "眼眶", "眉头",
    "嘴角", "神情", "表情", "一脸", "神色", "脸红了", "脸色",
    # 声音/呼吸
    "声音", "小声", "轻声", "语气", "叹了口气", "喘了口气", "舒气",
    "呼了口气",
    # 纯情绪/感受
    "心里", "感觉", "显得", "看起来", "像是", "仿佛", "似乎",
    # 纯笑（无其他动作词时）
    "笑了笑", "微微一笑",
]

# 「放下」若后接具体物品，属于真动作，不算修饰
_OBJECT_WORDS = ("杯", "书", "笔", "包", "东西", "物品", "手机", "碗", "刀")

# 动作动词白名单：分句含任一，即视为「有真实动作」，不判为修饰段
# 这是关键保护：避免把「小声说」（G11-25a 悄悄话）、
# 「一脸无奈地摊手」（G3-04a 摊手）这类真动作误过滤。
_ACTION_VERBS = (
    "挥", "摆", "指", "走", "跑", "跳", "蹦", "蹲", "坐", "站", "躺",
    "抱", "拍", "推", "拉", "捂", "鞠", "点", "摇", "转", "伸", "举",
    "搓", "揉", "挠", "摸", "撑", "叉", "摊", "耸", "扭", "甩", "鼓",
    "击", "比", "划", "画", "敲", "拽", "攥", "握", "捏", "弹", "踢",
    "跺", "晃", "打", "抓", "扶", "按", "压", "扯", "撩", "别", "合十",
    "作揖", "敬礼", "点头", "摇头", "鞠躬", "鼓掌", "握拳", "叉腰",
    "耸肩", "摊手", "抱臂", "捂脸", "比心", "指路", "招呼",
)


def is_modifier(seg: str) -> bool:
    """判断该分句是否只是「状态/神态/结果」，而非独立动作。

    双条件：① 含状态/神态词  ② 完全不含动作动词
    这样「小声说」（含小声，但"说"是动作）不会被过滤，
    「眼睛亮亮的」（含眼睛亮，无动作词）会被过滤。
    """
    s = (seg or "").strip()
    if not s:
        return True

    # 含动作动词 → 一律不判为修饰（保护真动作）
    if any(v in s for v in _ACTION_VERBS):
        return False

    for pat in _MODIFIER_PATTERNS:
        if pat in s:
            if pat.startswith("放下") and any(o in s for o in _OBJECT_WORDS):
                continue
            return True
    return False


def is_parallel(seg: str) -> bool:
    """是否「一边…一边…」式并列复合段（同时发生，不切开）。"""
    return bool(_PARALLEL_RE.search(seg or ""))


def _clean(seg: str) -> str:
    s = (seg or "").strip()
    if not s:
        return ""
    # 反复剥句首连接词（可能出现"然后又"叠"又"）
    for _ in range(3):
        new = _LEAD_STRIP.sub("", s).strip()
        if new == s:
            break
        s = new
    s = _TAIL_STRIP.sub("", s).strip()
    return s


def _split_by_connectives(seg: str) -> list[str]:
    """把没有标点的「先A再B / A然后B / A接着B」按连接词切开。

    只处理**显式顺序**语义，避免误切：
      · 「先挥手再走路」→ ['先挥手', '再走路']
      · 「挥手然后走路」→ ['挥手', '然后走路']
      · 「一起来」     → ['一起来']        （"一起"是并列，不是顺序）
      · 「再见」       → ['再见']          （"再"不是连接词）

    返回切好的段列表；若没有可切点，原样返回 [seg]。
    """
    s = (seg or "").strip()
    if not s:
        return [s]

    # 只有在出现明确的"顺序"信号时才切
    has_seq = (
        re.search(r"先.{1,20}?(?:再|然后|接着|随后|之后)", s) is not None
        or re.search(r".{1,20}?(?:然后又|接着又|随后又|然后就|紧接着|然后|接着|随后)", s)
        is not None
    )
    if not has_seq:
        return [s]

    # re.split 带捕获组：["A", "连接词", "B", "连接词", "C", ...]
    raw = _SPLIT_CONNECTIVE.split(s)
    pieces: list[str] = []
    buf = raw[0] if raw else ""
    i = 1
    while i < len(raw):
        conn = raw[i]
        body = raw[i + 1] if i + 1 < len(raw) else ""
        # 「再」单独成段且前段为空 → 不是顺序连接词（如"再来一次"）
        if conn == "再" and not buf.strip():
            buf += conn + body
            i += 2
            continue
        # 「再」后面紧跟 1 个字（如"再走"）保留在段内，正常切
        pieces.append(buf)
        buf = conn + body
        i += 2
    pieces.append(buf)

    pieces = [p.strip() for p in pieces if p and p.strip()]
    # 切出的段过短（1 字）说明切点可疑，放弃切分
    if len(pieces) < 2 or any(len(p) < 2 for p in pieces):
        return [s]
    return pieces


def split_stage(text: str) -> list[str]:
    """把一句动作神态描述切成若干动作段。

    >>> split_stage("先摆摆手，又鞠了个躬")
    ['摆摆手', '鞠了个躬']
    >>> split_stage("一边笑一边鼓掌")
    ['一边笑一边鼓掌']            # 并列，不切
    >>> split_stage("开心地挥挥手")
    ['开心地挥挥手']
    """
    if not text:
        return []
    s = text.strip()
    if not s:
        return []

    # 整句就是并列 → 不切
    if is_parallel(s):
        return [s]

    raw_parts = [p for p in _SPLIT_PUNCT.split(s) if p.strip()]

    # 无标点顺序句兜底：把「先A再B」「A然后B」切开
    #   只有单段（整句没有标点）时才需要
    if len(raw_parts) == 1:
        raw_parts = [p for p in _split_by_connectives(raw_parts[0])
                     if p.strip()]

    segs: list[str] = []
    for p in raw_parts:
        # 单个分句内如果本身是并列，也整段保留
        if is_parallel(p):
            segs.append(p.strip())
            continue
        c = _clean(p)
        if c:
            segs.append(c)

    return segs if segs else [s]


def split_with_meta(text: str) -> list[dict]:
    """切分并附带元信息，便于调试与日志。"""
    out = []
    for i, seg in enumerate(split_stage(text)):
        out.append({
            "index": i,
            "text": seg,
            "parallel": is_parallel(seg),
            "modifier": is_modifier(seg),
        })
    return out


def split_action_only(text: str) -> list[str]:
    """切分并过滤掉修饰段，只保留真正的动作段。

    若全部是修饰段，退回原始整句（交给模型兜底，避免空结果）。
    """
    segs = split_stage(text)
    actions = [s for s in segs if not is_modifier(s)]
    return actions if actions else segs


if __name__ == "__main__":
    import sys

    cases = sys.argv[1:] or [
        "先摆摆手，又鞠了个躬",
        "一边笑一边鼓掌",
        "低头看了看手，又抬起头，轻轻叹了口气",
        "抬手指向前方，又指了指他",
        "托着腮帮子，出神地想事情",
        "开心地挥挥手",
        "委屈地低下头，然后擦了擦眼睛",
        "双手叉腰，又抬手指向旁边",
        "先站定不动，又竖起手指轻轻嘘了一声",
    ]
    for c in cases:
        segs = split_with_meta(c)
        print(f"\n输入: {c}")
        for s in segs:
            mark = " [并列]" if s["parallel"] else ""
            print(f"  [{s['index']}] {s['text']}{mark}")