#!/usr/bin/env python3
"""表情标签空间统一定义（训练 / 语料生成 / 推理共享，禁止各自硬编码）。

与动作系统的关系
----------------
本模块在表情子系统里扮演 `label_schema.py` 的角色：定义「可预测的原子」与
「组内互斥规则」。动作系统预测 347 个动作 ID + side/speed/strength/repeat，
表情系统预测 35 个 morph 原子 + 强度档；两者都是「多正标签 BCE + 段级解码」。

槽位模型（来自人工整理的表情规范）
--------------------------------
    眉       brow      ：选 1（7 个原子）
    眼·开合  eyeOpen   ：10 个语义态 / 14 个 morph，**组内互斥**，选 1（「睁」= 无原子）
    眼·眼角  eyeCorner ：眼角上 / 眼角下，组内互斥
    眼·下皮  eyeUnder  ：下眼上（组内只有 1 个）
    瞳孔     pupil     ：瞳小（独立）
    口       mouth     ：10 个原子，选 1

    眼 4 组（eyeOpen/eyeCorner/eyeUnder/pupil）**各自按 morph 生命周期起落**
    （`expression_engine.schedule_fifo`），不再强制同步：眼睛先恢复、眼角余韵更久。

训练标签
--------
    LABELS = 35 个原子 + `__neutral__`（无表情），维度 36。
    强度另做 3 分类（0.5 / 1.0 / 1.5），与动作系统的 strength 三档同构。

命名说明
--------
    `瞳笑` 是需求文档里的写法，5 个真实模型里只有 `瞳小`，故统一落为 `瞳小`。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATOMS_PATH = ROOT / "data" / "expression_atoms.json"

FPS = 30
NEUTRAL = "__neutral__"

# 顺序即标签顺序（改顺序会让已训练模型的 labels.json 失效，务必同步重训）
SLOTS: tuple[str, ...] = ("brow", "eyeOpen", "eyeCorner", "eyeUnder", "pupil", "mouth")

# 4 个眼相关槽（保留常量供外部查询）。
# 注意：编排层**不再强制同步** —— 每个 morph 按 `MORPH_TIMING` 独立起落，
# 眼睛先恢复、眼角/下眼余韵更久，比「4 组同时到位」更像真人。
EYE_BATCH: tuple[str, ...] = ("eyeOpen", "eyeCorner", "eyeUnder", "pupil")

# 每个槽的语义态 -> 候选 morph（按优先级；解码时取该槽内 sigmoid 最高的原子）
#   · 一个态有多个候选名时，**只取第一个**（同时写两个同名态会双重闭眼）
#   · eyeOpen 的「睁」不产生任何 morph（空集合 = 该槽留空）
SLOT_STATES: dict[str, dict[str, list[str]]] = {
    "brow": {
        "困る": ["困る"],        # 八字眉·带弧度（为难/委屈）
        "にこり": ["にこり"],    # 八字眉·直线（温和的笑）
        "怒り": ["怒り"],        # 眉尖下挑成勾·小幅
        "真面目": ["真面目"],    # 眉尖下挑成勾·大幅
        "上": ["上"],            # 双眉上扬
        "下": ["下"],            # 双眉下压
        "前": ["前"],            # 双眉紧簇
    },
    "eyeOpen": {
        "睁": [],                                         # 默认态，无 morph
        "双闭": ["まばたき", "なごみ"],                    # 双目闭合
        "左闭": ["ウィンク", "ウィンク２", "なごみ左"],     # 左眼闭合
        "右闭": ["ウィンク右", "ウィンク２右", "なごみ右"],  # 右眼闭合
        "圆睁": ["びっくり"],                              # 双目圆睁变大
        "半垂": ["じと目"],                                # 眼皮半垂
        "微眯喜": ["喜び"],                                # 微眯·喜悦
        "微眯怒": ["怒り目"],                              # 微眯·生气
        "翻白眼": ["ジト目"],                              # 微眯·翻白眼
        "闭眼笑": ["笑い"],                                # 闭合 + 眼尾上翘
    },
    "eyeCorner": {
        "眼角上": ["眼角上"],
        "眼角下": ["眼角下"],
    },
    "eyeUnder": {
        "下眼上": ["下眼上"],
    },
    "pupil": {
        "瞳小": ["瞳小"],        # 需求文档写作「瞳笑」，真实模型名为「瞳小」
    },
    "mouth": {
        "にやり": ["にやり"],
        "にやり２": ["にやり２"],
        "にやり３": ["にやり３"],
        "ω": ["ω"],
        "てへぺろ": ["てへぺろ"],
        "ぺろっ": ["ぺろっ"],
        "口角上げ": ["口角上げ"],
        "口角下げ": ["口角下げ"],
        "口横広げ": ["口横広げ"],
        "口横狭め": ["口横狭め"],
    },
}

# 槽 -> 原子列表（按声明顺序展开；eyeOpen 的 14 个 morph 都在这里）
SLOT_ATOMS: dict[str, list[str]] = {
    slot: [m for names in states.values() for m in names]
    for slot, states in SLOT_STATES.items()
}
ATOMS: list[str] = [m for slot in SLOTS for m in SLOT_ATOMS[slot]]
LABELS: list[str] = ATOMS + [NEUTRAL]
LABEL_INDEX: dict[str, int] = {n: i for i, n in enumerate(LABELS)}
ATOM_SLOT: dict[str, str] = {m: slot for slot in SLOTS for m in SLOT_ATOMS[slot]}

# 同槽内互斥（解码时每组只取 top1）
EXCLUSIVE_GROUPS: dict[str, list[str]] = {s: list(SLOT_ATOMS[s]) for s in SLOTS}

# 语义态 -> 候选 morph（由 SLOT_STATES 展平）。
#
# 用途：外部 `states` 入参可以直接写中文态名（`圆睁`/`双闭`），比 morph 名更直观；
# `expression_engine.resolve_atoms()` 用这张表做白名单校验。
# 注意两点：
#   1. brow/mouth/眼角/瞳孔的**键与 morph 同名** → 映射恒为自身，
#      因此不会改变「直接传 morph 名」的既有行为；
#   2. `睁` 映射为空列表 = 合法态但该槽不产生任何 morph（等价于「什么都不加」）。
STATE_TO_MORPH: dict[str, list[str]] = {
    state: list(names)
    for states in SLOT_STATES.values()
    for state, names in states.items()
}

# ---- 标签空间（P2 新增）：morph 原子空间 vs 语义态空间 ----
#
#   v1 `label_space="atom"` ：36 维 = 35 个 morph 原子 + `__neutral__`
#   v2 `label_space="state"`：31 维 = 30 个语义态   + `__neutral__`
#
# 为什么要收紧（实测教训）：
#   · 同槽多个 morph 是**同一语义态的别名**（`まばたき`/`なごみ` 都是「双闭」），
#     让 14 个 eyeOpen morph 各占一维，模型会去学「别名之间的随机选择」，
#     把有限的监督信号摊薄 —— logits 迅速饱和到 ±1e3，阈值彻底失效。
#   · 收敛成 9 个态后，argmax 只在语义互斥的态之间做；输出仍是 morph 名
#     （由 `STATE_TO_MORPH[state][0]` 决定首选），别名可通过 `states` 入参手动指定。
#
# `睁` 不进标签：它是「默认态 = 该槽什么都不加」，与 `__neutral__` 语义重叠；
# 「瞪大 / 怒目圆睁 / 瞪眼」对应的是 `圆睁`（morph `びっくり`），不是 `睁`。
EYE_STATES: tuple[str, ...] = ("双闭", "左闭", "右闭", "圆睁", "半垂",
                               "微眯喜", "微眯怒", "翻白眼", "闭眼笑")

# 槽 -> 态名列表（state 空间的标签顺序 = 槽序 × 态序）
SLOT_STATES_ORDERED: dict[str, list[str]] = {
    "brow": list(SLOT_STATES["brow"]),
    "eyeOpen": list(EYE_STATES),
    "eyeCorner": list(SLOT_STATES["eyeCorner"]),
    "eyeUnder": list(SLOT_STATES["eyeUnder"]),
    "pupil": list(SLOT_STATES["pupil"]),
    "mouth": list(SLOT_STATES["mouth"]),
}

STATE_LABELS: list[str] = [s for slot in SLOTS
                           for s in SLOT_STATES_ORDERED[slot]]
STATE_LABEL_INDEX: dict[str, int] = {s: i for i, s in enumerate(STATE_LABELS)}
STATE_SLOT: dict[str, str] = {s: slot for slot in SLOTS
                              for s in SLOT_STATES_ORDERED[slot]}
# 态 -> 首选 morph（解码出口：模型只预测态，写 VMD 仍是 morph 名）
STATE_TO_MORPH_FIRST: dict[str, str] = {
    s: STATE_TO_MORPH[s][0] for s in STATE_LABELS if STATE_TO_MORPH.get(s)
}
# morph 名 -> 语义态（单射：同态别名都归到同一态，如 なごみ/ウィンク２）
MORPH_TO_STATE: dict[str, str] = {
    m: s for s in STATE_LABELS for m in STATE_TO_MORPH.get(s, [])
}

# 各槽默认权重（0~1，乘强度倍率后 clamp）
#
# 现在**全部为 1.0**：MMD 的 morph 是「形变比例」，跨槽是独立的（DSL 管线
# 已明确「峰值可达 1，不归一」）。按槽打折会让「笑眯眯」只剩 0.5~0.8 的形变，
# 看起来笑不到位。要弱化某个表情，靠**选更弱的 morph / 更少的槽**，而不是在
# 槽上乘系数。保留这张表只为兼容 `expression_atoms.json` 的既有结构。
SLOT_WEIGHT: dict[str, float] = {
    "brow": 1.0,
    "eyeOpen": 1.0,
    "eyeCorner": 1.0,
    "eyeUnder": 1.0,
    "pupil": 1.0,
    "mouth": 1.0,
}

# ---------------------------------------------------------------- morph 生命周期
#
# (attack, hold, release) 单位=帧@30fps
#   · attack  进：0 -> peak
#   · hold    保持：peak 停留帧数，**硬约束 1..60（1 帧 ~ 2 秒）**
#   · release 出：peak -> 0
#
# 关键：生命周期**与动作总帧数无关**。曲线到点立即归零，不再「撑到动作结束」。
#   `まばたき` 9 帧（0.30s） / `笑い` 46 帧（1.53s） / `口横狭め` 37 帧（1.23s）
#
# hold=1 表示「单关键帧过渡」，即一处中间形态（例如切换时闪一帧 0.5）。
MORPH_TIMING: dict[str, tuple[int, int, int]] = {
    # ---- eyeOpen ----
    "まばたき":     (2,  2,  5),   #  9 帧 0.30s
    "ウィンク":     (3,  5,  6),   # 14 帧 0.47s
    "ウィンク２":   (3,  5,  6),
    "ウィンク右":   (3,  5,  6),
    "ウィンク２右": (3,  5,  6),
    "なごみ":       (6, 45, 10),   # 61 帧 2.03s（闭目养神）
    "なごみ左":     (6, 45, 10),
    "なごみ右":     (6, 45, 10),
    "びっくり":     (2,  6,  8),   # 16 帧 0.53s（惊讶是瞬时的）
    "喜び":         (5, 30, 10),   # 45 帧 1.50s
    "じと目":       (6, 30, 10),   # 46 帧 1.53s
    "ジト目":       (6, 30, 10),
    "怒り目":       (6, 30, 10),
    "笑い":         (6, 30, 10),   # 46 帧 1.53s
    # ---- brow ----
    "困る":   (8, 45, 12),   # 65 帧 2.17s
    "にこり": (6, 45, 10),
    "怒り":   (6, 30, 10),
    "真面目": (6, 45, 10),
    "上":     (5, 12,  8),   # 25 帧 0.83s（挑眉是短动作）
    "下":     (6, 45, 10),
    "前":     (6, 45, 10),
    # ---- eyeCorner / eyeUnder / pupil ----
    "眼角上": (6, 45, 10),
    "眼角下": (6, 45, 10),
    "下眼上": (6, 45, 10),
    "瞳小":   (2,  4,  6),   # 12 帧 0.40s
    # ---- mouth ----
    "にやり":   (5, 30, 10),
    "にやり２": (5, 30, 10),
    "にやり３": (5, 30, 10),
    "ω":        (5, 30,  8),   # 43 帧 1.43s
    "口横広げ": (5, 30, 10),
    "口横狭め": (5, 24,  8),   # 37 帧 1.23s（嘟嘴）
    "口角上げ": (6, 45, 10),
    "口角下げ": (6, 45, 10),
    "てへぺろ": (3,  5,  5),   # 13 帧 0.43s
    "ぺろっ":   (3,  4,  5),   # 12 帧 0.40s
}

# hold 硬约束（帧）：1 帧 = 单关键帧中间态；60 帧 = 2 秒
HOLD_RANGE: tuple[int, int] = (1, 60)

# 未知 atom 的兜底生命周期（正常不会用到：validate_schema 强制全覆盖）
DEFAULT_TIMING: tuple[int, int, int] = (6, 30, 10)

# 强度档（对应动作系统的 strength：0.5 轻微 / 1.0 正常 / 1.5 夸张）
INTENSITY_CLASSES: list[float] = [0.5, 1.0, 1.5]

# 旧 FIFO 过渡窗口（已废弃）：attack/release 现在由 `MORPH_TIMING` 逐 morph 决定，
# `schedule_fifo` 不再读取这两个值；保留只为兼容旧调用方与请求字段。
TRANSITION_OUT = 4
TRANSITION_IN = 5

# 段最少帧数：至少放得下最短的 morph 生命周期（并留 3 帧余量）
MIN_SEGMENT_FRAMES = TRANSITION_OUT + TRANSITION_IN + 3

# ---------------------------------------------------------------- 情绪配方
#
# 单值槽每项只给 1 个原子；未列出的槽留空（例如惊讶不强加嘴形）。
# 说明：需求文档把「惊讶」的嘴形给了 `あ`，但口部白名单里没有 `あ`
#       （「其他不需要管」），故惊讶不写嘴。

EMOTION_RECIPES: dict[str, dict[str, str]] = {
    "happy": {"brow": "にこり", "eyeOpen": "笑い",
              "eyeCorner": "眼角上", "mouth": "口角上げ"},
    "angry": {"brow": "怒り", "eyeOpen": "怒り目",
              "pupil": "瞳小", "mouth": "口角下げ"},
    "sad": {"brow": "困る", "eyeOpen": "じと目",
            "eyeCorner": "眼角下", "mouth": "口角下げ"},
    "surprised": {"brow": "上", "eyeOpen": "びっくり", "pupil": "瞳小"},
    "shy": {"brow": "困る", "eyeOpen": "じと目", "mouth": "口角上げ"},
    "speechless": {"brow": "下", "eyeOpen": "ジト目", "mouth": "ω"},
    "neutral": {},
    # ---- 以下为口语常见、但不在 6 情绪里的补充档 ----
    "proud": {"brow": "上", "mouth": "にやり"},
    "puzzled": {"brow": "上", "eyeOpen": "じと目", "mouth": "ω"},
    "disgusted": {"brow": "下", "eyeOpen": "ジト目", "mouth": "口角下げ"},
    "wronged": {"brow": "困る", "eyeOpen": "じと目",
                "eyeCorner": "眼角下", "mouth": "口角下げ"},
    "nervous": {"brow": "困る", "mouth": "口横狭め"},
    "excited": {"brow": "にこり", "eyeOpen": "喜び", "mouth": "口横広げ"},
    "tender": {"brow": "にこり", "eyeOpen": "なごみ", "mouth": "口角上げ"},
}

# ---------------------------------------------------------------- 中文词表
#
# 命中规则：**最长匹配优先**（先扫长词、占位后跳过），避免「苦笑」被「笑」抢走。
# 每条 = (中文表述, {槽: 原子})。

EXPRESSION_LEXICON: list[tuple[str, dict[str, str]]] = [
    # ---- 眉 ----
    ("眉头皱成一团", {"brow": "前"}),
    ("眉头紧锁", {"brow": "前"}),
    ("皱起眉头", {"brow": "前"}),
    ("蹙起眉头", {"brow": "前"}),
    ("紧簇", {"brow": "前"}),
    ("挑了挑眉", {"brow": "上"}),
    ("挑了一下眉", {"brow": "上"}),
    ("扬起眉毛", {"brow": "上"}),
    ("眉毛上扬", {"brow": "上"}),
    ("挑眉", {"brow": "上"}),
    ("扬眉", {"brow": "上"}),
    ("眉头一皱", {"brow": "怒り"}),
    ("皱着眉", {"brow": "怒り"}),
    ("皱眉", {"brow": "怒り"}),
    ("蹙眉", {"brow": "怒り"}),
    ("八字眉", {"brow": "困る"}),
    ("眉头耷拉", {"brow": "下"}),
    ("眉毛下垂", {"brow": "下"}),
    ("板着脸", {"brow": "真面目"}),

    # ---- 眼·开合 ----
    ("翻了个大白眼", {"eyeOpen": "ジト目"}),
    ("翻了个白眼", {"eyeOpen": "ジト目"}),
    ("翻白眼", {"eyeOpen": "ジト目"}),
    ("斜眼", {"eyeOpen": "ジト目"}),
    ("白眼", {"eyeOpen": "ジト目"}),
    ("瞪大了眼睛", {"eyeOpen": "びっくり"}),
    ("瞪大双眼", {"eyeOpen": "びっくり"}),
    ("瞪大眼睛", {"eyeOpen": "びっくり"}),
    ("睁大眼睛", {"eyeOpen": "びっくり"}),
    ("睁大眼", {"eyeOpen": "びっくり"}),
    ("瞪圆", {"eyeOpen": "びっくり"}),
    ("目瞪口呆", {"eyeOpen": "びっくり"}),
    ("眼睛一亮", {"eyeOpen": "喜び"}),
    ("眼睛发亮", {"eyeOpen": "喜び"}),
    ("两眼放光", {"eyeOpen": "喜び"}),
    ("眼睛笑成一条缝", {"eyeOpen": "笑い"}),
    ("笑眯了眼", {"eyeOpen": "笑い"}),
    ("眯着眼笑", {"eyeOpen": "笑い"}),
    ("弯起眼睛", {"eyeOpen": "笑い"}),
    ("慈眉善目", {"eyeOpen": "なごみ"}),
    ("闭目养神", {"eyeOpen": "なごみ"}),
    ("闭上了眼睛", {"eyeOpen": "まばたき"}),
    ("闭上眼睛", {"eyeOpen": "まばたき"}),
    ("闭上眼", {"eyeOpen": "まばたき"}),
    ("闭眼", {"eyeOpen": "まばたき"}),
    ("眨了眨眼", {"eyeOpen": "まばたき"}),
    ("眨眨眼", {"eyeOpen": "まばたき"}),
    ("眨眼", {"eyeOpen": "まばたき"}),
    ("右眼眨了眨", {"eyeOpen": "ウィンク右"}),
    ("右眼一眨", {"eyeOpen": "ウィンク右"}),
    ("抛媚眼", {"eyeOpen": "ウィンク"}),
    ("使眼色", {"eyeOpen": "ウィンク"}),
    ("眨一只眼", {"eyeOpen": "ウィンク"}),
    ("半睁着眼", {"eyeOpen": "じと目"}),
    ("眼皮半垂", {"eyeOpen": "じと目"}),
    ("半眯着眼", {"eyeOpen": "じと目"}),
    ("睡眼惺忪", {"eyeOpen": "じと目"}),
    ("眯起眼睛", {"eyeOpen": "じと目"}),
    ("怒视", {"eyeOpen": "怒り目"}),
    ("怒目", {"eyeOpen": "怒り目"}),
    ("瞪视", {"eyeOpen": "怒り目"}),
    ("瞪着他", {"eyeOpen": "怒り目"}),
    ("瞪着她", {"eyeOpen": "怒り目"}),
    # ---- 瞪大 / 圆睁（睁大 ≠ 眯着瞪，两者是不同态）----
    ("怒目圆睁", {"eyeOpen": "びっくり"}),
    ("圆睁双眼", {"eyeOpen": "びっくり"}),
    ("圆睁", {"eyeOpen": "びっくり"}),
    ("瞪圆双眼", {"eyeOpen": "びっくり"}),
    ("瞪圆眼睛", {"eyeOpen": "びっくり"}),
    ("瞪眼", {"eyeOpen": "びっくり"}),

    # ---- 眼·眼角 / 下眼皮 ----
    ("眼角上扬", {"eyeCorner": "眼角上"}),
    ("眼尾上扬", {"eyeCorner": "眼角上"}),
    ("眼角一翘", {"eyeCorner": "眼角上"}),
    ("眼角下垂", {"eyeCorner": "眼角下"}),
    ("眼尾下垂", {"eyeCorner": "眼角下"}),
    ("眼角耷拉", {"eyeCorner": "眼角下"}),
    ("下眼皮上眯", {"eyeUnder": "下眼上"}),

    # ---- 瞳孔 ----
    ("瞳孔一缩", {"pupil": "瞳小"}),
    ("瞳孔缩小", {"pupil": "瞳小"}),
    ("瞳孔骤缩", {"pupil": "瞳小"}),
    ("瞳仁一缩", {"pupil": "瞳小"}),
]

# ---- 口 / 复合神态（续）----
MOUTH_AND_COMPOUND_LEXICON: list[tuple[str, dict[str, str]]] = [
    ("咧开嘴笑", {"mouth": "口横広げ"}),
    ("咧嘴笑", {"mouth": "口横広げ"}),
    ("张大嘴笑", {"mouth": "口横広げ"}),
    ("嘴角外拉", {"mouth": "口横広げ"}),
    ("嘟着嘴", {"mouth": "口横狭め"}),
    ("嘟起嘴", {"mouth": "口横狭め"}),
    ("嘟嘴", {"mouth": "口横狭め"}),
    ("撅嘴", {"mouth": "口横狭め"}),
    ("鼓起腮帮", {"mouth": "ω"}),
    ("猫嘴", {"mouth": "ω"}),
    ("卖萌", {"mouth": "ω"}),
    ("龇着牙", {"mouth": "にやり３"}),
    ("龇牙", {"mouth": "にやり３"}),
    ("露出虎牙", {"mouth": "にやり３"}),
    ("左边嘴角上扬", {"mouth": "にやり２"}),
    ("左嘴角上扬", {"mouth": "にやり２"}),
    ("勾起嘴角", {"mouth": "にやり"}),
    ("嘴角一勾", {"mouth": "にやり"}),
    ("坏笑", {"mouth": "にやり"}),
    ("邪笑", {"mouth": "にやり"}),
    ("吐了吐舌头", {"mouth": "てへぺろ"}),
    ("舔了舔嘴唇", {"mouth": "てへぺろ"}),
    ("舔了舔嘴角", {"mouth": "てへぺろ"}),
    ("吐舌头", {"mouth": "ぺろっ"}),
    ("伸舌头", {"mouth": "ぺろっ"}),
    ("撇了撇嘴", {"mouth": "口角下げ"}),
    ("撇嘴", {"mouth": "口角下げ"}),
    ("嘴角下撇", {"mouth": "口角下げ"}),
    ("嘴角向下", {"mouth": "口角下げ"}),
    ("瘪嘴", {"mouth": "口角下げ"}),
    ("抿嘴", {"mouth": "口角下げ"}),
    ("嘴角上扬", {"mouth": "口角上げ"}),
    ("嘴角翘起", {"mouth": "口角上げ"}),
    ("扬起嘴角", {"mouth": "口角上げ"}),
    ("微微一笑", {"mouth": "口角上げ"}),
    ("抿嘴笑", {"mouth": "口角上げ"}),
    ("笑了笑", {"mouth": "口角上げ"}),
    ("笑了一下", {"mouth": "口角上げ"}),
    ("微笑", {"mouth": "口角上げ"}),
    # ---- 复合神态：多槽一起给，补配方表达不到的写法 ----
    ("苦笑", {"brow": "困る", "eyeOpen": "じと目", "mouth": "口角下げ"}),
    ("傻笑", {"brow": "にこり", "eyeOpen": "笑い", "mouth": "口横広げ"}),
    ("冷笑", {"brow": "怒り", "eyeOpen": "ジト目", "mouth": "にやり"}),
    ("嘲笑", {"brow": "怒り", "eyeOpen": "ジト目", "mouth": "にやり"}),
    ("大笑", {"brow": "にこり", "eyeOpen": "笑い", "mouth": "口横広げ"}),
    ("笑眯眯", {"brow": "にこり", "eyeOpen": "笑い",
                "eyeCorner": "眼角上", "mouth": "口角上げ"}),
    ("笑盈盈", {"brow": "にこり", "eyeOpen": "笑い", "mouth": "口角上げ"}),
    ("眉开眼笑", {"brow": "上", "eyeOpen": "笑い", "mouth": "口横広げ"}),
    ("生无可恋", {"brow": "下", "eyeOpen": "ジト目", "mouth": "口角下げ"}),
    ("一脸黑线", {"brow": "下", "eyeOpen": "ジト目", "mouth": "ω"}),
]
EXPRESSION_LEXICON.extend(MOUTH_AND_COMPOUND_LEXICON)

# ---- 口语变体补充（模板自检发现的缺口，长尾写法统一收在这里）----
LEXICON_EXTRA: list[tuple[str, dict[str, str]]] = [
    # 眉
    ("露出为难的神色", {"brow": "困る"}),
    ("为难地", {"brow": "困る"}),
    ("苦恼", {"brow": "困る"}),
    ("可怜巴巴", {"brow": "困る"}),
    ("温和", {"brow": "にこり"}),
    ("慈祥", {"brow": "にこり"}),
    ("欣慰", {"brow": "にこり"}),
    ("非常严肃", {"brow": "真面目"}),
    ("一脸严肃", {"brow": "真面目"}),
    ("表情很严肃", {"brow": "真面目"}),
    ("绷着脸", {"brow": "真面目"}),
    ("一脸认真", {"brow": "真面目"}),
    ("眉毛一挑", {"brow": "上"}),
    ("来了兴趣", {"brow": "上"}),
    ("耷拉着眉毛", {"brow": "下"}),
    ("垂头丧气", {"brow": "下"}),
    ("皱紧了眉头", {"brow": "前"}),
    ("皱紧眉头", {"brow": "前"}),
    # 眼·开合
    ("眨了下眼", {"eyeOpen": "まばたき"}),
    ("闭目", {"eyeOpen": "なごみ"}),
    ("和缓地闭眼", {"eyeOpen": "なごみ"}),
    ("使了个眼色", {"eyeOpen": "ウィンク"}),
    ("抛了个媚眼", {"eyeOpen": "ウィンク"}),
    ("眨了一只眼", {"eyeOpen": "ウィンク"}),
    ("眨了眨左眼", {"eyeOpen": "ウィンク"}),
    ("眨了左眼", {"eyeOpen": "ウィンク"}),
    ("闭上了左眼", {"eyeOpen": "なごみ左"}),
    ("左眼一闭", {"eyeOpen": "なごみ左"}),
    ("眨了眨右眼", {"eyeOpen": "ウィンク右"}),
    ("眨了右眼", {"eyeOpen": "ウィンク右"}),
    ("闭上了右眼", {"eyeOpen": "なごみ右"}),
    ("右眼一闭", {"eyeOpen": "なごみ右"}),
    ("半眯着", {"eyeOpen": "じと目"}),
    ("懒得睁眼", {"eyeOpen": "じと目"}),
    # 眼·眼角 / 下眼皮
    ("眼角微微上扬", {"eyeCorner": "眼角上"}),
    ("眼角微微下垂", {"eyeCorner": "眼角下"}),
    ("眼角垮下来", {"eyeCorner": "眼角下"}),
    ("下眼皮微微上眯", {"eyeUnder": "下眼上"}),
    ("眯起下眼皮", {"eyeUnder": "下眼上"}),
    ("卧蚕", {"eyeUnder": "下眼上"}),
    # 瞳孔
    ("瞳孔猛地一缩", {"pupil": "瞳小"}),
    ("瞳孔缩", {"pupil": "瞳小"}),
    # 口
    ("左边嘴角微微一挑", {"mouth": "にやり２"}),
    ("左边嘴角勾起", {"mouth": "にやり２"}),
    ("左嘴角一挑", {"mouth": "にやり２"}),
    ("吐着舌头", {"mouth": "てへぺろ"}),
    ("吐了下舌头", {"mouth": "ぺろっ"}),
    ("舌头伸出来", {"mouth": "ぺろっ"}),
    ("嘴角微微上扬", {"mouth": "口角上げ"}),
    ("嘴角往下一撇", {"mouth": "口角下げ"}),
    ("嘴角下垂", {"mouth": "口角下げ"}),
    ("瘪着嘴", {"mouth": "口角下げ"}),
    ("撅着嘴", {"mouth": "口横狭め"}),
]
EXPRESSION_LEXICON.extend(LEXICON_EXTRA)

# 情绪词 -> 配方 key（优先级低于表情词：先铺配方，再用表情词覆盖单槽）
EMOTION_WORDS: dict[str, list[str]] = {
    "happy": ["开心", "高兴", "快乐", "愉快", "兴奋", "喜悦", "欢喜", "乐呵呵",
              "美滋滋", "兴高采烈", "得意", "骄傲", "兴致勃勃", "兴冲冲"],
    "excited": ["激动", "雀跃", "手舞足蹈", "喜出望外", "乐不可支"],
    "angry": ["生气", "愤怒", "恼怒", "气愤", "恼火", "火大", "暴躁", "不耐烦",
              "不满", "愤愤", "怒气", "恼羞成怒", "怒不可遏", "骂骂咧咧", "抱怨",
              "不爽", "凶巴巴"],
    "sad": ["难过", "伤心", "悲伤", "失落", "沮丧", "低落", "忧郁", "委屈",
            "痛苦", "悲痛", "消沉", "无精打采", "蔫了", "垂头丧气", "唉声叹气",
            "闷闷不乐", "哽咽", "抽泣", "想哭"],
    "surprised": ["惊讶", "吃惊", "震惊", "意外", "诧异", "惊奇", "错愕",
                  "吓了一跳", "惊慌", "慌张", "傻眼", "大惊", "瞠目结舌"],
    "shy": ["害羞", "羞涩", "腼腆", "不好意思", "脸红", "害臊", "羞怯", "娇羞",
            "扭扭捏捏", "羞答答", "难为情"],
    "neutral": ["平静", "淡定", "冷静", "淡淡地", "淡然", "从容", "面无表情",
                "无所谓", "平淡", "若无其事"],
    "speechless": ["无语", "嫌弃", "鄙视", "无奈", "汗颜", "扶额", "心累"],
    "proud": ["自豪", "得意洋洋", "神气", "得瑟"],
    "puzzled": ["疑惑", "困惑", "不解", "纳闷", "茫然", "懵了"],
    "disgusted": ["厌恶", "恶心", "反感", "作呕"],
    "wronged": ["委屈巴巴", "受了委屈", "可怜巴巴"],
    "nervous": ["紧张", "局促", "不安", "拘谨", "忐忑"],
    "tender": ["温柔", "宠溺", "慈爱", "柔和", "关切", "心疼"],
}

# 强度修饰（与 emotion_parser 一致，补「夸张/使劲/用力/狠狠」）
STRONG_WORDS = ["非常", "特别", "超级", "极其", "十分", "很", "太", "极",
                "极为", "极度", "夸张", "使劲", "用力", "狠狠"]
WEAK_WORDS = ["有点", "有些", "稍微", "稍稍", "略微", "一点", "微微", "略有",
              "浅浅", "轻轻"]

# 明确「不要表情」的词：命中别的表情也压成中立
NEUTRAL_OVERRIDE = ["面无表情", "毫无表情", "面瘫"]

# ---------------------------------------------------------------- 工具函数

_PHRASE_MAP: dict[str, dict[str, str]] = {p: m for p, m in EXPRESSION_LEXICON}
_EMO_WORD_MAP: dict[str, str] = {w: e for e, ws in EMOTION_WORDS.items() for w in ws}


def slot_of(atom: str) -> str | None:
    return ATOM_SLOT.get(atom)


def morph_name_ok(name: str, limit: int = 15) -> tuple[bool, str]:
    """morph 名能否写进 VMD（Shift-JIS ≤15 字节）。"""
    try:
        raw = name.encode("shift_jis")
    except UnicodeEncodeError as exc:  # noqa: PERF203
        return False, f"无法编码为 Shift-JIS: {exc}"
    if len(raw) > limit:
        return False, f"超过 {limit} 字节（{len(raw)}）"
    return True, ""


def intensity_class(value: float) -> float:
    """把任意强度吸附到三档。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 1.0
    return min(INTENSITY_CLASSES, key=lambda c: abs(c - v))


