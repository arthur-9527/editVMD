"""M3: 动作调制与拼接核心库。

提供:
  - expand / compress    关键帧 JSON <-> 逐帧数组
  - time_scale           时间缩放（变速）
  - amplitude_scale      幅度缩放（变幅，相对首帧）
  - mirror               左右镜像
  - concat               多段拼接 + 过渡
  - resample             重采样到指定帧数

所有函数输入输出都是关键帧 doc（dict），纯函数无副作用。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# 抽稀阈值（与 m2_extract.py 保持一致）
THR_FINGER = 3.0
THR_TORSO = 1.5
THR_LIMB = 1.2
THR_FOOT = 1.0
THR_POS = 0.02

POS_BONES = {"center", "foot_ik_l", "foot_ik_r"}

_IDENTITY = np.array([0.0, 0.0, 0.0, 1.0])


# ============ 基础数学 ============

def quat_angle_deg(q0, q1) -> float:
    d = float(np.dot(q0, q1))
    d = max(-1.0, min(1.0, abs(d)))
    return float(np.degrees(2.0 * np.arccos(d)))


def slerp(q0, q1, t):
    d = float(np.dot(q0, q1))
    if d < 0:
        q1 = -q1
        d = -d
    if d > 0.9995:
        r = q0 + t * (q1 - q0)
        n = np.linalg.norm(r)
        return r / n if n > 1e-12 else q0.copy()
    theta = np.arccos(max(-1.0, min(1.0, d)))
    s = np.sin(theta)
    return (np.sin((1.0 - t) * theta) / s) * q0 + (np.sin(t * theta) / s) * q1


def quat_mul(a, b):
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
    n[n < 1e-12] = 1.0
    return q / n


# ============ 抽稀（RDP） ============

def _rdp_quat(quats: np.ndarray, thr_deg: float) -> np.ndarray:
    T = len(quats)
    keep = np.zeros(T, dtype=bool)
    keep[0] = keep[T - 1] = True
    stack = [(0, T - 1)]
    while stack:
        f0, f1 = stack.pop()
        if f1 <= f0 + 1:
            continue
        q0, q1 = quats[f0], quats[f1]
        span = f1 - f0
        max_err, max_i = -1.0, -1
        for i in range(f0 + 1, f1):
            exp = slerp(q0, q1, (i - f0) / span)
            e = quat_angle_deg(quats[i], exp)
            if e > max_err:
                max_err, max_i = e, i
        if max_err > thr_deg and max_i > 0:
            keep[max_i] = True
            stack.append((f0, max_i))
            stack.append((max_i, f1))
    return keep


def _rdp_vec(vecs: np.ndarray, thr: float) -> np.ndarray:
    T = len(vecs)
    keep = np.zeros(T, dtype=bool)
    keep[0] = keep[T - 1] = True
    stack = [(0, T - 1)]
    while stack:
        f0, f1 = stack.pop()
        if f1 <= f0 + 1:
            continue
        v0, v1 = vecs[f0], vecs[f1]
        span = f1 - f0
        max_err, max_i = -1.0, -1
        for i in range(f0 + 1, f1):
            exp = v0 + ((i - f0) / span) * (v1 - v0)
            e = float(np.linalg.norm(vecs[i] - exp))
            if e > max_err:
                max_err, max_i = e, i
        if max_err > thr and max_i > 0:
            keep[max_i] = True
            stack.append((f0, max_i))
            stack.append((max_i, f1))
    return keep


def rot_threshold(en: str) -> float:
    if any(f in en for f in ("thumb", "index", "middle", "ring", "little")):
        return THR_FINGER
    if any(s in en for s in ("center", "waist", "upper_body", "neck", "head")):
        return THR_TORSO
    if en.startswith("foot"):
        return THR_FOOT
    return THR_LIMB


# ============ 骨骼表 ============

def load_skeleton() -> list[str]:
    """返回按固定顺序排列的英文字骨名列表。"""
    smap = json.loads((DATA / "skeleton_map.json").read_text(encoding="utf-8"))
    order_jp = smap["order"]
    jp_to_en = smap["jp_to_en"]
    return [jp_to_en[jp] for jp in order_jp]


MIRROR_MAP_CACHE: dict[str, str] | None = None


def mirror_name(en: str) -> str:
    global MIRROR_MAP_CACHE
    if MIRROR_MAP_CACHE is None:
        bones = load_skeleton()
        m = {}
        for b in bones:
            if b.endswith("_l"):
                m[b] = b[:-2] + "_r"
            elif b.endswith("_r"):
                m[b] = b[:-2] + "_l"
            else:
                m[b] = b
        MIRROR_MAP_CACHE = m
    return MIRROR_MAP_CACHE[en]


# ============ expand / compress ============

def expand(doc: dict, bones: list[str] | None = None
           ) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """关键帧 doc -> (rot[T,B,4], pos[T,B,3], bones)。缺失骨骼填单位四元数/零位置。"""
    if bones is None:
        bones = load_skeleton()
    T = doc["duration_frames"]
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
            # 符号统一后逐帧 slerp
            for i in range(1, len(vals)):
                if np.dot(vals[i], vals[i - 1]) < 0:
                    vals[i] *= -1
            t = 0
            for ki in range(len(frames) - 1):
                f0, f1 = int(frames[ki]), int(frames[ki + 1])
                span = f1 - f0
                q0, q1 = vals[ki], vals[ki + 1]
                for f in range(f0, f1):
                    tt = 0.0 if span == 0 else (f - f0) / span
                    rot[f, bi] = slerp(q0, q1, tt)
                t = f1
            rot[int(frames[-1]), bi] = vals[-1]
            # 末帧之后（若有）保持末值
            if int(frames[-1]) + 1 < T:
                rot[int(frames[-1]) + 1:, bi] = vals[-1]
        else:
            t = np.arange(T, dtype=np.float64)
            for c in range(3):
                pos[:, bi, c] = np.interp(t, frames, vals[:, c])

    return rot, pos, bones


def compress(rot: np.ndarray, pos: np.ndarray, bones: list[str],
             net_displacement: list[float] | None = None) -> dict:
    """逐帧数组 -> 关键帧 doc。"""
    T, B = rot.shape[0], rot.shape[1]
    tracks = []

    for bi, en in enumerate(bones):
        quats = rot[:, bi]
        keep = _rdp_quat(quats, rot_threshold(en))
        idx = np.nonzero(keep)[0]
        # 判定是否恒定
        if len(idx) <= 2:
            span_err = max(
                (quat_angle_deg(quats[0], quats[i]) for i in range(T)),
                default=0.0)
            if span_err < 0.02:
                continue
        keys = [[int(f)] + [round(float(v), 6) for v in quats[f]] for f in idx]
        tracks.append({"bone": en, "channel": "rot", "keys": keys})

        if en in POS_BONES:
            vecs = pos[:, bi]
            if np.abs(vecs).max() > 1e-6:
                kp = _rdp_vec(vecs, THR_POS)
                idp = np.nonzero(kp)[0]
                pkeys = [[int(f)] + [round(float(v), 6) for v in vecs[f]]
                         for f in idp]
                tracks.append({"bone": en, "channel": "pos", "keys": pkeys})

    return {
        "fps": 30,
        "duration_frames": T,
        "net_displacement": net_displacement or [0.0, 0.0, 0.0],
        "tracks": tracks,
    }


# ============ 调制操作 ============

def time_scale(doc: dict, speed: float) -> dict:
    """时间缩放。speed=2 快一倍（帧数减半），0.5 慢一倍。"""
    if speed <= 0:
        raise ValueError("speed 必须 > 0")
    rot, pos, bones = expand(doc)
    T_old = rot.shape[0]
    T_new = max(2, int(round(T_old / speed)))

    t_src = np.linspace(0.0, T_old - 1, T_new)
    rot_new = np.zeros((T_new, rot.shape[1], 4), dtype=np.float64)
    pos_new = np.zeros((T_new, pos.shape[1], 3), dtype=np.float64)

    for b in range(rot.shape[1]):
        for i, ts in enumerate(t_src):
            f0 = int(np.floor(ts))
            f1 = min(f0 + 1, T_old - 1)
            frac = ts - f0
            rot_new[i, b] = slerp(rot[f0, b], rot[f1, b], frac)
            pos_new[i, b] = pos[f0, b] + frac * (pos[f1, b] - pos[f0, b])

    nd = doc.get("net_displacement", [0.0, 0.0, 0.0])
    nd_scaled = [round(v / speed, 4) for v in nd]  # 位移按时间同比缩放
    return compress(rot_new, pos_new, bones, nd_scaled)


def amplitude_scale(doc: dict, strength: float) -> dict:
    """幅度缩放（相对首帧）。strength=1 原样，0.5 幅度减半，0 完全静止。"""
    if strength < 0:
        raise ValueError("strength 必须 >= 0")
    rot, pos, bones = expand(doc)
    T = rot.shape[0]

    rot_out = np.zeros_like(rot)
    pos_out = np.zeros_like(pos)
    for b in range(rot.shape[1]):
        q0 = rot[0, b]
        q0c = quat_conj(q0)
        for f in range(T):
            rel = quat_mul(q0c, rot[f, b])
            rel_s = slerp(_IDENTITY, rel, strength)
            rot_out[f, b] = quat_normalize(quat_mul(q0, rel_s))
        # 位置相对首帧缩放
        p0 = pos[0, b]
        pos_out[:, b] = p0 + strength * (pos[:, b] - p0)

    nd = doc.get("net_displacement", [0.0, 0.0, 0.0])
    nd_s = [round(v * strength, 4) for v in nd]
    return compress(rot_out, pos_out, bones, nd_s)


def mirror(doc: dict) -> dict:
    """左右镜像。骨骼 l<->r 互换，四元数 (x,-y,-z,w)，位置 (-x,y,z)。"""
    bones = load_skeleton()
    rot, pos, _ = expand(doc, bones)
    index = {b: i for i, b in enumerate(bones)}

    rot_out = np.zeros_like(rot)
    pos_out = np.zeros_like(pos)

    for bi, en in enumerate(bones):
        target = mirror_name(en)
        ti = index[target]
        q = rot[:, bi]
        # 镜像四元数
        qm = np.empty_like(q)
        qm[:, 0] = q[:, 0]
        qm[:, 1] = -q[:, 1]
        qm[:, 2] = -q[:, 2]
        qm[:, 3] = q[:, 3]
        rot_out[:, ti] = qm
        # 镜像位置
        pm = pos[:, bi].copy()
        pm[:, 0] = -pm[:, 0]
        pos_out[:, ti] = pm

    nd = doc.get("net_displacement", [0.0, 0.0, 0.0])
    nd_m = [round(-nd[0], 4), round(nd[1], 4), round(nd[2], 4)]
    return compress(rot_out, pos_out, bones, nd_m)


# ============ 拼接 ============

# 运动匹配用的关键骨骼（代表"整体姿态像不像"）
KEY_BONES = ["hand_l", "hand_r", "foot_l", "foot_r",
             "head", "upper_body", "center"]


def _key_indices(bones):
    return [bones.index(b) for b in KEY_BONES if b in bones]


def _pose_distance(a_rot, b_rot, kidx):
    """两组姿态的角度距离（度）。a_rot, b_rot: [B,4]"""
    total = 0.0
    for bi in kidx:
        total += quat_angle_deg(a_rot[bi], b_rot[bi])
    return total


def find_best_start(a_last_rot, b_rot, bones, max_start_ratio=0.5,
                    progress_penalty=10.0, min_gain_deg=2.0):
    """在 b_rot 里搜最像 a_last_rot 的帧作为起点（运动匹配核心）。

    a_last_rot: 前一段末帧 [B,4]
    b_rot:      后一段全部帧 [T,B,4]
    max_start_ratio:  只搜前多少比例的帧（避免动作被截断太多）
    progress_penalty: 每往后 1 帧的扣分（度），偏好靠前的帧
    min_gain_deg:     最小改善阈值。若最佳帧比第 0 帧改善不足此值，
                      返回 0（不为微小收益丢掉动作开头）
    返回: (最佳帧号, 得分)
    """
    kidx = _key_indices(bones)
    T = b_rot.shape[0]
    if T <= 1 or not kidx:
        return 0, 0.0
    max_f = max(1, int(T * max_start_ratio))

    d0 = _pose_distance(a_last_rot, b_rot[0], kidx)
    best_f, best_score = 0, d0
    for f in range(1, max_f):
        dist = _pose_distance(a_last_rot, b_rot[f], kidx)
        score = dist + (f / T) * progress_penalty
        if score < best_score:
            best_score, best_f = score, f

    # 改善保护：收益不足则从第 0 帧开始（保证动作完整）
    gain = d0 - _pose_distance(a_last_rot, b_rot[best_f], kidx)
    if best_f > 0 and gain < min_gain_deg:
        return 0, d0
    return best_f, best_score


def _smoothstep(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def concat(docs: list[dict], transition_frames: int = 8,
           motion_matched: bool = False, max_start_ratio: float = 0.5,
           progress_penalty: float = 10.0, min_gain_deg: float = 2.0) -> dict:
    """顺序拼接多段。段间插入过渡，使后段首帧对齐前段末帧。

    过渡方式：计算 delta = A_last * conj(B_first)，
    在 B 的前 transition_frames 帧内把 delta 平滑衰减到单位四元数。

    motion_matched=True 启用运动匹配：不再固定用后段第 0 帧，
    而是搜与 A 末帧最接近的帧作为起点，让接缝更自然。
    """
    if not docs:
        raise ValueError("docs 不能为空")
    if len(docs) == 1:
        return docs[0]

    bones = load_skeleton()
    rot_parts = []
    pos_parts = []
    nd_total = np.zeros(3)

    for i, d in enumerate(docs):
        r, p, _ = expand(d, bones)
        nd_total += np.array(d.get("net_displacement", [0, 0, 0]))

        if i == 0:
            rot_parts.append(r)
            pos_parts.append(p)
            continue

        prev_rot = rot_parts[-1]
        prev_pos = pos_parts[-1]
        a_last = prev_rot[-1]        # [B,4]
        a_last_pos = prev_pos[-1]    # [B,3]

        # 运动匹配：搜最像当前末帧的起点，截断前面的帧
        if motion_matched and r.shape[0] > 2:
            start_f, _score = find_best_start(
                a_last, r, bones, max_start_ratio,
                progress_penalty, min_gain_deg)
            if start_f > 0:
                r = r[start_f:]
                p = p[start_f:]

        b_first = r[0]               # [B,4]
        b_first_pos = p[0]           # [B,3]

        n = min(transition_frames, r.shape[0])
        r_adj = r.copy()
        p_adj = p.copy()
        for b in range(r.shape[1]):
            delta = quat_mul(a_last[b], quat_conj(b_first[b]))
            delta_pos = a_last_pos[b] - b_first_pos[b]
            for f in range(n):
                w = _smoothstep(1.0 - f / max(1, n - 1))
                # 从 delta 平滑过渡到 identity
                off = slerp(_IDENTITY, delta, w)
                r_adj[f, b] = quat_normalize(quat_mul(off, r[f, b]))
                p_adj[f, b] = p[f, b] + w * delta_pos
        rot_parts.append(r_adj)
        pos_parts.append(p_adj)

    rot_all = np.concatenate(rot_parts, axis=0)
    pos_all = np.concatenate(pos_parts, axis=0)
    nd = [round(float(v), 4) for v in nd_total]
    return compress(rot_all, pos_all, bones, nd)


def resample(doc: dict, target_frames: int) -> dict:
    """重采样到指定总帧数（不改速度语义，只改长度）。"""
    rot, pos, bones = expand(doc)
    T_old = rot.shape[0]
    if target_frames == T_old:
        return doc
    t_src = np.linspace(0.0, T_old - 1, target_frames)
    rot_new = np.zeros((target_frames, rot.shape[1], 4), dtype=np.float64)
    pos_new = np.zeros((target_frames, pos.shape[1], 3), dtype=np.float64)
    for b in range(rot.shape[1]):
        for i, ts in enumerate(t_src):
            f0 = int(np.floor(ts))
            f1 = min(f0 + 1, T_old - 1)
            frac = ts - f0
            rot_new[i, b] = slerp(rot[f0, b], rot[f1, b], frac)
            pos_new[i, b] = pos[f0, b] + frac * (pos[f1, b] - pos[f0, b])
    nd = doc.get("net_displacement", [0.0, 0.0, 0.0])
    return compress(rot_new, pos_new, bones, nd)


# ============ 加载 ============

def load_keyframe(key: str) -> dict:
    path = DATA / "keyframes" / f"{key}.json"
    return json.loads(path.read_text(encoding="utf-8"))