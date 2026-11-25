"""情绪 -> morph 表情曲线生成器。

纯程序化生成，不依赖训练数据。输出 morph 关键帧序列，可直接写入
VMD 的 morph 段（与骨骼帧共存于同一个文件）。

设计:
  - 情绪 = 若干标准 MMD 表情 morph 的目标权重组合（原语）
  - 时间结构 = attack / hold / release 三段 easing 包络
  - hold 段叠加低频「呼吸」起伏，避免表情僵死
  - 自主眨眼独立叠加（任何情绪下都存在）
  - 所有输出权重 clamp 到 [0, 1]

morph 命名取自 Tda/式系等常见模型的表情名。模型里不存在的 morph
会被 MMD 忽略（可能弹一次「モーフが見つかりません」提示，属正常）。
"""
from __future__ import annotations

import math
import random
import sys
from pathlib import Path

# 表情生命周期（`MORPH_TIMING`）的真源在 `app/expressiongen/tools/`。
# 这里**只读取**常量、不做任何写操作；拿不到就回退旧的「按总长比例」包络，
# 保证 motiongen 可以单独运行（不硬依赖 expressiongen）。
_EXPR_TOOLS = Path(__file__).resolve().parents[2] / "expressiongen" / "tools"
if _EXPR_TOOLS.is_dir() and str(_EXPR_TOOLS) not in sys.path:
    sys.path.insert(0, str(_EXPR_TOOLS))

try:                                    # 独立使用（无 schema）时回退旧行为
    import expression_schema as es
except Exception:                       # noqa: BLE001
    es = None

FPS = 30

# ---------------------------------------------------------------- 情绪原语库
# 每个情绪: morph 名 -> 稳态目标权重（0~1）
#
# 命名原则（重要）：只使用「5 个内置模型全部存在」的 morph，
# 否则权重会被写到不存在的 morph 上并被静默忽略 —— 看起来就是
# 「动作生成了但表情没同步」。
#
# 已核实 5 个模型（youla/paimeng/shatang/xianglin/zaoyou）共同拥有的表情：
#   まばたき / 笑い / 怒り / 困る / びっくり / 口角上げ / 涙 / じと目 / あ
# 各模型独有或缺失的（にっこり/照れ/頬染め/眉下げ/睨み/目上/口角下げ）
# 一律走 MORPH_ALIASES 降级，不直接写进 presets。
EMOTION_PRESETS: dict[str, dict[str, float]] = {
    "neutral": {},
    "happy": {
        "笑い": 0.85,
        "口角上げ": 0.55,
    },
    "angry": {
        "怒り": 0.90,
        "じと目": 0.35,
    },
    "sad": {
        "困る": 0.80,
        "涙": 0.30,
        "じと目": 0.20,
    },
    "surprised": {
        "びっくり": 0.85,
        "あ": 0.50,
    },
    "shy": {
        "笑い": 0.45,
        "じと目": 0.30,
        "照れ": 0.60,      # 仅部分模型有；没有则走别名 -> 笑い
    },
}

BLINK_MORPH = "まばたき"

# ---------------------------------------------------------------- morph 别名
# 不同作者模型的命名不一致。不做别名时，权重会被写到模型里不存在的
# morph 上，MMD / three.js 会静默忽略，表现就是「表情没生效」。
MORPH_ALIASES: dict[str, tuple[str, ...]] = {
    "にっこり": ("笑い", "笑顔"),
    "頬染め": ("照れ",),
    "目上": ("びっくり",),
    "睨み": ("じと目", "怒り"),
    "眉下げ": ("怒り",),
    "口角下げ": (),
}


def _apply_aliases(targets: dict[str, float],
                   available: set[str] | None = None) -> dict[str, float]:
    """把模型里不存在的 morph 名映射到更常见的等价名。

    available 为模型实际拥有的 morph 名集合：
      - None   ：无模型信息，原样输出（可能被模型静默忽略，属兜底）
      - 非空集合：名字存在则保留；不存在则按 MORPH_ALIASES 找等价名；
                  等价名也没有则丢弃，绝不写入模型不存在的表情名
    """
    out: dict[str, float] = {}
    for name, w in targets.items():
        if available is None or name in available:
            out[name] = max(out.get(name, 0.0), w)
            continue
        for alias in MORPH_ALIASES.get(name, ()):
            if available is None or alias in available:
                out[alias] = min(1.0, out.get(alias, 0.0) + w)
                break
    return {k: _clamp01(v) for k, v in out.items() if v > 1e-4}


def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def _ease_in_out(t: float) -> float:
    """smoothstep，两端导数为 0，起落不生硬。"""
    t = _clamp01(t)
    return t * t * (3.0 - 2.0 * t)


def list_emotions() -> list[str]:
    return list(EMOTION_PRESETS.keys())


# ---------------------------------------------------------------- 目标权重

def morph_targets(emotion: str, intensity: float = 1.0) -> dict[str, float]:
    """情绪名 -> {morph: 稳态权重}。"""
    if emotion not in EMOTION_PRESETS:
        raise KeyError(f"未知情绪: {emotion!r}，可选 {list_emotions()}")
    out = {}
    for name, w in EMOTION_PRESETS[emotion].items():
        v = _clamp01(w * intensity)
        if v > 1e-4:
            out[name] = v
    return out


def morph_targets_mixed(mix: dict[str, float]) -> dict[str, float]:
    """情绪混合: {情绪名: 权重} -> 线性混合后的目标权重。

    例: {"happy": 0.7, "shy": 0.3} 得到介于两者之间的表情。
    """
    total = sum(max(0.0, v) for v in mix.values())
    if total <= 0.0:
        return {}
    acc: dict[str, float] = {}
    for emo, w in mix.items():
        share = max(0.0, w) / total
        for name, target in morph_targets(emo, 1.0).items():
            acc[name] = acc.get(name, 0.0) + target * share
    return {k: _clamp01(v) for k, v in acc.items() if v > 1e-4}