def clamp_hold(hold: int) -> int:
    """把 hold 收紧到 [HOLD_RANGE]（1..60 帧）。"""
    lo, hi = HOLD_RANGE
    try:
        v = int(hold)
    except (TypeError, ValueError):
        v = DEFAULT_TIMING[1]
    return max(lo, min(hi, v))


def morph_timing(atom: str) -> tuple[int, int, int]:
    """morph -> (attack, hold, release)；未定义的 atom 走 DEFAULT_TIMING。"""
    return MORPH_TIMING.get(atom, DEFAULT_TIMING)


# 显式重复词 -> (重复次数, 间隔帧)。**只有明确说「眨两下/连眨」才重复**，
# 其余一律单次（需求：默认不重复，由语义决定）。
REPEAT_RULES: tuple[tuple["re.Pattern[str]", int, int], ...] = ()


def _init_repeat_rules() -> None:
    global REPEAT_RULES
    if REPEAT_RULES:
        return
    import re
    REPEAT_RULES = (
        (re.compile(r"眨[了]?(?:两|2)下"), 2, 3),
        (re.compile(r"眨[了]?三下"), 3, 2),
        (re.compile(r"连眨|连着眨"), 2, 3),
        (re.compile(r"眨眨眼|眨了眨眼|眨巴眨巴"), 2, 3),
        (re.compile(r"挑了?两下眉"), 2, 4),
        (re.compile(r"连抛.{0,2}媚眼"), 2, 5),
    )


