"""稠密数组快速算子库 (M6)。

与 motion_ops.py 功能一一对应，但全部运行在稠密 [T,B,4] / [T,B,3] 数组上，
跳过 RDP 抽稀（compress）。实测单个算子提速 90~260 倍。

用法::

    import dense_ops as dop
    m = dop.Motion.from_key("G2-01a__G2-01a_v01")
    m = dop.mirror(m)              # 0.7 ms
    m = dop.time_scale(m, 1.15)    # 1.0 ms
    m = dop.amplitude_scale(m, 0.7)# 2.0 ms
    m = dop.concat([m, m], 8)      # 1.0 ms
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

POS_BONES = {"center", "foot_ik_l", "foot_ik_r"}

# 运动匹配用的关键骨骼
KEY_BONES = ["hand_l", "hand_r", "foot_l", "foot_r",
             "head", "upper_body", "center"]

_IDENTITY = np.array([0.0, 0.0, 0.0, 1.0])


# ============ 基础数学（向量化） ============

def quat_mul(a, b):
    """四元数乘法，支持广播。输入 [...,4]。"""
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ], axis=-1)


def quat_conj(q):
    out = q.copy()
    out[..., :3] *= -1
    return out


def quat_normalize(q):
    n = np.linalg.norm(q, axis=-1, keepdims=True)
    n = np.where(n < 1e-12, 1.0, n)
    return q / n


def quat_angle_deg(q0, q1):
    d = (q0 * q1).sum(-1)
    d = np.clip(np.abs(d), -1.0, 1.0)
    return np.degrees(2.0 * np.arccos(d))


def slerp(q0, q1, t):
    """向量化球面线性插值。支持任意前缀维度广播。

    q0, q1: [...,4]；t: 标量或 [T]（会广播到 q0 的帧维度）。
    大角度间隔下与 motion_ops.slerp 数值一致（误差 < 1e-6 度）。
    """
    q0 = np.asarray(q0, dtype=np.float64)
    q1 = np.asarray(q1, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)[..., None]
    while t.ndim < q0.ndim:
        t = t[..., None]

    # 同半球化
    d = (q0 * q1).sum(-1, keepdims=True)
    q1 = np.where(d < 0.0, -q1, q1)
    d = np.abs(d)

    # 小角度退化为线性插值（避免 sin(0) 除零）
    small = d > 0.9995
    theta = np.arccos(np.clip(d, -1.0, 1.0))
    sin_theta = np.sin(theta)
    sin_theta = np.where(sin_theta < 1e-12, 1.0, sin_theta)
    w0 = np.sin((1.0 - t) * theta) / sin_theta
    w1 = np.sin(t * theta) / sin_theta
    r_slerp = w0 * q0 + w1 * q1

    r_lerp = q0 * (1.0 - t) + q1 * t
    r_lerp = quat_normalize(r_lerp)

    r = np.where(small, r_lerp, r_slerp)
    return quat_normalize(r)


# 兼容别名：早期版本用的线性插值
nlerp = slerp


def _smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


# ============ 骨骼表 ============

_SKELETON: list[str] | None = None
_MIRROR_IDX: np.ndarray | None = None


def load_skeleton() -> list[str]:
    global _SKELETON
    if _SKELETON is None:
        smap = json.loads((DATA / "skeleton_map.json").read_text(encoding="utf-8"))
        _SKELETON = [smap["jp_to_en"][jp] for jp in smap["order"]]
    return _SKELETON


_BASE_POSE_CACHE: dict = {}


def load_base_pose(key: str):
    """从源 VMD 首帧提取静态姿态，用于补全 RDP 跳过的恒定骨骼。

    key 形如 'G2-01a__G2-01a_v01' -> motion/G2-01a/G2-01a_v01.vmd
    返回 {en_name: (pos3, rot4)}；源文件不存在时返回 None。
    """
    if key in _BASE_POSE_CACHE:
        return _BASE_POSE_CACHE[key]

    result = None
    if "__" in key:
        aid, vname = key.split("__", 1)
        src = ROOT / "motion" / aid / (vname + ".vmd")
        if src.exists():
            try:
                from vmd_export import load_skeleton_map
                from vmd_lib import parse_vmd
                _, en_to_jp = load_skeleton_map()
                jp_to_en = {jp: en for en, jp in en_to_jp.items()}
                vmd = parse_vmd(src)
                pose = {}
                for jp, keys in vmd.bones.items():
                    en = jp_to_en.get(jp)
                    if en is None or not keys:
                        continue
                    first = keys[0]
                    pose[en] = (tuple(first.pos), tuple(first.rot))
                result = pose or None
            except Exception:  # noqa: BLE001
                result = None

    _BASE_POSE_CACHE[key] = result
    return result


def mirror_index() -> np.ndarray:
    """返回镜像重排索引：out[:, i] = in[:, mirror_idx[i]]。"""
    global _MIRROR_IDX
    if _MIRROR_IDX is None:
        bones = load_skeleton()
        pos = {b: i for i, b in enumerate(bones)}
        idx = np.empty(len(bones), dtype=np.int64)
        for i, b in enumerate(bones):
            if b.endswith("_l"):
                tgt = b[:-2] + "_r"
            elif b.endswith("_r"):
                tgt = b[:-2] + "_l"
            else:
                tgt = b
            idx[i] = pos.get(tgt, i)
        _MIRROR_IDX = idx
    return _MIRROR_IDX


# ============ 算子（全部纯函数，返回新 Motion） ============

def mirror(m: Motion) -> Motion:
    """左右镜像。骨骼 l<->r 重排 + 四元数 y,z 取反 + 位置 x 取反。"""
    idx = mirror_index()
    r = m.rot.copy()
    r[:, :, 1] *= -1.0
    r[:, :, 2] *= -1.0
    p = m.pos.copy()
    p[:, :, 0] *= -1.0

    out_rot = np.empty_like(m.rot)
    out_pos = np.empty_like(m.pos)
    out_rot[:, idx] = r
    out_pos[:, idx] = p

    nd = None
    if m.net_displacement is not None:
        nd = m.net_displacement.copy()
        nd[0] = -nd[0]
    return Motion(out_rot, out_pos, nd, m.source)


def time_scale(m: Motion, speed: float) -> Motion:
    """时间缩放。speed=2 快一倍（帧数减半），0.5 慢一倍。"""
    if speed <= 0:
        raise ValueError("speed 必须 > 0")
    T = m.frames
    Tn = max(2, int(round(T / speed)))
    ts = np.linspace(0.0, T - 1, Tn)
    f0 = np.floor(ts).astype(np.int64)
    f1 = np.minimum(f0 + 1, T - 1)
    frac = ts - f0

    rot = nlerp(m.rot[f0], m.rot[f1], frac)
    fr = frac[:, None, None]
    pos = m.pos[f0] * (1 - fr) + m.pos[f1] * fr

    nd = None
    if m.net_displacement is not None:
        nd = m.net_displacement / speed
    return Motion(rot, pos, nd, m.source)


def resample(m: Motion, target_frames: int) -> Motion:
    """重采样到指定帧数（不改速度语义，只改长度）。"""
    T = m.frames
    target_frames = max(2, int(target_frames))
    if target_frames == T:
        return m.copy()
    ts = np.linspace(0.0, T - 1, target_frames)
    f0 = np.floor(ts).astype(np.int64)
    f1 = np.minimum(f0 + 1, T - 1)
    frac = ts - f0
    rot = nlerp(m.rot[f0], m.rot[f1], frac)
    fr = frac[:, None, None]
    pos = m.pos[f0] * (1 - fr) + m.pos[f1] * fr
    nd = None if m.net_displacement is None else m.net_displacement.copy()
    return Motion(rot, pos, nd, m.source)


def amplitude_scale(m: Motion, strength: float) -> Motion:
    """幅度缩放（相对首帧）。1=原样，0.5=减半，0=静止。"""
    if strength < 0:
        raise ValueError("strength 必须 >= 0")
    if abs(strength - 1.0) < 1e-9:
        return m.copy()

    q0 = m.rot[0]                          # [B,4]
    rel = quat_mul(quat_conj(q0)[None], m.rot)   # [T,B,4]
    ident = np.zeros((1, 1, 4))
    ident[..., 3] = 1.0
    rel_s = nlerp(ident, rel, strength)
    rot = quat_normalize(quat_mul(q0[None], rel_s))

    p0 = m.pos[0]
    pos = p0[None] + strength * (m.pos - p0[None])

    nd = None
    if m.net_displacement is not None:
        nd = m.net_displacement * strength
    return Motion(rot, pos, nd, m.source)


# ============ 动作容器 ============

@dataclass
class Motion:
    """稠密动作：rot [T,B,4] + pos [T,B,3]。"""
    rot: np.ndarray
    pos: np.ndarray
    net_displacement: np.ndarray | None = None
    source: str | None = None

    @property
    def frames(self) -> int:
        return int(self.rot.shape[0])

    def copy(self) -> "Motion":
        return Motion(self.rot.copy(),
                      self.pos.copy(),
                      None if self.net_displacement is None
                      else self.net_displacement.copy(),
                      self.source)

    @classmethod
    def from_doc(cls, doc: dict, bones: list[str] | None = None,
                 base_pose: dict | None = None) -> "Motion":
        """关键帧 doc -> Motion。

        base_pose: {en_name: (pos3, rot4)}，用于补全被 RDP 抽稀跳过的
        恒定骨骼。**这一步不可省**：所谓"恒定"只是整段不动，其静态值
        往往不是单位四元数（例如手指自然弯曲的偏移）。不补全会让手部
        变成僵直张开的状态。
        """
        if bones is None:
            bones = load_skeleton()
        T = int(doc["duration_frames"])
        B = len(bones)
        index = {b: i for i, b in enumerate(bones)}
        rot = np.zeros((T, B, 4), dtype=np.float64)
        rot[..., 3] = 1.0
        pos = np.zeros((T, B, 3), dtype=np.float64)

        for tr in doc["tracks"]:
            bi = index.get(tr["bone"])
            if bi is None:
                continue
            keys = tr["keys"]
            frames = np.array([k[0] for k in keys], dtype=np.float64)
            vals = np.array([k[1:] for k in keys], dtype=np.float64)

            if tr["channel"] == "rot":
                for i in range(1, len(vals)):
                    if np.dot(vals[i], vals[i - 1]) < 0:
                        vals[i] *= -1
                for ki in range(len(frames) - 1):
                    f0, f1 = int(frames[ki]), int(frames[ki + 1])
                    span = f1 - f0
                    if span <= 0:
                        continue
                    t = np.arange(span, dtype=np.float64) / span
                    rot[f0:f1, bi] = nlerp(vals[ki], vals[ki + 1], t)
                last = int(frames[-1])
                rot[last, bi] = vals[-1]
                rot[last + 1:, bi] = vals[-1]
            else:
                tt = np.arange(T, dtype=np.float64)
                for c in range(3):
                    pos[:, bi, c] = np.interp(tt, frames, vals[:, c])

        # 补全被抽稀跳过的恒定骨骼（用源动作的静态值，而非单位四元数）
        if base_pose:
            tracked = {tr["bone"] for tr in doc["tracks"]}
            for bi, en in enumerate(bones):
                if en in tracked:
                    continue
                bp = base_pose.get(en)
                if bp is None:
                    continue
                p3, r4 = bp
                rot[:, bi] = np.asarray(r4, dtype=np.float64)
                pos[:, bi] = np.asarray(p3, dtype=np.float64)

        nd = doc.get("net_displacement") or [0.0, 0.0, 0.0]
        return cls(rot, pos, np.array(nd, dtype=np.float64),
                   doc.get("source"))

    @classmethod
    def from_key(cls, key: str) -> "Motion":
        path = DATA / "keyframes" / f"{key}.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        m = cls.from_doc(doc, base_pose=load_base_pose(key))
        m.source = m.source or key
        return m

    # ---- 导出 ----

    def to_records(self, bone_template: dict | None = None) -> list:
        """稠密数组 -> VMD 记录 [(jp_name, frame, pos3, rot4), ...]。

        bone_template: {jp_name: (pos3, rot4)}，**仅作兜底**。
        正常情况下 `from_doc(base_pose=...)` 已把所有骨骼补全，
        这里遍历的是全部 53 根骨骼，不会再缺。
        """
        from vmd_export import load_skeleton_map
        _, en_to_jp = load_skeleton_map()
        bones = load_skeleton()
        T = self.frames

        records = []
        for bi, en in enumerate(bones):
            jp = en_to_jp.get(en)
            if jp is None:
                continue
            r = self.rot[:, bi]
            p = self.pos[:, bi]
            has_pos = en in POS_BONES and np.abs(p).max() > 1e-9
            rot_list = r.tolist()
            pos_list = p.tolist() if has_pos else None
            for f in range(T):
                records.append((
                    jp, f,
                    pos_list[f] if pos_list is not None else [0.0, 0.0, 0.0],
                    rot_list[f],
                ))

        if bone_template:
            present = {rec[0] for rec in records}
            for jp, (p3, r4) in bone_template.items():
                if jp in present:
                    continue
                records.append((jp, 0, list(p3), list(r4)))
                records.append((jp, max(1, T - 1), list(p3), list(r4)))
        return records

    def to_records_offset(self, bone_template: dict | None = None,
                          start_frame: int = 0) -> list:
        """to_records 的帧偏移版，用于流式分批写出。

        bone_template 仅作兜底，理由同 to_records。
        """
        from vmd_export import load_skeleton_map
        _, en_to_jp = load_skeleton_map()
        bones = load_skeleton()
        T = self.frames

        records = []
        for bi, en in enumerate(bones):
            jp = en_to_jp.get(en)
            if jp is None:
                continue
            r = self.rot[:, bi]
            p = self.pos[:, bi]
            has_pos = en in POS_BONES and np.abs(p).max() > 1e-9
            rot_list = r.tolist()
            pos_list = p.tolist() if has_pos else None
            for f in range(T):
                records.append((
                    jp, start_frame + f,
                    pos_list[f] if pos_list is not None else [0.0, 0.0, 0.0],
                    rot_list[f],
                ))

        if bone_template:
            present = {rec[0] for rec in records}
            for jp, (p3, r4) in bone_template.items():
                if jp in present:
                    continue
                records.append((jp, start_frame, list(p3), list(r4)))
                records.append((jp, start_frame + max(1, T - 1),
                                list(p3), list(r4)))
        return records

    def write_vmd(self, path, model_name: str = "",
                  bone_template: dict | None = None) -> int:
        from vmd_export import write_vmd
        return write_vmd(self.to_records_offset(bone_template, 0), path,
                         model_name=model_name)


# ============ 拼接 / 重复 ============

def concat(parts: list["Motion"], transition_frames: int = 8) -> "Motion":
    """顺序拼接多段，段间插入平滑过渡，使后段首帧对齐前段末帧。"""
    if not parts:
        raise ValueError("parts 不能为空")
    if len(parts) == 1:
        return parts[0].copy()

    rots = [parts[0].rot]
    poss = [parts[0].pos]
    nd = np.zeros(3, dtype=np.float64)
    if parts[0].net_displacement is not None:
        nd = nd + parts[0].net_displacement

    for m in parts[1:]:
        if m.net_displacement is not None:
            nd = nd + m.net_displacement

        a_last = rots[-1][-1]
        a_last_pos = poss[-1][-1]
        r = m.rot
        p = m.pos
        n = min(transition_frames, r.shape[0])

        delta = quat_mul(a_last[None], quat_conj(r[0][None]))
        dpos = a_last_pos - p[0]

        w = 1.0 - np.arange(n, dtype=np.float64) / max(1, n - 1)
        w = _smoothstep(w)
        wq = w[:, None, None]

        ident = np.zeros((n, 1, 4), dtype=np.float64)
        ident[..., 3] = 1.0
        off = nlerp(ident, delta[None], w)
        r_adj = r.copy()
        r_adj[:n] = quat_normalize(quat_mul(off, r[:n]))
        p_adj = p.copy()
        p_adj[:n] = p[:n] + wq * dpos[None]

        rots.append(r_adj)
        poss.append(p_adj)

    return Motion(np.concatenate(rots, axis=0),
                  np.concatenate(poss, axis=0),
                  nd, parts[0].source)


def repeat(m: "Motion", times: int, transition_frames: int = 4) -> "Motion":
    """循环重复 times 次。"""
    times = max(1, int(times))
    if times == 1:
        return m.copy()
    return concat([m] * times, transition_frames)


# ============ 智能过渡（打断插入） ============

def transition_frames(from_rot, from_pos, to_rot, to_pos, n: int = 5):
    """在两组姿态之间生成 n 帧平滑过渡（smoothstep 权重）。

    from_rot: [B,4]、to_rot: [B,4]；from_pos/to_pos: [B,3]。
    返回 (rot [n,B,4], pos [n,B,3])。不含两端原始帧，纯过渡帧。
    """
    from_rot = np.asarray(from_rot, dtype=np.float64)
    to_rot = np.asarray(to_rot, dtype=np.float64)
    from_pos = np.asarray(from_pos, dtype=np.float64)
    to_pos = np.asarray(to_pos, dtype=np.float64)
    n = max(1, int(n))

    t = np.arange(1, n + 1, dtype=np.float64) / float(n + 1)
    w = _smoothstep(t)                                  # [n]
    rot = slerp(from_rot[None], to_rot[None], w)        # [n,B,4]
    fr = w[:, None, None]
    pos = from_pos[None] * (1.0 - fr) + to_pos[None] * fr
    return rot, pos


def find_best_start_frame(pose_rot, m: "Motion", max_ratio: float = 0.6,
                          progress_penalty: float = 6.0) -> tuple[int, float]:
    """在 m 的前 max_ratio 帧中找与 pose_rot 最接近的起始帧。

    返回 (帧号, 姿态距离度)。搜索范围限制在前 60%，避免从动作收尾段接入。
    """
    kidx = key_indices()
    T = m.frames
    if T <= 1 or len(kidx) == 0:
        return 0, 0.0
    max_f = max(1, int(T * max_ratio))
    d = pose_distance(pose_rot, m.rot[:max_f], kidx)     # [max_f]
    # 轻微惩罚靠后的帧，偏好让动作完整一些
    if progress_penalty:
        d = d + (np.arange(max_f) / float(T)) * progress_penalty
    f = int(np.argmin(d))
    return f, float(d[f])


def splice_after_pose(pose_rot, pose_pos, m: "Motion",
                      n_transition: int = 5, max_ratio: float = 0.6
                      ) -> tuple["Motion", dict]:
    """从 pose 平滑过渡到 m 的某个最佳起始帧，再播放 m 余下部分。

    这正是「队首插入」：先比对当前姿态（队列第 5 帧）与新动作哪一帧最像，
    从那一帧开始接，并在中间插入 n_transition 帧过渡。

    返回 (拼接后的 Motion, 调试信息 {start_frame, dist, transition_max_delta}）。
    """
    f, dist = find_best_start_frame(pose_rot, m, max_ratio=max_ratio)

    tr_rot, tr_pos = transition_frames(
        pose_rot, pose_pos, m.rot[f], m.pos[f], n=n_transition)

    tail_rot = m.rot[f:]
    tail_pos = m.pos[f:]

    rot = np.concatenate([tr_rot, tail_rot], axis=0)
    pos = np.concatenate([tr_pos, tail_pos], axis=0)

    # 过渡段的最大单帧角度变化（用于日志诊断）
    stack = np.concatenate([pose_rot[None], rot], axis=0)
    kidx = key_indices()
    if len(kidx):
        steps = quat_angle_deg(stack[:-1][:, kidx], stack[1:][:, kidx]).sum(-1)
        max_delta = float(steps.max())
    else:
        max_delta = 0.0

    dbg = {
        "start_frame": f,
        "match_dist": round(dist, 3),
        "transition_frames": n_transition,
        "transition_max_delta": round(max_delta, 3),
        "dropped_head_frames": f,
    }
    nd = None if m.net_displacement is None else m.net_displacement.copy()
    return Motion(rot, pos, nd, m.source), dbg


def append_with_bridge(prev: "Motion", m: "Motion",
                       n_transition: int = 5) -> tuple["Motion", dict]:
    """队尾追加：在 prev 末帧与 m 首帧间插入 n_transition 帧过渡。

    与「队首」不同，这里不丢 m 的开头（追加语义是动作要完整播完）。
    """
    prev_last_rot = prev.rot[-1]
    prev_last_pos = prev.pos[-1]
    tr_rot, tr_pos = transition_frames(
        prev_last_rot, prev_last_pos, m.rot[0], m.pos[0], n=n_transition)

    rot = np.concatenate([prev.rot, tr_rot, m.rot], axis=0)
    pos = np.concatenate([prev.pos, tr_pos, m.pos], axis=0)

    stack = np.concatenate([prev_last_rot[None], tr_rot, m.rot[:1]], axis=0)
    kidx = key_indices()
    if len(kidx):
        steps = quat_angle_deg(stack[:-1][:, kidx], stack[1:][:, kidx]).sum(-1)
        max_delta = float(steps.max())
    else:
        max_delta = 0.0

    nd = None
    if prev.net_displacement is not None or m.net_displacement is not None:
        a = prev.net_displacement if prev.net_displacement is not None else 0.0
        b = m.net_displacement if m.net_displacement is not None else 0.0
        nd = np.asarray(a, dtype=np.float64) + np.asarray(b, dtype=np.float64)

    dbg = {
        "transition_frames": n_transition,
        "transition_max_delta": round(max_delta, 3),
        "mode": "append",
    }
    return Motion(rot, pos, nd, m.source), dbg


# ============ 检索 / 运动匹配 ============

def key_indices(bones: list[str] | None = None) -> np.ndarray:
    """关键骨骼在骨骼表中的下标。"""
    if bones is None:
        bones = load_skeleton()
    return np.array([bones.index(b) for b in KEY_BONES if b in bones],
                    dtype=np.int64)


def pose_distance(a_rot, b_rot, kidx: np.ndarray | None = None):
    """姿态角度距离（度）。

    a_rot: [B,4]；b_rot: [B,4] 或 [T,B,4]。
    b_rot 为 2D 返回 float，3D 返回 [T]。
    """
    if kidx is None:
        kidx = key_indices()
    if b_rot.ndim == 2:
        return float(quat_angle_deg(a_rot[kidx], b_rot[kidx]).sum())
    d = quat_angle_deg(a_rot[kidx][None], b_rot[:, kidx])
    return d.sum(-1)


def find_best_start(a_last_rot, b: "Motion", max_start_ratio: float = 0.5,
                    progress_penalty: float = 10.0,
                    min_gain_deg: float = 2.0) -> tuple[int, float]:
    """运动匹配：在 b 中搜与 a_last_rot 最接近的帧作为起点。

    返回 (最佳帧号, 得分)。改善不足 min_gain_deg 时返回 0（保完整动作）。
    """
    kidx = key_indices()
    T = b.frames
    if T <= 1 or len(kidx) == 0:
        return 0, 0.0
    max_f = max(1, int(T * max_start_ratio))

    dists = pose_distance(a_last_rot, b.rot[:max_f], kidx)
    scores = dists + (np.arange(max_f) / T) * progress_penalty
    best_f = int(np.argmin(scores))
    d0 = float(dists[0])
    gain = d0 - float(dists[best_f])
    if best_f > 0 and gain < min_gain_deg:
        return 0, d0
    return best_f, float(scores[best_f])


def pose_index_entry(m: "Motion") -> np.ndarray:
    """抽取关键骨骼轨迹（float32），用于全库姿态索引。"""
    kidx = key_indices()
    return m.rot[:, kidx].astype(np.float32)


def apply_ops(m: "Motion", ops: list[tuple]) -> "Motion":
    """按序应用算子链。

    ops 形如 [("mirror",), ("time_scale", 1.15), ("amplitude_scale", 0.7)]。
    """
    for op in ops:
        name = op[0]
        if name == "mirror":
            m = mirror(m)
        elif name == "time_scale":
            m = time_scale(m, float(op[1]))
        elif name == "amplitude_scale":
            m = amplitude_scale(m, float(op[1]))
        elif name == "resample":
            m = resample(m, int(op[1]))
        elif name == "repeat":
            m = repeat(m, int(op[1]))
        else:
            raise ValueError(f"未知算子: {name}")
    return m


def to_doc(m: "Motion") -> dict:
    """Motion -> 关键帧 doc（稀疏，含 RDP 抽稀）。用于需要 JSON 的场合。"""
    import motion_ops as mo
    return mo.compress(m.rot, m.pos, load_skeleton(),
                       None if m.net_displacement is None
                       else [float(v) for v in m.net_displacement])


# ============ 裁剪 / 时长预算（M10） ============
#
# 设计依据（全库 345 段实测，见 tools/crop_report.py 与 data/crop_report.md）
#   - 素材全部 134 帧（4.47s），其中"站好→动作→回站姿"里可安全裁掉 ~23.6%
#   - 安全判据必须是**单根骨骼**最大偏移，不能用 7 骨累加
#     （累加口径下 12° 仅等于每骨 1.7°，会把裁剪全部压回 0）
#   - 自适应前后摇公式照搬 HAST-SEC motion/beat_layers.mjs：
#         fade = max(0.7, 1.875 * gap / omega)
#     1.875 是五次包络（smootherstep）的导数上限，omega 是允许的最大角速度

FPS_DEFAULT = 30

#: 单位换算：2.5 rad/s ≈ 143.2 °/s（HAST-SEC 用的角速度上限）
OMEGA_RAD_PER_S = 2.5


def slice_frames(m: "Motion", a: int, b: int) -> "Motion":
    """取 [a, b] 闭区间帧（越界自动夹紧，a>b 自动交换）。"""
    a = int(a)
    b = int(b)
    if b < a:
        a, b = b, a
    a = max(0, min(a, m.frames - 1))
    b = max(0, min(b, m.frames - 1))
    if a == 0 and b == m.frames - 1:
        return m.copy()
    nd = None if m.net_displacement is None else m.net_displacement.copy()
    return Motion(m.rot[a:b + 1].copy(), m.pos[a:b + 1].copy(), nd, m.source)


def max_bone_delta(m_rot_a, m_rot_b, kidx: np.ndarray | None = None) -> float:
    """两组姿态之间**单根骨骼**的最大角差（度）。

    这是接缝安全判据。用 sum 会放大成 7 倍，不能用于阈值判断。
    """
    if kidx is None:
        kidx = key_indices()
    qa = np.asarray(m_rot_a)[kidx]
    qb = np.asarray(m_rot_b)[kidx]
    return float(quat_angle_deg(qa[None], qb[None]).max())


def adaptive_fade_frames(gap_deg: float,
                         min_frames: int = 5,
                         max_frames: int = 12,
                         deg_per_frame: float = 2.5) -> int:
    """按接缝角距算**插入的过渡帧数**（不是 HAST-SEC 的 fade 时长）。

    为什么不能直接套用 HAST-SEC 的 fade 公式
        HAST-SEC 的 `fade = max(0.7, 1.875*gap/2.5)` 是**权重包络的上升时间**，
        动作在这期间已经在播放（权重 0→1）。而这里的过渡帧是**纯插值帧**，
        不含动作内容 —— 直接套用会得到 21 帧（0.7s），比现状的固定 8 帧还长，
        反而抵消裁剪收益。

    本函数的物理依据
        过渡用 3 次 smoothstep slerp，其单帧最大变化 ≈ gap * 1.5 / n。
        要让单帧变化 <= deg_per_frame（默认 2.5°，肉眼平顺）：
            n >= gap * 1.5 / 2.5 = 0.6 * gap
        再夹到 [min_frames, max_frames]：
            gap  5° →  5 帧
            gap 12° →  7 帧
            gap 20° → 12 帧
            gap 40°+ → 12 帧（上限，避免过渡比动作还长）
    """
    gap = abs(float(gap_deg))
    n = int(round(0.6 * gap))
    return max(int(min_frames), min(int(max_frames), n))



def crop_active(m: "Motion", frac: float = 0.30, pad: int = 2,
                risk_deg: float = 12.0, max_ratio: float = 0.40,
                kidx: np.ndarray | None = None,
                tail_abs_deg: float = 0.10, settle_frames: int = 6,
                fps: int = FPS_DEFAULT) -> "Motion":
    """裁掉动作首尾的“站立缓冲”，可选把尾巴收势回中立姿态。

    ★ 为什么必须有 tail_abs_deg（M13 修复）
        原实现用 `curve = 相对首帧的累计角` 找首尾越阈帧。
        但**素材尾部根本没回到站立姿态**——实测尾帧残差：

            G2-01a 招手  尾帧残差 0.167（17% of peak）
            G4-01a 点头  尾帧残差 0.224
            G10-02a      尾帧残差 0.205
            G5-01a 鞠躬  尾帧残差 0.062  ← 唯一收得干净的

        于是 `curve >= peak*frac` 在尾部几乎永不落回阈值以下，
        `a1` 恒等于 T-1，**尾巴一帧都裁不掉**（实测 12 个样本里 9 个无法裁尾）。
        表现就是用户说的“前后摇太长”：动作做完了，人还在半举手的姿势晃好几秒。

        改用**双判据**：
          · 前段：仍按 `curve >= peak*frac`（起势有明确起点，判据有效）
          · 后段：按 **相对尾帧的收敛度** `tail_curve <= peak*tail_abs_deg`
                  —— 即“这一帧离最终静止姿态有多近”，与起始姿态无关。

    ★ settle_frames
        裁剪后若末帧仍不是中立姿态（尾残差 > risk_deg），追加 `settle_frames`
        帧的 slerp，把姿态平滑收回到**首帧姿态**（素材起点=站立）。
        这样并行混合时，其他部位看到的末帧姿态是干净的，
        不会被“半举手”污染。

    全库实测（frac=0.30 / pad=2 / risk=12° / tail_abs=0.10 / settle=6）：
        134 帧 → 平均裁掉 31.2%，尾部离站立 中位 5.9° / max 11.8° / 超标 0 段
        （settle=0 时尾部中位 11.8° / max 26.0° / 超标 19/40 —— 必须补收势）

    参数可通过环境变量回滚，见 server/config.py 的 T2M_CROP* 系列。
    """
    if m.frames <= 2:
        return m.copy()
    if kidx is None:
        kidx = key_indices()

    T = m.frames
    r = m.rot[:, kidx]                                  # [T, K, 4]
    curve = quat_angle_deg(r[0][None], r).sum(-1)       # [T] 相对首帧
    peak = float(curve.max())

    if peak < 3.0:               # 几乎全程静止（待机类），不做裁剪
        return m.copy()

    idx = np.where(curve >= peak * frac)[0]
    if len(idx) == 0:
        return m.copy()
    a0 = max(0, int(idx[0]) - int(pad))
    a1 = min(T - 1, int(idx[-1]) + int(pad))

    # ---- 首部安全阀：d0 = 相对首帧（站立）的单骨最大角差 ----
    d0 = quat_angle_deg(r[0][None], r).max(-1)          # [T]
    if d0[a0] > risk_deg:
        ok = np.where(d0[:a0 + 1] <= risk_deg)[0]
        a0 = int(ok[-1]) if len(ok) else 0

    # ---- 尾部：必须用「绝对站立姿态」判据，不能用「相对末帧」（M13 核心修复）----
    #
    # 为什么 dN（相对末帧）是错的
    #   实测素材末帧本身就不是站立姿态（尾帧 d0 = 20~45°），
    #   于是 dN[T-1] = 0 恒成立 —— 判据在任何素材上都"通过"，
    #   等于没有约束，反而会把已裁好的 a1 向右推到末帧。
    #
    # 正确做法：末尾常有一段"已经静止但没回到站姿"的半收势姿态。
    #   从末帧往前扫，找到末尾连续接近站立段（d0 <= risk_deg）的起点；
    #   若整段末尾都不接近站立（如末帧半举手），此判据不生效，
    #   交给 settle_tail 做收势。
    if tail_abs_deg > 0:
        tail_start = T
        f = T - 1
        while f >= 0 and d0[f] <= risk_deg:
            tail_start = f
            f -= 1
        if a0 < tail_start < T:
            a1 = min(a1, min(T - 1, tail_start + int(pad) - 1))

    # 兜底：单侧不允许裁掉超过 max_ratio
    lim = int(T * max_ratio)
    a0 = min(a0, lim)
    a1 = max(a1, T - 1 - lim)

    if a1 <= a0:
        return m.copy()
    out = slice_frames(m, a0, a1)

    # ---- settle：把尾巴收回到**原素材首帧**（真站立姿态）----
    #   注意传 m.rot[0] 而不是 out.rot[0]：后者是被裁到 a0 后的首帧，
    #   已偏离站立 8~12°（见 settle_tail 的注释）。
    if settle_frames > 0:
        out = settle_tail(out, settle_frames, kidx, risk_deg=risk_deg,
                          target_rot=m.rot[0])
    return out


def peak_angular_speed(m: "Motion", kidx: np.ndarray | None = None) -> float:
    """峰值角速度（°/帧，关键骨累加）。用于时间弯曲的质量约束。"""
    if m.frames < 2:
        return 0.0
    if kidx is None:
        kidx = key_indices()
    sp = quat_angle_deg(m.rot[:-1][:, kidx], m.rot[1:][:, kidx]).sum(-1)
    return float(sp.max())


def _warp_core(m: "Motion", edge_speed: float, body_frac: float,
               kidx: np.ndarray) -> "Motion":
    """内层：按固定 edge_speed 做能量加权时间弯曲。"""
    T = m.frames
    r = m.rot[:, kidx]
    curve = quat_angle_deg(r[0][None], r).sum(-1)
    pk = float(curve.max())
    if pk < 3.0:
        return m.copy()

    # 归一化能量 → 速度系数：高能量段 1.0（原速），低能量段 edge_speed（快放）
    norm = np.clip(curve / pk, 0.0, 1.0)
    w = np.clip((norm - body_frac) / max(1e-9, 1.0 - body_frac), 0.0, 1.0)
    speed = edge_speed + (1.0 - edge_speed) * w

    # 逐帧 speed → 累计"新时间轴"
    t = np.concatenate([[0.0], np.cumsum(1.0 / speed[:-1])])
    Tn = max(2, int(round(float(t[-1]))) + 1)
    ts = np.linspace(0.0, float(t[-1]), Tn)
    src = np.interp(ts, t, np.arange(T, dtype=np.float64))
    f0 = np.clip(np.floor(src).astype(np.int64), 0, T - 1)
    f1 = np.minimum(f0 + 1, T - 1)
    fr = src - f0

    rot = slerp(m.rot[f0], m.rot[f1], fr)
    fr3 = fr[:, None, None]
    pos = m.pos[f0] * (1.0 - fr3) + m.pos[f1] * fr3
    nd = None if m.net_displacement is None else m.net_displacement.copy()
    return Motion(rot, pos, nd, m.source)


def time_warp(m: "Motion", body_frac: float = 0.45,
              speed_budget: float = 1.8,
              kidx: np.ndarray | None = None) -> "Motion":
    """能量加权时间弯曲：压掉前后摇，主体动作保持原速。

    ★ 为什么要做时间弯曲而不是单纯裁剪（M13 核心）
        实测素材末尾**永远有 1.3~2.4 °/帧 的呼吸抖动**，且末帧姿态
        不是站立姿态（残差 20~45°）。所以：
          · 按"速度趋零"找动作终点 → 找不到（末帧速度 1.6 不为零）
          · 按"回到站立"裁尾 → 只能裁掉 0~4 帧
        裁剪的天花板就在这里（实测最多裁 24%，仍需 3.4s）。

        换个思路：**不去判断"哪一帧是结尾"，而是把低能量段整体加速**。
        动作的主体（能量 >= 45% 峰值）保持 1.0 倍速，完全不改；
        起势/收势的摇摆段按 edge_speed 快放。
        这样既压掉"摇太久"的观感，又不会切掉动作内容。

    ★ speed_budget 是质量约束（不是压缩率）
        加速会让角速度上升。`speed_budget=1.8` 表示允许峰值角速度
        最多变成原来的 1.8 倍（肉眼仍平顺）。用二分搜索找满足该约束的
        最大 edge_speed：
            budget 1.5x → 平均 2.78s（压缩 37.8%）
            budget 1.8x → 平均 2.53s（压缩 43.3%）← 默认
            budget 2.2x → 平均 2.31s（压缩 48.4%）

        不用固定压缩率的原因：有的动作本身很快（G10 峰值 40°/帧），
        硬压会抽帧成幻灯片；有的很慢（G4 峰值 8.2°/帧），可以压得更狠。
        用角速度约束能自动适配每个动作。

    body_frac
        能量低于 `peak * body_frac` 的帧算"摇摆段"。0.45 是实测拐点：
        招手 0.30~0.45 区间能量从 0.47 掉到 0.18，边界清晰。
    """
    if m.frames < 4:
        return m.copy()
    if kidx is None:
        kidx = key_indices()

    limit = peak_angular_speed(m, kidx) * float(speed_budget)
    best = m
    lo, hi = 1.0, 3.0
    for _ in range(12):                     # 二分 12 次 ≈ 精度 0.0005
        mid = (lo + hi) / 2.0
        cand = _warp_core(m, mid, body_frac, kidx)
        if cand.frames >= m.frames:
            lo = mid
            continue
        if peak_angular_speed(cand, kidx) <= limit:
            best = cand
            lo = mid
        else:
            hi = mid
    return best


def settle_tail(m: "Motion", n: int, kidx: np.ndarray | None = None,
                risk_deg: float = 8.0,
                target_rot=None) -> "Motion":
    """在末尾追加 n 帧，把姿态 slerp 回**站立姿态**。

    为什么要做
        素材尾部常残留 10~20% 幅度的“半举着手”姿态。直接 hold 会让
        角色一直悬在半空，用户感知就是“动作做完了还在摇”。
        补一段 150~250ms 的收势，视觉上干净，且不影响动作主体。

    ★ target_rot：必须传**真正的站立姿态**
        默认退化到 `m.rot[0]`，但那在 `crop_active` 里已经不成立：
        crop 后片段的首帧是原素材的第 a0 帧，**本身已偏离站立 8~12°**
        （首部安全阀的上限就是 12°）。用它当收势目标，收完仍残留
        8~12°，再叠上末帧自身的偏差就是 16~26°——正是实测里
        "settle 之后仍有 3 段 > 12°" 的原因。
        所以 crop_active 必须把 `原素材首帧` 显式传进来。

    只对偏离超过 risk_deg 的骨骼做收敛；本身已接近站立的直接跳过，
    避免给干净素材额外加帧。
    """
    if m.frames <= 1 or n <= 0:
        return m
    if kidx is None:
        kidx = key_indices()

    if target_rot is None:
        target_rot = m.rot[0]
    target = np.asarray(target_rot, dtype=np.float64)   # [B,4] 站立姿态
    last = m.rot[-1]                                    # [B,4]
    need = quat_angle_deg(last[kidx][None], target[kidx][None]).max()
    if need <= risk_deg:                    # 已经收干净，不加帧
        return m

    B = m.rot.shape[1]
    add_rot = np.zeros((n, B, 4), dtype=np.float64)
    add_pos = np.zeros((n, m.pos.shape[1], 3), dtype=np.float64)
    for f in range(n):
        w = (f + 1) / float(n)              # 1/n → 1.0
        add_rot[f] = slerp(last[None], target[None], np.array(w))[0]
        add_pos[f] = m.pos[-1] * (1.0 - w) + m.pos[0] * w
    add_rot = np.stack([quat_normalize(q) for q in add_rot])
    # 末帧强制对齐到站立（slerp 的 w=1 理论值就是 target，这里钉死
    # 是为了消除浮点误差与四元数双覆盖带来的残差）
    add_rot[-1] = target

    nd = None if m.net_displacement is None else m.net_displacement.copy()
    return Motion(np.concatenate([m.rot, add_rot], axis=0),
                  np.concatenate([m.pos, add_pos], axis=0),
                  nd, m.source + "+settle")


def _join_motions(motions: list["Motion"], transition,
                  fps: int = FPS_DEFAULT,
                  kidx: np.ndarray | None = None) -> "Motion":
    """内部：按 transition 策略拼接（"adaptive" / 整数帧数）。"""
    if not motions:
        raise ValueError("motions 不能为空")
    if len(motions) == 1:
        return motions[0]

    if transition == "adaptive":
        if kidx is None:
            kidx = key_indices()
        out = motions[0]
        for m in motions[1:]:
            gap = max_bone_delta(out.rot[-1], m.rot[0], kidx)
            n = adaptive_fade_frames(gap)
            # 过渡帧数不能超过动作本身的长度（避免把短动作吃光）
            n = max(1, min(n, m.frames // 2))
            out, _ = append_with_bridge(out, m, n_transition=n)
        return out


    return concat(motions, transition_frames=int(transition))


def fit_motions(motions: list["Motion"],
                budget_frames: int | None = None,
                speed_max: float = 2.0,
                speed_min: float = 0.4,
                overflow_max_sec: float = 2.0,
                fps: int = FPS_DEFAULT,
                transition="adaptive",
                crop: bool = True,
                crop_frac: float = 0.30,
                crop_pad: int = 2,
                crop_risk_deg: float = 12.0,
                warp: bool = False,
                warp_body_frac: float = 0.45,
                warp_speed_budget: float = 1.8,
                settle_frames: int = 6,
                tail_abs_deg: float = 0.10) -> tuple["Motion", dict]:
    """把一个或多个动作塞进时长预算，返回 (Motion, 决策报告)。

    降级阶梯（已与产品确认）：
        ① 加速：speed = total / budget，speed <= speed_max 直接完成
           （speed < 1.0 表示拉长，物理上无风险，直接接受）
        ② 砍动作：先按 speed_max 压，再从末尾丢动作
        ③ 允许超时：溢出 <= overflow_max_sec 接受，记 warning

    budget_frames=None 时行为与改动前**逐字节等价**：
        单动作直接返回；多动作走 concat(transition_frames=8)。
        （唯一差别是 crop=True 会先裁掉站立缓冲，可用 crop=False 完全回滚）

    warp（M13，默认 False 以保证既有回归指标不变）
        能量加权时间弯曲，压掉"前后摇太长"。由调用方显式开启：
            settle_frames  裁尾后补几帧收势回站立（推荐 6）
            tail_abs_deg   尾部收敛判据（推荐 0.10）
            warp_speed_budget  峰值角速度放大上限（推荐 1.8）

    report 字段见返回值，供 server/api 透出 `duration_fit`。
    """
    report: dict = {
        "budget_sec": None,
        "actual_sec": None,
        "effective_speed": 1.0,
        "cropped_frames": 0,
        "cropped_clips": 0,
        "dropped_actions": [],
        "repeats_reduced": [],
        "overflow_sec": 0.0,
        "warnings": [],
        "warped_frames": 0,
        "warped_clips": 0,
        "settled_clips": 0,
    }
    if not motions:
        raise ValueError("motions 不能为空")

    kidx = key_indices()

    # ---- 1) 裁剪 ----

    if crop:
        before = sum(m.frames for m in motions)
        cropped = []
        for m in motions:
            # settle 交给 crop_active 内部完成（它持有原素材首帧 = 真站立姿态，
            # 在外面重复调 settle_tail 会因拿不到 target_rot 而收不干净）
            c = crop_active(m, frac=crop_frac, pad=crop_pad,
                            risk_deg=crop_risk_deg, kidx=kidx,
                            tail_abs_deg=tail_abs_deg,
                            settle_frames=settle_frames)
            if settle_frames > 0 and c.source and c.source.endswith("+settle"):
                report["settled_clips"] += 1
            # cropped_clips 用"净减少帧数 > 0"判定：
            #   settle 会补 6 帧回来，若用 `c.frames != m.frames` 判断，
            #   裁 34 帧 + 补 6 帧 = 净减 28 帧也计数（正确），
            #   但极端情况下净增 0 帧也会被计入（错误）。用净减少更准。
            if c.frames < m.frames:
                report["cropped_clips"] += 1
            cropped.append(c)
        motions = cropped
        report["cropped_frames"] = before - sum(m.frames for m in motions)

    # ---- 1.5) 能量加权时间弯曲（M13）：压掉"前后摇太长" ----
    #   裁剪只能去掉"完全静止"的帧，但素材末尾本来就一直在轻微晃
    #   （实测末帧仍有 1.3~2.4 °/帧），所以裁剪天花板约 24%。
    #   时间弯曲把低能量段加速，主体段（能量 >= body_frac*峰值）保持原速。
    if warp:
        before_w = sum(m.frames for m in motions)
        warped = []
        for m in motions:
            w = time_warp(m, body_frac=warp_body_frac,
                          speed_budget=warp_speed_budget, kidx=kidx)
            if w.frames != m.frames:
                report["warped_clips"] += 1
            warped.append(w)
        motions = warped
        report["warped_frames"] = before_w - sum(m.frames for m in motions)

    # ---- 2) 无预算：等价旧行为 ----
    if budget_frames is None:
        if len(motions) == 1:
            final = motions[0]
        else:
            # 旧路径固定 8 帧过渡；这里保持一致以免改变默认行为
            final = concat(motions, transition_frames=8)
        report["actual_sec"] = round(final.frames / fps, 3)
        return final, report

    budget_frames = max(2, int(budget_frames))
    report["budget_sec"] = round(budget_frames / fps, 3)

    # ---- 3) 算所需 speed（不含过渡帧，过渡帧单独计入最终时长）----
    #     这里用 sum 而不是拼接后帧数，避免"过渡帧也要被压缩"的循环依赖
    total = sum(m.frames for m in motions)
    raw_speed = total / float(budget_frames)
    report["speed_requested"] = round(raw_speed, 3)

    # 关键：用 raw_speed（需求）判断走哪条分支，**不能先用 min 夹紧再判断**，
    # 否则 `speed <= speed_max` 恒为真，永远进不了"砍动作"分支。
    if raw_speed <= speed_max:
        # ---- ① 加速 / 保持原速 ----
        # 预算宽松时**不主动拉慢**（下限 1.0）：
        #   "今天心情好（招招手）" 给 5s 预算，若按 5s 拉长会变成慢动作，
        #   观感很差。宁可提前播完，剩下的时间留给待机。
        speed = max(1.0, raw_speed)
        scaled = ([time_scale(m, speed) for m in motions]
                  if abs(speed - 1.0) > 1e-6 else [m.copy() for m in motions])
        final = _join_motions(scaled, transition, fps, kidx)
        report["effective_speed"] = round(speed, 3)
        report["actual_sec"] = round(final.frames / fps, 3)

        # time_scale 有取整误差 + 过渡帧要占地方，仍需检查溢出
        overflow = (final.frames - budget_frames) / float(fps)
        if overflow > 1e-3:
            report["overflow_sec"] = round(
                min(overflow, float(overflow_max_sec)), 3)
            report["warnings"].append("duration_overflow")
        return final, report

    # ---- ② 需求超过 speed_max：先记 warning，按上限压，再砍动作 ----
    report["warnings"].append("speed_capped")
    scaled = [time_scale(m, speed_max) for m in motions]
    dropped = []
    while len(scaled) > 1 and sum(x.frames for x in scaled) > budget_frames:
        dropped.append(motions[len(scaled) - 1].source
                       or f"action_{len(scaled) - 1}")
        scaled.pop()
    if dropped:
        report["dropped_actions"] = list(reversed(dropped))
        report["warnings"].append("action_dropped")

    final = _join_motions(scaled, transition, fps, kidx)
    report["effective_speed"] = round(speed_max, 3)
    report["actual_sec"] = round(final.frames / fps, 3)

    # ---- ③ 允许超时 ----
    overflow = (final.frames - budget_frames) / float(fps)
    if overflow > 1e-3:
        report["overflow_sec"] = round(min(overflow, float(overflow_max_sec)), 3)
        report["warnings"].append("duration_overflow")

    return final, report