# ---------------------------------------------------------------- 曲线生成

def _envelope_keys(a: int, h: int, r: int, peak: float,
                   breathing: float, idx: int, step: int
                   ) -> list[tuple[int, float]]:
    """attack/hold/release -> 稀疏关键帧（hold 段带低频呼吸，避免僵死）。"""
    keys: list[tuple[int, float]] = [(0, 0.0)]
    phase = idx * 1.7
    n_atk = max(1, a // 2)
    for i in range(1, n_atk + 1):
        u = i / float(n_atk)
        keys.append((int(round(u * a)), _clamp01(peak * _ease_in_out(u))))
    n_hold = max(1, h // max(1, step))
    for i in range(n_hold + 1):
        u = i / float(n_hold)
        f = a + int(round(u * h))
        w = peak * (1.0 + breathing * math.sin(phase + 6.283 * 1.5 * u))
        keys.append((f, _clamp01(w)))
    n_rel = max(1, r // 2)
    for i in range(1, n_rel + 1):
        u = i / float(n_rel)
        keys.append((a + h + int(round(u * r)),
                     _clamp01(peak * (1.0 - _ease_in_out(u)))))
    merged: dict[int, float] = {}
    for f, w in keys:
        merged[int(f)] = float(w)
    return [(f, merged[f]) for f in sorted(merged)]


def emotion_tracks(
    targets: dict[str, float],
    duration_frames: int,
    attack_ratio: float = 0.18,
    release_ratio: float = 0.25,
    breathing: float = 0.04,
    step: int = 2,
    use_timing: bool = True,
) -> dict[str, list[tuple[int, float]]]:
    """目标权重 -> 每个 morph **独立生命周期**的关键帧（到点即归零）。

    `use_timing=True`（默认）：按 `expression_schema.MORPH_TIMING` 的
    (attack, hold, release) 生成曲线，**时长与 `duration_frames` 无关**
    （只在该值过短时压缩）；这正是「笑 1.6s 后归零」而不是「笑满整段」。

    `use_timing=False`：旧的「按总长比例」行为（仅供对照）。
    """
    if duration_frames <= 1 or not targets:
        return {}

    total = int(duration_frames)
    tracks: dict[str, list[tuple[int, float]]] = {}
    for idx, name in enumerate(sorted(targets)):
        peak = _clamp01(targets[name])
        if use_timing and es is not None:
            a, h, r = es.morph_timing(name)
            if a + h + r > total:       # 段太短 -> 等比压进总长
                s = total / float(a + h + r)
                a = max(1, int(round(a * s)))
                h = max(1, int(round(h * s)))
                r = max(1, int(round(r * s)))
        else:
            dur = float(total - 1)
            a = max(1, int(round(dur * attack_ratio)))
            r = max(1, int(round(dur * release_ratio)))
            h = max(1, int(round(dur)) - a - r)
        tracks[name] = _envelope_keys(a, h, r, peak, breathing, idx, step)
    return tracks


def blink_track(
    duration_frames: int,
    rng: random.Random | None = None,
    interval: int = 55,
    jitter: int = 18,
    close: int = 2,
    hold: int = 1,
    reopen: int = 5,
    name: str = BLINK_MORPH,
) -> dict[str, list[tuple[int, float]]]:
    """自主眨眼：0 -> 1 闭眼 -> 保持 -> 0 睁开，间隔随机。"""
    rng = rng or random.Random()
    keys: list[tuple[int, float]] = []
    f = rng.randint(5, 20)
    while True:
        end = f + close + hold + reopen
        if end > duration_frames:
            break
        keys.append((f, 0.0))
        keys.append((f + close, 1.0))
        keys.append((f + close + hold, 1.0))
        keys.append((end, 0.0))
        f = end + max(18, rng.randint(interval - jitter, interval + jitter))
    if not keys:
        return {}
    return {name: keys}


def generate(
    emotion: str = "happy",
    duration_frames: int = 150,
    intensity: float = 1.0,
    blink: bool = True,
    seed: int | None = None,
    mix: dict[str, float] | None = None,
    available: set[str] | None = None,
    **envelope,
) -> dict[str, list[tuple[int, float]]]:
    """生成一段情绪的 morph 关键帧。

    返回 {morph名: [(frame, weight), ...]}，可直接喂给 vmd_export.write_vmd。

    available: 可选，模型实际拥有的 morph 名集合。给出后会做别名映射/丢弃，
               避免把权重写到模型里不存在的表情名上（否则静默失效）。
    """
    rng = random.Random(seed)
    targets = morph_targets_mixed(mix) if mix else morph_targets(emotion, intensity)
    targets = _apply_aliases(targets, available)
    tracks = emotion_tracks(targets, duration_frames, **envelope)
    if blink:
        for k, v in blink_track(duration_frames, rng).items():
            tracks.setdefault(k, []).extend(v)
    for keys in tracks.values():
        keys.sort()
    return tracks


def offset_tracks(tracks: dict[str, list[tuple[int, float]]], offset: int):
    """整体平移到后面，便于拼接多段表情。"""
    return {k: [(f + offset, w) for f, w in keys] for k, keys in tracks.items()}


def to_morph_records(tracks: dict[str, list[tuple[int, float]]]) -> list:
    """展开成 write_vmd 需要的 (name, frame, weight) 列表。"""
    recs = []
    for name, keys in tracks.items():
        for f, w in keys:
            recs.append((name, int(f), float(w)))
    return recs