def detect_repeat(text: str) -> tuple[int, int]:
    """文本 -> (重复次数, 间隔帧)；无显式重复词返回 (1, 0)。"""
    _init_repeat_rules()
    for pat, times, gap in REPEAT_RULES:
        if pat.search(text or ""):
            return times, gap
    return 1, 0


def atom_to_state(atom: str) -> str | None:
    """morph 名 -> 语义态（不在标签空间内返回 None）。"""
    return MORPH_TO_STATE.get(atom)


def states_from_atoms(atoms: list[str]) -> list[str]:
    """morph 原子列表 -> 语义态列表（按槽序、去重、保留先出现者）。"""
    used: dict[str, str] = {}
    for a in atoms or []:
        st = MORPH_TO_STATE.get(a)
        if st is None or STATE_SLOT[st] in used:
            continue
        used[STATE_SLOT[st]] = st
    return [used[s] for s in SLOTS if s in used]


def label_text_states(text: str) -> dict:
    """规则打标 + 投影到语义态空间（训练语料用，与 `label_text` 同源）。"""
    r = label_text(text)
    return {"states": states_from_atoms(r["atoms"]),
            "intensity": r["intensity"], "source": r["source"]}


def _find_words(text: str, words: list[str]) -> list[tuple[int, int, str]]:
    """候选匹配 + 占位去重，返回 [(start, end, word)]（按位置排序）。

    选取规则（重要，实测得出）：
      1. **起点靠前优先**：「坏笑了一下」里 `坏笑`(0) 要赢过 `笑了一下`(1)，
         否则只拿到「嘴角上抬」，丢掉「坏笑」语义；
      2. 起点相同则**长词优先**：「笑了笑」赢过 `笑`；
      3. 已占位的字符不再复用（不重叠）。
    """
    cands: list[tuple[int, int, str]] = []
    for w in set(words):
        if not w:
            continue
        start = 0
        while True:
            idx = text.find(w, start)
            if idx < 0:
                break
            cands.append((idx, idx + len(w), w))
            start = idx + 1
    cands.sort(key=lambda c: (c[0], -(c[1] - c[0])))

    taken = [False] * len(text)
    hits: list[tuple[int, int, str]] = []
    for a, b, w in cands:
        if any(taken[a:b]):
            continue
        for k in range(a, b):
            taken[k] = True
        hits.append((a, b, w))
    hits.sort()
    return hits


