"""按部位并行混合（M11）：同一时间多个部位各自动作。

核心算法移植自 HAST-SEC `motion/beat_layers.mjs` 的 `sample()`：

    for j in 每根骨骼:
        total = max(0.0, 1.0 - sums[j])     # 剩余权重归 base 姿态
        val = base[j]
        for (q, w) in groups[j]:
            val = slerp(val, q, w / (total + w))
            total += w
        out[j] = normalize(val)

这样「左手挥手 + 躯干鞠躬」可以同时成立，且未被任何轨道驱动的关节
自动落回 base（待机）姿态，不会出现"僵直"。

与 HAST-SEC 的差异（针对本项目）
  1. 素材已裁剪到核心区间（core），不需要 skill.start/end
  2. 不引入 cycles 循环权重淡化（素材首尾已是站姿，直接 hold 即可）
  3. 提供 `mask` 显式指定，而不是只靠自动 keep_parts
     —— 实测 91.6% 的动作都含 arm_r，自动判定会让 95.6% 的段对冲突

关于 dominant / render_parts 的区别（重要）
    dominant     单部位字段，用途是**判冲突**——两个动作抢同一部位就必须串行。
    render_parts 多部位列表，用途是**实际渲染**——动作要看起来完整。

    如果拿 dominant 当渲染 mask，动作会被削成残废（实测）：
        G13-01a（原地走）   part=leg_r → 左腿 0.0°，只有右腿在动
        G5-07a （原地踏步） part=torso → 双腿 0.0°，变成"原地扭身"

    所以步态类必须用 ["leg_l", "leg_r"]，详见 part_index.derive_render_parts。

用法
    from part_tracks import PartTracks
    tracks = PartTracks(base=None, index=load_index())
    tracks.add("G2-01a", parts=["arm_r"], start=0.0, speed=1.0)
    tracks.add("G13-01a", parts=["leg_l", "leg_r"], start=0.0)
    motion = tracks.render(frames=110, fps=30)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

sys.path.insert(0, str(Path(__file__).parent))

import dense_ops as dop  # noqa: E402

INDEX_PATH = DATA / "part_index.json"
_IDX_CACHE: dict | None = None

# 语义主导部位白名单（运行时覆盖，见 part_index.FORCE_DOMINANT 的说明）。
# 索引文件是构建产物，改这里立刻生效，不需要重建 part_index.json。
try:
    from part_index import FORCE_DOMINANT as _FORCE_DOMINANT
except Exception:  # noqa: BLE001
    try:
        from tools.part_index import FORCE_DOMINANT as _FORCE_DOMINANT
    except Exception:  # noqa: BLE001
        _FORCE_DOMINANT = {}

# 运行时派生：该动作并行渲染时应驱动哪些部位
try:
    from part_index import derive_render_parts as _derive_render_parts
except Exception:  # noqa: BLE001
    try:
        from tools.part_index import derive_render_parts as _derive_render_parts
    except Exception:  # noqa: BLE001
        _derive_render_parts = None


def load_index(path: Path | None = None) -> dict:
    global _IDX_CACHE
    if path is None and _IDX_CACHE is not None:
        return _IDX_CACHE
    p = Path(path) if path else INDEX_PATH
    doc = json.loads(p.read_text(encoding="utf-8"))
    if path is None:
        _IDX_CACHE = doc
    return doc


def smootherstep(t):
    """五次包络：两端一阶、二阶导都为 0，比 smoothstep 更平顺。

    HAST-SEC beat_layers.mjs 用的就是这个：
        ease(t) = t^3 * (10 + t*(-15 + 6t))
    最大导数 1.875。
    """
    t = np.clip(t, 0.0, 1.0)
    return t * t * t * (10.0 + t * (-15.0 + 6.0 * t))


class PartTracks:
    """多部位并行轨道容器。"""

    def __init__(self, base=None, index: dict | None = None,
                 bones: list[str] | None = None):
        """
        base: 未驱动关节的回退姿态。None 时自动用第一个轨道的首帧。
        index: part_index.json 内容（None 时自动读盘）。
        """
        self.bones = bones or dop.load_skeleton()
        self.bidx = {b: i for i, b in enumerate(self.bones)}
        self.index = index or load_index()
        self.part_masks = {n: np.array(v["mask"], dtype=np.int64)
                           for n, v in self.index["parts"].items()}
        # 全局独占部位（root = center + foot_ik_*）：
        # 位移/IK 通道同一时刻只能被一条轨道驱动，否则会出现
        # 「两条轨道各推一半位移」→ 滑步，或 IK 互相拉扯 → 穿模。
        self.exclusive_parts = tuple(self.index.get("exclusive_parts") or ("root",))
        self.exclusive_mask = np.array([], dtype=np.int64)
        for p in self.exclusive_parts:
            m = self.part_masks.get(p)
            if m is not None and len(m):
                self.exclusive_mask = np.union1d(self.exclusive_mask, m)
        self.exclusive_mask = self.exclusive_mask.astype(np.int64)
        # 位移骨骼集合（render 中跳过 pos 插值）
        self._root_set = set(int(i) for i in self.exclusive_mask)
        self.base = base
        self.tracks: list[dict] = []
        self._serial = 0

    # ---- 查询 ----

    def _raw_info(self, aid: str, variant: str | None = None) -> dict | None:
        """原始索引条目（不做任何运行时覆盖）。"""
        acts = self.index["actions"]
        if variant:
            return acts.get(f"{aid}__{variant}")
        # 找该 aid 下第一个变体
        for k, v in acts.items():
            if v.get("aid") == aid:
                return v
        return None

    def action_info(self, aid: str, variant: str | None = None) -> dict | None:
        """取该动作的索引条目（自动挑第一个变体）。

        运行时会把 `dominant` 用 FORCE_DOMINANT 覆盖，并补一个 `render_parts`
        字段（并行渲染真正要驱动的部位列表）。索引是构建产物，改白名单不需要
        重建 data/part_index.json。
        """
        info = self._raw_info(aid, variant)
        if info is None:
            return None
        dom = _FORCE_DOMINANT.get(aid) or info.get("dominant")
        if dom == info.get("dominant"):
            return info
        out = dict(info)
        out["dominant"] = dom
        if _derive_render_parts is not None:
            out["render_parts"] = _derive_render_parts(aid, out)
        return out

    def render_parts_of(self, aid: str, variant: str | None = None) -> list[str]:
        """该动作并行渲染时应驱动的部位（缺失时按 dominant 推导）。"""
        info = self.action_info(aid, variant) or {}
        rp = info.get("render_parts")
        if rp:
            return list(rp)
        if _derive_render_parts is not None:
            return _derive_render_parts(aid, info)
        dom = info.get("dominant")
        return [dom] if dom else []

    def part_mask(self, part: str) -> np.ndarray:
        return self.part_masks.get(part, np.array([], dtype=np.int64))

    def is_exclusive_mask(self, midx: np.ndarray) -> bool:
        """该 mask 是否触碰全局独占通道（root）。"""
        if len(self.exclusive_mask) == 0 or len(midx) == 0:
            return False
        return bool(np.intersect1d(midx, self.exclusive_mask).size)

    # ---- 加轨道 ----

    def _mask_from_parts(self, parts: list[str]) -> np.ndarray:
        """把部位名列表并成骨骼下标 mask。"""
        idxs: list[np.ndarray] = []
        for p in parts:
            pm = self.part_masks.get(p)
            if pm is not None and len(pm):
                idxs.append(pm)
        if not idxs:
            return np.array([], dtype=np.int64)
        return np.unique(np.concatenate(idxs)).astype(np.int64)

    def add(self, aid: str, part: str | None = None, variant: str | None = None,
            start: float = 0.0, speed: float = 1.0, strength: float = 1.0,
            hold_sec: float = 0.0, fade_sec: float = 0.20,
            mask: list[int] | None = None,
            lib=None, fps: int = 30,
            warp: bool = True, warp_speed_budget: float = 1.8,
            parts: list[str] | None = None) -> int:
        """加一条轨道。

        warp : 是否做能量加权时间弯曲（M13，默认开）。
            part_index 的 core 区间只裁掉"完全静止"的帧，素材末尾的呼吸
            抖动还在（实测末帧仍有 1.3~2.4 度/帧），core 内有 25~30% 前后摇。
            并行混合时这部分摊到整段时长上，用户仍会觉得"做完了还在晃"。
            弯曲对每个部位单独压，各部位独立，混合后互不影响。
        warp_speed_budget : 允许峰值角速度放大倍数（1.8 = 肉眼平顺上限）

        aid   : 动作 ID（如 G2-01a）
        parts : **多部位渲染列表**（并行混合推荐用这个）。
            步态类必须 ["leg_l", "leg_r"]，否则只有一条腿在动。
            手臂类 ["arm_r"] / ["arm_l"]。
        part  : 只驱动单个部位（旧接口，等价于 parts=[part]）
        start : 起始时刻（秒）
        speed : 时间缩放（>1 更快）
        strength : 幅度缩放
        hold_sec : 播完后保持多久（秒）
        fade_sec : 淡入淡出时长（秒）
        mask  : 显式指定骨骼下标（优先级最高，用于精确控制）

        mask 解析优先级：mask > parts > part > keep_parts 并集

        返回轨道 id。
        """
        if lib is None:
            from dense_cache import get_library
            lib = get_library(verbose=False)

        info = self.action_info(aid, variant)
        if info is None:
            raise KeyError(f"动作 {aid} 不在 part_index 中")

        m = lib.get(aid, variant)
        if m is None:
            raise KeyError(f"动作 {aid} 在稠密库中无可用变体")

        # 裁到核心区间
        core = info["core"]
        m = dop.slice_frames(m, core["start"], core["end"])

        # 能量加权时间弯曲（M13）：压掉 core 内残留的前后摇。
        #   放在 amplitude/speed 之前，保证用户的 speed 语义仍然作用于
        #   "已经压好的动作"，而不是被弯曲再二次压缩。
        core_frames = m.frames                 # 记录弯曲前帧数（供 report 统计）
        if warp:
            m = dop.time_warp(m, speed_budget=float(warp_speed_budget))
        warped_n = core_frames - m.frames

        # 幅度
        if abs(strength - 1.0) > 1e-6:
            m = dop.amplitude_scale(m, strength)

        # 时间缩放
        if abs(speed - 1.0) > 1e-6:
            m = dop.time_scale(m, speed)

        # ---- mask 解析 ----
        # 显式骨架下标 > 多部位 parts > 单部位 part > keep_parts 并集
        if mask is not None:
            midx = np.array(mask, dtype=np.int64)
            used_parts = ["(explicit)"]
        elif parts:
            midx = self._mask_from_parts(list(parts))
            used_parts = list(parts)
        elif part is not None:
            midx = self.part_mask(part)
            used_parts = [part]
        else:
            kp = info.get("keep_parts") or []
            if not kp:
                kp = [n for n in self.part_masks if n not in self.exclusive_parts]
            midx = self._mask_from_parts(kp)
            used_parts = kp
            # 全空 = 全身驱动：此时必须带上 root，否则位移丢失
            if not info.get("keep_parts") and len(self.exclusive_mask):
                midx = np.union1d(midx, self.exclusive_mask).astype(np.int64)
                used_parts = list(used_parts) + ["root"]

        if len(midx) == 0:
            raise ValueError(
                f"动作 {aid} 的 part={part} parts={parts} 没有对应骨骼")

        # ---- root 通道自动跟随（M13）----
        # center / foot_ik_* 是骨架的根，凡是"脚在动"的轨道都必须带上它们，
        # 否则 center 冻结 → 滑步，foot_ik 失效 → 脚穿地。
        #
        # ★ 判据不能用 net_displacement
        #   本库素材已清洗成原地循环，net_displacement 全库恒为 [0,0,0]，
        #   但走路时 foot_ik 仍在移动（实测 3.6~4.8）。必须用索引里的
        #   ik_activity（foot_ik 最大位移）才能正确识别。
        #
        # 注意：root 是独占的，resolve_conflicts 保证同时只有一条轨道用它。
        has_disp = bool(info.get("is_locomotion")) or float(
            info.get("ik_activity", 0.0)) > 0.5
        narrowed = bool(parts or part is not None)
        if narrowed and has_disp and not self.is_exclusive_mask(midx):
            if len(self.exclusive_mask):
                midx = np.union1d(midx, self.exclusive_mask).astype(np.int64)
                used_parts = list(used_parts) + ["root"]

        self._serial += 1
        tr = {
            "id": self._serial,
            "aid": aid,
            "variant": variant,
            "parts": used_parts,
            "mask": midx,
            "motion": m,
            "start_sec": float(start),
            "start_f": int(round(float(start) * fps)),
            "speed": float(speed),
            "strength": float(strength),
            "hold_f": int(round(float(hold_sec) * fps)),
            "fade_f": max(1, int(round(float(fade_sec) * fps))),
            "has_disp": bool(has_disp),
            "exclusive": bool(self.is_exclusive_mask(midx)),
            "core_frames": core_frames,
            "warped_frames": max(0, warped_n),
        }
        tr["end_f"] = tr["start_f"] + m.frames + tr["hold_f"] + tr["fade_f"]
        self.tracks.append(tr)

        # 第一个轨道确定 base
        if self.base is None:
            self.base = m
        return tr["id"]

    # ---- 冲突处理 ----

    def resolve_conflicts(self, gap_sec: float = 0.15, fps: int = 30) -> list[tuple]:
        """mask 冲突 → 后者等前者播完（自动降级为串行）。

        两级规则：
          1. **root 独占**：只要两条轨道都碰 root（center / foot_ik_*），
             就必须串行 —— 否则位移各推一半 → 滑步，IK 互相拉扯 → 穿模。
             这是 M13 的关键修复：「走路 + 挥手」无论怎么写都不会滑步。
          2. 常规部位冲突：mask 有交集 → 串行。

        返回 [(前, 后, 原start, 新start), ...] 供日志。
        """
        gap_f = max(1, int(round(gap_sec * fps)))
        moved = []
        for i, t in enumerate(self.tracks):
            for prev in self.tracks[:i]:
                # ① root 独占：两边都碰 root 就必须串行
                excl_clash = (t.get("exclusive") and prev.get("exclusive"))
                # ② 常规 mask 冲突
                mask_clash = (len(np.intersect1d(t["mask"], prev["mask"])) > 0)
                if not (excl_clash or mask_clash):
                    continue
                need = prev["start_f"] + prev["motion"].frames + prev["hold_f"] + gap_f
                if t["start_f"] < need:
                    old = t["start_sec"]
                    t["start_f"] = need
                    t["start_sec"] = round(need / fps, 3)
                    t["end_f"] = need + t["motion"].frames + t["hold_f"] + t["fade_f"]
                    moved.append((prev["aid"], t["aid"], old, t["start_sec"]))
        return moved

    # ---- 渲染 ----

    def render(self, frames: int | None = None, fps: int = 30) -> dop.Motion:
        """逐帧做关节级加权 slerp。"""
        if not self.tracks:
            raise ValueError("没有轨道可渲染")

        # 总帧数：max(end_f) 或显式指定
        auto = max(t["end_f"] for t in self.tracks)
        T = int(frames) if frames else auto
        T = max(T, 2)

        base = self.base
        if base is None:
            raise ValueError("base 未设置")
        B = len(self.bones)

        out_rot = np.zeros((T, B, 4), dtype=np.float64)
        out_pos = np.zeros((T, B, 3), dtype=np.float64)

        # 预取每个轨道的数组，避免循环里反复访问 dict
        for tr in self.tracks:
            tr["_rot"] = tr["motion"].rot
            tr["_pos"] = tr["motion"].pos
            tr["_n"] = tr["motion"].frames

        base_rot0 = base.rot[0]
        base_pos0 = base.pos[0]

        for f in range(T):
            # 从 base 首帧起算（不被驱动的关节固定在这个姿态）
            out_rot[f] = base_rot0
            out_pos[f] = base_pos0

            sums = np.zeros(B, dtype=np.float64)
            groups: list[list] = [[] for _ in range(B)]
            # pos 通道单独统计：root 骨骼（center/foot_ik）的位移**不做插值**
            pos_groups: list[list] = [[] for _ in range(B)]

            for tr in self.tracks:
                w = self._weight(tr, f)
                if w <= 0.0:
                    continue
                src_f = f - tr["start_f"]
                if src_f < 0:
                    continue
                # 播完后保持末帧
                n = tr["_n"]
                if src_f >= n:
                    src_f = n - 1
                q = tr["_rot"][src_f]
                p = tr["_pos"][src_f]
                for j in tr["mask"]:
                    groups[j].append((q[j], p[j], w))
                    sums[j] += w
                    pos_groups[j].append((p[j], w))

            for j in range(B):
                g = groups[j]
                if not g:
                    continue
                total = max(0.0, 1.0 - sums[j])
                val_r = out_rot[f][j].copy()
                for q, p, w in g:
                    # HAST-SEC: w / (total + w)
                    a = w / (total + w) if (total + w) > 1e-9 else 1.0
                    val_r = dop.slerp(val_r[None], q[None], np.array(a))[0]
                    total += w
                out_rot[f][j] = dop.quat_normalize(val_r)

                # ---- 位移通道：位移类骨骼不做 lerp（M13）----
                # center / foot_ik 的 pos 是"绝对位置"，两条轨道各推一半会
                # 得到「半走」的错位位置，与腿部旋转不匹配 → 脚穿地。
                # 规则：位移骨骼只取**权重最高**的那条轨道的值（不混合）。
                pg = pos_groups[j]
                if j in self._root_set:
                    best_p, best_w = pg[0]
                    for p, w in pg[1:]:
                        if w > best_w:
                            best_p, best_w = p, w
                    out_pos[f][j] = best_p
                else:
                    # 非位移骨骼（旋转型）：pos 通常恒为 0，用加权平均无害
                    val_p = out_pos[f][j].copy()
                    tsum = 0.0
                    acc = np.zeros(3, dtype=np.float64)
                    for p, w in pg:
                        acc += p * w
                        tsum += w
                    if tsum > 1e-9:
                        val_p = acc / tsum
                    out_pos[f][j] = val_p

        # 位移处理：并行轨道**不能相加**（两个「往前走」并行 = 走两倍距离，
        # 人会冲出画面）。改为按位移幅度取 max（同向取最大者，反向抵消）。
        nd = np.zeros(3, dtype=np.float64)
        for tr in self.tracks:
            d = tr["motion"].net_displacement
            if d is None:
                continue
            for k in range(3):
                if abs(d[k]) > abs(nd[k]):
                    nd[k] = d[k]
        return dop.Motion(out_rot, out_pos, nd, "part_tracks")

    def locomotion_conflict(self) -> list[str]:
        """返回带位移的轨道 ID 列表（>=2 说明有移动类动作并行，语义可疑）。"""
        out = []
        for tr in self.tracks:
            d = tr["motion"].net_displacement
            if d is not None and float(np.linalg.norm(d)) > 1e-6:
                out.append(tr["aid"])
        return out

    @staticmethod
    def _weight(tr: dict, f: int) -> float:
        """五次包络权重：淡入 → 保持 → 淡出。"""
        a = f - tr["start_f"]
        n = tr["_n"] if "_n" in tr else tr["motion"].frames
        hold = tr["hold_f"]
        fade = tr["fade_f"]
        total = n + hold
        if a < 0 or a > total + fade:
            return 0.0
        w_in = smootherstep(a / fade)
        w_out = 1.0 - smootherstep((a - total) / fade)
        return float(min(w_in, w_out))


# ---------------- 便捷函数 ----------------

def render_parallel(specs: list[dict], base=None, frames: int | None = None,
                    fps: int = 30, lib=None, auto_resolve: bool = True
                    ) -> tuple[dop.Motion, dict]:
    """一次性构建并渲染多条轨道。

    specs 形如:
        [{"aid": "G2-01a", "parts": ["arm_r"], "start": 0.0},
         {"aid": "G5-01a", "parts": ["torso"], "start": 0.3}]

    parts 缺省时按 dominant 自动推导（步态类会给两条腿）。

    返回 (Motion, 报告 {tracks, conflicts, frames, seconds})。
    """
    if lib is None:
        from dense_cache import get_library
        lib = get_library(verbose=False)

    pt = PartTracks(base=base)
    for s in specs:
        parts = s.get("parts")
        if parts is None and s.get("part") is not None:
            parts = [s["part"]]
        pt.add(s["aid"], part=s.get("part"), variant=s.get("variant"),
               start=s.get("start", 0.0), speed=s.get("speed", 1.0),
               strength=s.get("strength", 1.0),
               hold_sec=s.get("hold_sec", 0.0),
               fade_sec=s.get("fade_sec", 0.20),
               mask=s.get("mask"), lib=lib, fps=fps, parts=parts)

    moved = pt.resolve_conflicts(fps=fps) if auto_resolve else []
    m = pt.render(frames=frames, fps=fps)

    report = {
        "tracks": [{"aid": t["aid"], "parts": t["parts"],
                    "start": t["start_sec"], "frames": t["motion"].frames}
                   for t in pt.tracks],
        "conflicts": [{"prev": a, "next": b, "old_start": o, "new_start": n}
                      for a, b, o, n in moved],
        "frames": m.frames,
        "seconds": round(m.frames / fps, 3),
    }
    return m, report
