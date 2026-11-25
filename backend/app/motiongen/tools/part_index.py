"""部位索引：为每个动作变体算出「只驱动哪些关节」以及「哪段帧是核心」。

产出 data/part_index.json：
    actions[key] = {
      "aid", "frames",
      "core": {"start", "end"},
      "keep_parts": ["arm_r", ...],
      "loop_gap_deg": float,
      "parts": {"arm_r": {"peak", "share", "active", "keep", "loop_gap_deg"}, ...}
    }

判定规则（全库实测）
    keep = (peak >= 25 deg) and (share >= 0.10)
    再叠加 FORCE_KEEP_PARTS 白名单（走/跑/踮脚类必须保留腿）

用法
    .venv/bin/python tools/part_index.py
    .venv/bin/python tools/part_index.py --keep-peak 20 --keep-share 0.08
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KF_DIR = DATA / "keyframes"
OUT_JSON = DATA / "part_index.json"
OUT_MD = DATA / "part_report.md"

sys.path.insert(0, str(Path(__file__).parent))

import dense_ops as dop  # noqa: E402

# 7 个部位的骨骼表。手指整体归入对应手臂。
#
# ★ root 是"根通道"：center 负责全身位移/重心起伏，foot_ik_* 负责 IK 约束。
#   这三根骨骼如果**不被任何 mask 覆盖**，并行渲染时会被 PartTracks 跳过，
#   永远冻结在 base 首帧 —— 结果就是"腿在原地摆、身体不前进"的滑步，
#   以及脚部 IK 失效导致的穿模。这是 M13 修复的核心。
#
#   骨架共 53 根：19+19+3+3+4+2 = 50，正好缺 center(0)/foot_ik_r(26)/foot_ik_l(49)。
PARTS = {
    "arm_r": ["shoulder_r", "upper_arm_r", "lower_arm_r", "hand_r",
              "index_1_r", "index_2_r", "index_3_r",
              "middle_1_r", "middle_2_r", "middle_3_r",
              "ring_1_r", "ring_2_r", "ring_3_r",
              "little_1_r", "little_2_r", "little_3_r",
              "thumb_0_r", "thumb_1_r", "thumb_2_r"],
    "arm_l": ["shoulder_l", "upper_arm_l", "lower_arm_l", "hand_l",
              "index_1_l", "index_2_l", "index_3_l",
              "middle_1_l", "middle_2_l", "middle_3_l",
              "ring_1_l", "ring_2_l", "ring_3_l",
              "little_1_l", "little_2_l", "little_3_l",
              "thumb_0_l", "thumb_1_l", "thumb_2_l"],
    "leg_r": ["upper_leg_r", "lower_leg_r", "foot_r"],
    "leg_l": ["upper_leg_l", "lower_leg_l", "foot_l"],
    "torso": ["upper_body", "upper_body_2", "upper_body_3", "waist"],
    "head": ["head", "neck"],
    # 根通道：位移 + IK。并行时**全局独占**，同一时刻只能被一条轨道驱动。
    "root": ["center", "foot_ik_r", "foot_ik_l"],
}

# 全局独占部位：任何两条轨道同时覆盖这些 mask 都必须串行
EXCLUSIVE_PARTS = ("root",)

# 统计 peak/share 用的代表骨（不含手指，避免静息弯曲污染占比）
PART_PROBE = {
    "arm_r": ["shoulder_r", "upper_arm_r", "lower_arm_r", "hand_r"],
    "arm_l": ["shoulder_l", "upper_arm_l", "lower_arm_l", "hand_l"],
    "leg_r": ["upper_leg_r", "lower_leg_r", "foot_r"],
    "leg_l": ["upper_leg_l", "lower_leg_l", "foot_l"],
    "torso": ["upper_body", "upper_body_2", "upper_body_3", "waist"],
    "head": ["head", "neck"],
    # root 不做 peak 统计：center 的位移在 pos 通道，不在 rot 里
    "root": [],
}

FORCE_KEEP_PARTS = {
    "G0-08a": ["leg_l", "leg_r"], "G13-01a": ["leg_l", "leg_r"],
    "G13-02a": ["leg_l", "leg_r"], "G13-03a": ["leg_l", "leg_r"],
    "G13-04a": ["leg_l", "leg_r"], "G13-06a": ["leg_l", "leg_r"],
    "G13-08a": ["leg_l", "leg_r"], "G11-12a": ["leg_l", "leg_r"],
}

# 语义主导部位白名单：覆盖纯几何判定会出错的动作。
#
# 为什么需要
#   鞠躬（G5-01a）实测 arm_l:304° / torso:146° —— 手臂幅度反而更大，
#   因为鞠躬时手臂自然下垂摆动。纯几何判 dominant=arm_l 是错的，
#   语义上它应该驱动 torso，否则「一边招手一边鞠躬」会因抢 arm_l 而串行。
#
# 判定原则：动作的**语义主体**是哪个部位，而不是哪个部位幅度最大。
#
# ★ 本表在**运行时**生效（compose_decider / part_tracks 直接读它覆盖索引里的
#   dominant），因此改这里不需要重建 data/part_index.json。
FORCE_DOMINANT: dict[str, str] = {
    # G5 鞠躬/行礼类 → 躯干
    "G5-01a": "torso", "G5-02a": "torso", "G5-03a": "torso",
    "G5-04a": "torso", "G5-05a": "torso",
    # G5-07a 原地踏步：ik_activity=5.82（全库最高），语义主体是腿不是躯干。
    # 之前误标 torso 导致「一边走路一边挥手」被它抢掉 torso 通道，
    # 且并行渲染时只剩躯干在扭（双腿 0°）。
    "G5-07a": "leg_r",
    "G5-08a": "torso", "G5-09a": "torso", "G5-10a": "torso",
    "G5-12a": "torso", "G5-13a": "torso",
    # G13 走/跑/跳类 → 腿
    "G13-01a": "leg_r", "G13-02a": "leg_r", "G13-03a": "leg_r",
    "G13-04a": "leg_r", "G13-06a": "leg_r", "G13-08a": "leg_r",
    # G0 待机类多为呼吸/重心 → 躯干（避免占用手臂导致组合永远冲突）
    "G0-01a": "torso", "G0-02a": "torso", "G0-03a": "torso",
    "G0-09a": "torso", "G0-13a": "torso",
    # 头部语义明确的
    "G0-04a": "head", "G0-19a": "head",
}

CROP_FRAC = 0.30
CROP_PAD = 2
CROP_RISK_DEG = 12.0
CROP_MAX_RATIO = 0.40

# 全局污染度阈值：其他部位峰值 / 主导部位峰值 > 此值 → "手臂/腿在跟着晃"。
# 仅作诊断，**不用于判定能否并行**（鞠躬 2.08 但脚不动，可以并行）。
GLOBAL_SCORE_THRESHOLD = 0.6

# foot_ik 位移阈值：超过即判定"脚步在移动"（=移动类动作）。
# 实测：走路 3.43 / 4.45 / 4.08 · 鞠躬 0.16 · 招手 0.01
# 取 1.0 留足余量（跛步/小跳也能覆盖，正常站立完全排除）。
IK_LOCOMOTION_THRESHOLD = 1.0

# 白名单：几何判据漏掉的移动类动作
LOCOMOTION_ACTIONS = {
    "G13-01a", "G13-02a", "G13-03a", "G13-04a",
    "G13-06a", "G13-08a",
    "G0-08a",                    # 踮脚/原地小步
    "G11-12a",                   # 踏步
}

# ---------------------------------------------------------------------------
# 运行时派生（不重建 part_index.json 也能生效）
# ---------------------------------------------------------------------------
#
# 为什么需要 render_parts
#   索引里的 `dominant` 是**单侧**字段（leg_r / arm_r / torso ...），
#   它的用途是「判冲突」——两个动作抢同一部位就必须串行。
#   但如果**拿它当渲染 mask**，动作会被削成残废（实测）：
#
#     G13-01a（原地走）  part=leg_r  → upper_leg_l 0.0°  右腿 51.4°  ← 只有一条腿在动
#     G5-07a （原地踏步）part=torso  → 双腿 0.0°          ← 变成"原地扭身"
#
#   所以渲染范围必须单独给：步态类要带上**两条腿**（外加 root 的输入），
#   手臂类只驱动惯用手（dominant 那侧），躯干/头部按 dominant 即可。
#
# 优先级：显式 render_parts > keep_parts 裁剪 > dominant

# 步态类：必须双腿（+root，由 part_tracks 按 ik_activity 自动附加）
_GAIT_PREFIXES = ("G13",)          # 走/跑/侧步/后退/踮脚走
_GAIT_EXPLICIT = {
    "G5-07a",                      # 原地踏步（ik_activity 5.82，全库最高）
    "G0-08a",                      # 踮脚尖
    "G11-12a",                     # 听话点头蹲下（带踏步）
    "G7-02a",                      # 生气跺脚
    "G13-08a",                     # 弓步蹲
}


def is_gait_action(aid: str, info: dict | None = None) -> bool:
    """是否"双腿交替"的步态类动作（渲染时必须给两条腿）。"""
    if not aid:
        return False
    if aid in _GAIT_EXPLICIT:
        return True
    if any(aid.startswith(p) for p in _GAIT_PREFIXES):
        return True
    # 索引兜底：foot_ik 位移大 且 主导部位是腿
    if info:
        if (info.get("dominant") or "").startswith("leg_") and \
                float(info.get("ik_activity") or 0.0) >= 2.0:
            return True
    return False


def derive_render_parts(aid: str, info: dict | None = None,
                        keep_parts: list[str] | None = None) -> list[str]:
    """该动作在**并行混合**时应该驱动哪些部位。

    与 `dominant` 的区别
        dominant   —— 单部位，用于**冲突判定**（一票否决式）
        render_parts—— 多部位，用于**实际渲染**（动作要看起来完整）

    规则
        步态类（走/跑/踏步/跺脚…） → ["leg_l", "leg_r"]
        手臂类                     → [dominant]   （只驱动惯用手，另一只保持待机）
        躯干/头部                  → [dominant]
        兜底                       → keep_parts（只保留躯干以下的非 root 部位）
    """
    info = info or {}
    keep = list(keep_parts if keep_parts is not None
                else (info.get("keep_parts") or []))
    dom = info.get("dominant")

    if is_gait_action(aid, info):
        return ["leg_l", "leg_r"]

    if dom in ("arm_r", "arm_l", "torso", "head"):
        return [dom]

    # dominant 缺失的少数动作：退回 keep_parts（去掉 root 由 add() 自行附加）
    pruned = [p for p in keep if p != "root"]
    return pruned or ([dom] if dom else [])


def build_masks(bones, names_map):
    pos = {b: i for i, b in enumerate(bones)}
    return {n: [pos[b] for b in bl if b in pos] for n, bl in names_map.items()}


def part_stats(m, probe):
    peaks = {}
    for name, idx in probe.items():
        if not idx:
            peaks[name] = 0.0
            continue
        r = m.rot[:, idx]
        peaks[name] = float(dop.quat_angle_deg(r[0][None], r).sum(-1).max())
    total = sum(peaks.values())
    return {n: {"peak": round(pk, 1),
                "share": round((pk / total) if total > 1e-6 else 0.0, 3)}
            for n, pk in peaks.items()}


def part_active_window(m, probe_idx, frac=0.25):
    if not probe_idx:
        return 0, m.frames - 1
    r = m.rot[:, probe_idx]
    c = dop.quat_angle_deg(r[0][None], r).sum(-1)
    peak = float(c.max())
    if peak < 5.0:
        return 0, m.frames - 1
    idx = np.where(c >= peak * frac)[0]
    return int(idx[0]), int(idx[-1])


def main():
    ap = argparse.ArgumentParser(description="生成部位索引")
    ap.add_argument("--keep-peak", type=float, default=25.0)
    ap.add_argument("--keep-share", type=float, default=0.10)
    args = ap.parse_args()

    bones = dop.load_skeleton()
    probe = build_masks(bones, PART_PROBE)
    masks = build_masks(bones, PARTS)
    kidx = dop.key_indices()

    files = sorted(KF_DIR.glob("*.json"))
    print("[part_index] 扫描 %d 段 | 部位 %d 个 | 门槛 peak>=%s share>=%s" % (
        len(files), len(PARTS), args.keep_peak, args.keep_share))

    actions = {}
    for i, p in enumerate(files, 1):
        key = p.stem
        if "__" not in key:
            continue
        aid = key.split("__")[0]
        try:
            m = dop.Motion.from_key(key)
        except Exception as exc:
            print("[warn] 跳过 %s: %s" % (key, exc))
            continue

        cropped = dop.crop_active(m, frac=CROP_FRAC, pad=CROP_PAD,
                                  risk_deg=CROP_RISK_DEG,
                                  max_ratio=CROP_MAX_RATIO, kidx=kidx)
        a0 = 0
        if cropped.frames != m.frames:
            d = dop.quat_angle_deg(cropped.rot[0][kidx][None],
                                   m.rot[:, kidx]).sum(-1)
            a0 = int(np.argmin(d))
        a1 = a0 + cropped.frames - 1

        stats = part_stats(m, probe)
        keep = [n for n, s in stats.items()
                if s["peak"] >= args.keep_peak and s["share"] >= args.keep_share]
        for n in FORCE_KEEP_PARTS.get(aid, []):
            if n not in keep:
                keep.append(n)
        keep.sort()

        detail = {}
        for name, s in stats.items():
            act = part_active_window(m, probe[name])
            gap = (dop.max_bone_delta(m.rot[0], m.rot[-1], np.array(masks[name]))
                   if masks[name] else 0.0)
            detail[name] = {
                "peak": s["peak"], "share": s["share"],
                "active": [act[0], act[1]], "keep": name in keep,
                "loop_gap_deg": round(gap, 1),
            }

        # 主导部位：share 最大且 keep 的部位；都没有时取 share 最大者。
        # 用途：并行混合时"只让主导部位动"，否则 91.6% 的动作都含 arm_r，
        # 几乎必然冲突（实测 keep_parts 并集只有 4.4% 可并行，主导部位 54.8%）。
        cand = [(n, s["share"]) for n, s in stats.items() if n in keep]
        if not cand:
            cand = [(n, s["share"]) for n, s in stats.items()]
        dominant = max(cand, key=lambda x: x[1])[0] if cand else None
        # 语义白名单优先（见 FORCE_DOMINANT 的说明）
        if aid in FORCE_DOMINANT:
            dominant = FORCE_DOMINANT[aid]

        # ---- 全局污染度 global_score（M13）----
        # 定义：除主导部位外，其余部位的最大峰值 / 主导部位峰值。
        #
        # 用途：**诊断信息**，说明"这个动作的手臂/腿是否在跟着晃"。
        #   走路 G13-01a: leg_r 164° / arm_l 159° → 0.97（手臂在摆）
        #   招手 G2-01a : arm_r 中 arm_l 占比小 → 0.16
        #
        # ★ 注意：global_score 高 ≠ 不能并行。
        #   鞠躬 G5-01a 的 global_score = 2.08（手臂下垂摆幅比躯干还大），
        #   但鞠躬时**脚不移动**，完全可以和「招手」并行。
        #   真正决定能否并行的是下面 root_activity / is_locomotion。
        dom_peak = float(stats.get(dominant, {}).get("peak", 0.0)) if dominant else 0.0
        other_peak = max(
            (float(s["peak"]) for n, s in stats.items() if n != dominant),
            default=0.0)
        global_score = round(other_peak / dom_peak, 3) if dom_peak > 1e-6 else 1.0
        is_global = bool(global_score > GLOBAL_SCORE_THRESHOLD)

        # ---- root 通道活跃度（M13 核心判据）----
        # 为什么要看 foot_ik 而不是 net_displacement
        #   本库所有动作的 net_displacement 都被清洗成 [0,0,0]（原地循环素材），
        #   但**脚的实际位置**仍然在动：
        #     走路 G13-01a: foot_ik 位移 3.43
        #     走路 G13-02a: 4.45    G13-03a: 4.08
        #     鞠躬 G5-01a : 0.16    ← 脚不动，只是重心下沉
        #     招手 G2-01a : 0.01    ← 完全不动
        #
        #   center（重心）在鞠躬时也会动 3.84，那是"蹲下"，不是"走动"。
        #   所以用 **foot_ik 位移** 判定"脚步是否移动"最准确。
        #
        # is_locomotion=True 的动作：
        #   · 必须独占 root（否则 IK 互相拉扯 → 穿模）
        #   · 不能和其他动作并行（否则"脚在原地挪 + 身体不动" → 滑步）
        root_bones = masks.get("root") or []
        ik_idx = [i for i in root_bones if i in (26, 49)]
        c_idx = [i for i in root_bones if i == 0]
        ik_activity = 0.0
        if ik_idx:
            d_ik = np.abs(m.pos[:, ik_idx] - m.pos[0][ik_idx])
            ik_activity = float(d_ik.max())
        center_activity = 0.0
        if c_idx:
            d_c = np.abs(m.pos[:, c_idx] - m.pos[0][c_idx])
            center_activity = float(d_c.max())
        is_locomotion = bool(ik_activity > IK_LOCOMOTION_THRESHOLD)
        if aid in LOCOMOTION_ACTIONS:
            is_locomotion = True

        actions[key] = {
            "aid": aid, "frames": m.frames,
            "core": {"start": a0, "end": a1},
            "keep_parts": keep,
            "dominant": dominant,
            "global_score": global_score,
            "is_global": is_global,
            # root 通道活跃度：foot_ik 位移（判"脚步是否移动"）
            "ik_activity": round(ik_activity, 2),
            "center_activity": round(center_activity, 2),
            "is_locomotion": is_locomotion,
            "loop_gap_deg": round(dop.max_bone_delta(m.rot[0], m.rot[-1], kidx), 1),
            "parts": detail,
        }
        if i % 100 == 0:
            print("  ... %d/%d" % (i, len(files)))

    if not actions:
        raise SystemExit("没有可分析的动作段")

    OUT_JSON.write_text(json.dumps({
        "version": 1,
        "params": {"keep_peak": args.keep_peak, "keep_share": args.keep_share,
                   "crop_frac": CROP_FRAC, "crop_pad": CROP_PAD,
                   "crop_risk_deg": CROP_RISK_DEG},
        "count": len(actions), "fps": 30,
        # 全局独占部位：位移/IK 通道，并行时同时只能有一条轨道驱动
        "exclusive_parts": list(EXCLUSIVE_PARTS),
        "global_score_threshold": GLOBAL_SCORE_THRESHOLD,
        "parts": {n: {"bones": PARTS[n], "mask": masks[n], "probe": probe[n]}
                  for n in PARTS},
        "actions": actions,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    n = len(actions)
    combo = Counter(tuple(v["keep_parts"]) for v in actions.values())
    keep_cnt = {name: sum(1 for v in actions.values() if name in v["keep_parts"])
                for name in PARTS}
    empty = [k for k, v in actions.items() if not v["keep_parts"]]
    n_parts = Counter(len(v["keep_parts"]) for v in actions.values())

    sets = [set(v["keep_parts"]) for v in actions.values()]
    pairs = conflict = 0
    for i in range(len(sets)):
        for j in range(i + 1, len(sets)):
            if not sets[i] or not sets[j]:
                continue
            pairs += 1
            if sets[i] & sets[j]:
                conflict += 1

    L = ["# 部位索引报告", "",
         "> 门槛：`peak >= %s deg` 且 `share >= %s` · 共 **%d** 段" % (
             args.keep_peak, args.keep_share, n), "",
         "## 一、各部位 keep 比例", "",
         "| 部位 | 骨骼数 | keep 段数 | 占比 |", "|---|---|---|---|"]
    for name in PARTS:
        L.append("| %s | %d | %d / %d | %.1f%% |" % (
            name, len(masks[name]), keep_cnt[name], n,
            100.0 * keep_cnt[name] / n))

    L += ["", "## 二、keep_parts 组合分布（Top 20）", "",
          "| # | 组合 | 段数 |", "|---|---|---|"]
    for i, (c, cnt) in enumerate(combo.most_common(20), 1):
        L.append("| %d | %s | %d |" % (i, " + ".join(c) if c else "（无，全身）", cnt))

    L += ["", "## 三、全局统计", "",
          "- keep 为空的段（全身驱动）：**%d** 段" % len(empty)]
    for k in empty[:15]:
        L.append("  - `%s`" % k)
    if len(empty) > 15:
        L.append("  - …… 共 %d 段" % len(empty))

    L += ["", "| keep 部位数 | 段数 |", "|---|---|"]
    for k in sorted(n_parts):
        L.append("| %d | %d |" % (k, n_parts[k]))

    L += ["", "## 四、主导部位分布（并行时的默认驱动范围）", "",
          "| 主导部位 | 段数 |", "|---|---|"]
    dom_cnt = Counter(v.get("dominant") for v in actions.values())
    for k, cnt in dom_cnt.most_common():
        L.append("| %s | %d |" % (k or "(无)", cnt))

    # 主导部位口径下的并行率
    dsets = [{v["dominant"]} if v.get("dominant") else set()
             for v in actions.values()]
    dp = dc = 0
    for i in range(len(dsets)):
        for j in range(i + 1, len(dsets)):
            if not dsets[i] or not dsets[j]:
                continue
            dp += 1
            if dsets[i] & dsets[j]:
                dc += 1
    if dp:
        L += ["", "| 口径 | 可并行率 |", "|---|---|",
              "| keep_parts 并集（语义完整，适合单动作） | %.1f%% |" % (
                  100.0 * (pairs - conflict) / pairs if pairs else 0),
              "| **主导部位（适合并行混音）** | **%.1f%%** |" % (
                  100.0 * (dp - dc) / dp)]

    # ---- 五、root 通道活跃度（决定能否并行的真正判据）----
    loco = [(v["aid"], v["dominant"], v["ik_activity"], v["center_activity"])
            for v in actions.values() if v.get("is_locomotion")]
    still = [(v["aid"], v["dominant"], v["ik_activity"], v["center_activity"])
             for v in actions.values() if not v.get("is_locomotion")]
    L += ["", "## 五、root 通道活跃度（能否作为并行轨道）", "",
          "### 判据说明", "",
          "`net_displacement` 全库都是 `[0,0,0]`（素材已清洗成原地循环），",
          "无法判断动作是否“在走动”。真正有效的是 **foot_ik 的实际位移**：", "",
          "| 动作 | foot_ik 位移 | center 位移 | 语义 |", "|---|---|---|---|",
          "| `G13-01a` 走路 | **3.43** | 0.52 | 脚步移动 |",
          "| `G13-02a` 走路 | **4.45** | 1.34 | 脚步移动 |",
          "| `G13-03a` 走路 | **4.08** | 3.53 | 脚步移动 |",
          "| `G5-01a` 鞠躬 | 0.16 | 3.84 | 重心下沉，脚不动 |",
          "| `G2-01a` 招手 | 0.01 | 0.27 | 完全不动 |", "",
          "阈值 `foot_ik > %.1f` → `is_locomotion = True`。" % IK_LOCOMOTION_THRESHOLD,
          "", "| 类型 | 段数 | 占比 | 能否并行 |", "|---|---|---|---|",
          "| **移动类**（脚步移动） | **%d** | %.1f%% | ❌ 独占 root，必须串行 |" % (
              len(loco), 100.0 * len(loco) / n),
          "| 原地类（脚不动） | %d | %.1f%% | ✅ 可与不同部位并行 |" % (
              len(still), 100.0 * len(still) / n), ""]
    if loco:
        L += ["### 移动类动作（foot_ik 位移最大的 15 个）", "",
              "| 动作 | 主导部位 | foot_ik | center |", "|---|---|---|---|"]
        for aid, dom, ik, c in sorted(loco, key=lambda x: -x[2])[:15]:
            L.append("| `%s` | %s | **%.2f** | %.2f |" % (aid, dom, ik, c))
        L.append("")
    if still:
        L += ["### 原地动作（foot_ik 位移最大的 10 个，用于校验阈值）", "",
              "| 动作 | 主导部位 | foot_ik | center |", "|---|---|---|---|"]
        for aid, dom, ik, c in sorted(still, key=lambda x: -x[2])[:10]:
            L.append("| `%s` | %s | %.2f | %.2f |" % (aid, dom, ik, c))
        L.append("")

    # ---- 五之二、global_score 诊断 ----
    L += ["## 五之二、global_score 诊断（手臂/腿是否跟着晃）", "",
          "> `global_score = 其他部位最大峰值 / 主导部位峰值`",
          "> **注意**：高 global_score ≠ 不能并行。鞠躬 2.08 但脚不动，可并行。",
          "> 它只说明“这个动作的连带动作有多少”，供调参参考。", ""]
    glob = [(v["aid"], v["dominant"], v["global_score"])
            for v in actions.values() if v.get("is_global")]
    if glob:
        L += ["| 动作 | 主导部位 | global_score | is_locomotion |",
              "|---|---|---|---|"]
        for aid, dom, gs in sorted(glob, key=lambda x: -x[2])[:15]:
            v = next(x for x in actions.values() if x["aid"] == aid)
            L.append("| `%s` | %s | **%.2f** | %s |" % (
                aid, dom, gs, v.get("is_locomotion")))
        L.append("")

    L += ["", "## 六、并行潜力（第 3 步价值评估）", ""]
    if pairs:
        ok = pairs - conflict
        L += ["- 可检验的段对：**%d**" % pairs,
              "- mask 冲突（同部位被抢，必须串行）：**%d**（%.1f%%）" % (
                  conflict, 100.0 * conflict / pairs),
              "- **可真正并行**：**%d**（%.1f%%）" % (ok, 100.0 * ok / pairs)]

    OUT_MD.write_text("\n".join(L) + "\n", encoding="utf-8")

    print()
    print("=" * 62)
    print("段数          : %d" % n)
    for name in PARTS:
        print("  %-7s keep %3d / %d (%5.1f%%)" % (
            name, keep_cnt[name], n, 100.0 * keep_cnt[name] / n))
    print("keep 为空     : %d 段" % len(empty))
    print("keep 部位数分布: %s" % dict(sorted(n_parts.items())))
    if pairs:
        print("可并行段对    : %d / %d (%.1f%%)" % (
            pairs - conflict, pairs, 100.0 * (pairs - conflict) / pairs))
    print("索引          : %s" % OUT_JSON)
    print("报告          : %s" % OUT_MD)
    print("=" * 62)


if __name__ == "__main__":
    main()