def label_text(text: str) -> dict:
    """中文描述 -> {atoms, intensity, source}（语料生成 / 规则兜底共用）。

    优先级：情绪配方打底 → 表情词逐槽覆盖（显式写法优先）→ 中立词清空。
    返回的 atoms 已满足「槽内互斥」（每槽最多 1 个）。
    """
    s = (text or "").strip()
    if not s:
        return {"atoms": [], "intensity": 1.0, "source": "empty"}

    slots: dict[str, str] = {}
    source = "none"
    anchors: list[str] = []

    # ① 情绪词 -> 配方（长词优先，取第一个命中的情绪）
    emo_hits = _find_words(s, list(_EMO_WORD_MAP))
    if emo_hits:
        first = emo_hits[0][2]
        emo = _EMO_WORD_MAP[first]
        slots.update(EMOTION_RECIPES.get(emo, {}))
        source = f"emotion:{emo}"
        anchors.append(first)

    # ② 表情词覆盖（显式描述优先于情绪配方）
    exp_hits = _find_words(s, list(_PHRASE_MAP))
    if exp_hits:
        for _a, _b, phrase in exp_hits:
            slots.update(_PHRASE_MAP[phrase])
            anchors.append(phrase)
        if source == "none":
            source = "expression"

    # ③ 中立覆盖（「面无表情」等）
    if any(w in s for w in NEUTRAL_OVERRIDE):
        slots.clear()
        source = "neutral_override"

    # ④ 强度：取第一个锚点前 6 字窗口里的修饰词
    intensity = 1.0
    window = ""
    if anchors:
        positions = [p for p in (s.find(a) for a in anchors) if p >= 0]
        if positions:
            window = s[max(0, min(positions) - 6): min(positions)]
    if any(w in window for w in STRONG_WORDS):
        intensity = 1.5
    elif any(w in window for w in WEAK_WORDS):
        intensity = 0.5

    # ⑤ 组内互斥：每槽只保留 1 个（dict 覆盖天然满足），按槽序输出
    atoms = [slots[slot] for slot in SLOTS if slot in slots]
    return {"atoms": atoms, "intensity": intensity_class(intensity),
            "source": source}

def validate_schema() -> list[str]:
    """自检：返回问题列表（空 = 通过）。"""
    errs: list[str] = []
    if len(set(LABELS)) != len(LABELS):
        errs.append("LABELS 有重复")
    if len(ATOMS) != 35:
        errs.append(f"原子数应为 35，实际 {len(ATOMS)}")
    if len(SLOT_STATES["eyeOpen"]) != 10:
        errs.append("eyeOpen 应有 10 个语义态")
    for name in ATOMS:
        ok, why = morph_name_ok(name)
        if not ok:
            errs.append(f"morph 名不可写 VMD: {name} ({why})")
    for slot, atoms in EXCLUSIVE_GROUPS.items():
        if not atoms:
            errs.append(f"{slot} 没有原子")
        if len(set(atoms)) != len(atoms):
            errs.append(f"{slot} 原子重复")
    for recipe in EMOTION_RECIPES.values():
        for slot, atom in recipe.items():
            if atom not in ATOM_SLOT:
                errs.append(f"配方引用未知原子 {slot}={atom}")
            elif ATOM_SLOT[atom] != slot:
                errs.append(f"配方槽不符 {slot}->{atom}")
    phrases = [p for p, _m in EXPRESSION_LEXICON]
    if len(set(phrases)) != len(phrases):
        errs.append("词表有重复短语")
    for phrase, mapping in EXPRESSION_LEXICON:
        if not phrase:
            errs.append("词表有空短语")
        for slot, atom in mapping.items():
            if atom not in ATOM_SLOT:
                errs.append(f"词表引用未知原子 {phrase}: {slot}={atom}")
            elif ATOM_SLOT[atom] != slot:
                errs.append(f"词表槽不符 {phrase}: {slot}->{atom}")

    # ---- state 标签空间（P2）----
    if len(STATE_LABELS) != 30:
        errs.append(f"语义态标签应为 30，实际 {len(STATE_LABELS)}")
    if len(set(STATE_LABELS)) != len(STATE_LABELS):
        errs.append("STATE_LABELS 有重复")
    if "睁" in STATE_LABELS:
        errs.append("「睁」不应作为训练标签（默认态 = 该槽留空）")
    if len(EYE_STATES) != 9:
        errs.append(f"EYE_STATES 应为 9，实际 {len(EYE_STATES)}")
    for st in STATE_LABELS:
        slot = STATE_SLOT.get(st)
        if slot not in SLOTS:
            errs.append(f"语义态槽不符: {st}")
        elif st not in SLOT_STATES_ORDERED[slot]:
            errs.append(f"语义态不在所属槽: {st}")
        if not STATE_TO_MORPH.get(st):
            errs.append(f"语义态没有首选 morph: {st}")
        elif ATOM_SLOT.get(STATE_TO_MORPH[st][0]) != slot:
            errs.append(f"语义态首选 morph 槽不符: {st} -> {STATE_TO_MORPH[st][0]}")
    for atom in ATOMS:                      # morph 必须能映射到某个态
        if atom not in MORPH_TO_STATE:
            errs.append(f"morph 缺语义态映射: {atom}")

    # ---- morph 生命周期（每个可预测原子都必须有定义）----
    lo, hi = HOLD_RANGE
    for atom in ATOMS:
        t = MORPH_TIMING.get(atom)
        if t is None:
            errs.append(f"morph 缺生命周期定义: {atom}")
            continue
        a, h, r = t
        if a < 1 or r < 1:
            errs.append(f"morph attack/release 必须 ≥1: {atom}={t}")
        if not (lo <= h <= hi):
            errs.append(f"morph hold 应在 {lo}..{hi} 帧: {atom}={t}")
    for atom in MORPH_TIMING:
        if atom not in ATOM_SLOT:
            errs.append(f"生命周期表含未知 morph: {atom}")
    if lo >= hi:
        errs.append(f"HOLD_RANGE 非法: {HOLD_RANGE}")
    return errs


def dump_atoms(path: Path = ATOMS_PATH) -> Path:
    """产出 data/expression_atoms.json（文档 / 调试用）。"""
    payload = {
        "version": 1,
        "fps": FPS,
        "neutral": NEUTRAL,
        "slots": list(SLOTS),
        "eye_batch": list(EYE_BATCH),
        "label_space": "atom|state",
        "atom_labels": ATOMS,
        "state_labels": STATE_LABELS,
        "eye_states": list(EYE_STATES),
        "slot_states": SLOT_STATES,
        "slot_atoms": SLOT_ATOMS,
        "state_to_morph": STATE_TO_MORPH,
        "morph_to_state": MORPH_TO_STATE,
        "slot_weight": SLOT_WEIGHT,
        "morph_timing": {k: list(v) for k, v in MORPH_TIMING.items()},
        "hold_range": list(HOLD_RANGE),
        "intensity_classes": INTENSITY_CLASSES,
        "transition": {"out": TRANSITION_OUT, "in": TRANSITION_IN},
        "min_segment_frames": MIN_SEGMENT_FRAMES,
        "emotion_recipes": EMOTION_RECIPES,
        "lexicon_size": len(EXPRESSION_LEXICON),
        "emotion_words": EMOTION_WORDS,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    return path


if __name__ == "__main__":
    errs = validate_schema()
    print(f"槽: {len(SLOTS)}  原子: {len(ATOMS)}  标签: {len(LABELS)}"
          f"（含 {NEUTRAL}）")
    for slot in SLOTS:
        print(f"  {slot:9s} {len(SLOT_ATOMS[slot]):2d}  "
              f"{' / '.join(SLOT_ATOMS[slot])}")
    print(f"词表: {len(EXPRESSION_LEXICON)} 条  情绪: {len(EMOTION_WORDS)} 类")
    if errs:
        print("\n✗ schema 自检失败:")
        for e in errs:
            print("  -", e)
        sys.exit(1)
    out = dump_atoms()
    print(f"\n✓ schema 自检通过 → {out.relative_to(ROOT)}")
