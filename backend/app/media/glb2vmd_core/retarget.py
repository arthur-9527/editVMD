# coding: utf-8
"""Mixamo 骨架 -> MMD 姿态 重定向核心。

坐标换算 (glTF: Y-up 右手  ->  MMD/PMX: Y-up 左手):
    位置:  (x, y, z)   ->  (x, y, -z)          # A = diag(1,1,-1)
    四元数: (x,y,z,w)  ->  (-x, -y, z, w)      # = A R A^-1

旋转重定向（每根被映射的 MMD 骨 m ← 源骨 s）:
    Δ(t)  = R_src(t) · R_src_bind^-1            # 源骨世界旋转相对 bind 的变化(含 roll)
    T_b   = Swing(d_rest(m) → a_bind(s))         # 一次性「静止对齐」(只算一次, 稳定)
    Q_world(m,t) = Δ(t) ∘ T_b                    # 方向精确 + roll 精确跟随源
    q_local(m,t) = Q_world(最近的被映射祖先)^-1 · Q_world(m,t)

    要点:
      * 方向取「源骨自身 Y 轴」(骨骼轴)，不能用子关节位置差
        (mixamo 的 Head→HeadTop_End / Neck→Head 偏离骨轴 25.8°/16.9°, 会把头压低)
      * roll(绕骨轴自转)必须传递，否则纯 swing 会让掌心翻转 ±177°
        (实测源前臂旋前只有 ±34°)。因为用 Δ 形式，旋前会正确地落在「肘部」
      * 手上再乘一个「常量掌面对齐」 φ(每侧一次)，让模型静止掌心朝向 = 源 bind 掌心朝向
        φ 用「腕-中指根-小指根」叉乘的掌面法线求；叉乘是赝矢量，必须换轴后再叉乘

骨盆/位移：
    腰     <- Hips 的世界旋转（绝对；mixamo Hips 静止旋转 ≈ 单位阵）
    センター <- (P_hip(t) - P_hip(ref)) 换轴 * s
    (ref 默认第 0 帧，保持模型自己的站姿宽度，避免双脚内收)

腿部（足ＩＫ + 腿部 FK 初值协同 —— 崴脚根除方案）：
    足ＩＫ    <- (P_ankle(t) - P_ankle(ref)) 换轴 * s   # 位置钉死脚踝(不滑步/不悬浮)
              旋转 = swing(d_m -> Δ足首FK(t)·d_m)      # 只用于带动子骨 つま先ＩＫ
    つま先ＩＫ 完全不写键: 它是 足ＩＫ 的子骨, 静止偏移恰为 足首->つま先(模型自身脚长),
              被足ＩＫ旋转带到 toe_target = 踝目标 + Δ足首FK·(足首->つま先)
              => 目标与 FK 脚向严格一致(首帧恒等), 1-link 残差≈0, 不再硬掰脚踝。
    足/ひざ/足首 <- UpLeg/Leg/Foot 的「相对 ref 帧旋转增量」Δ(t)=R(t)·R(ref)^-1:
              首帧=模型自身站姿(高跟形态/贴地不变), 之后跟随动捕 ——
              给 MMD 的 IK 解算提供正确的膝盖弯曲平面与脚向初值。
    旧写法(腿无 FK + つま先ＩＫ 写平移差 + 足ＩＫ 对齐高跟静止向量)是「崴脚」的根源。
"""
import numpy as np

from .glb_reader import (
    load_glb,
    mat_to_quat,
    quat_from_two_vectors,
    quat_inv,
    quat_mul,
    quat_normalize,
    quat_to_mat,
)
from .pmx_reader import PmxModelInfo
from . import mapping as mp

_AXIS = np.array([1.0, 1.0, -1.0])
_IDQ = np.array([0.0, 0.0, 0.0, 1.0])


def to_mmd_vec(v):
    return np.asarray(v, dtype=np.float64) * _AXIS


def to_mmd_quat(q):
    return np.array([-q[0], -q[1], q[2], q[3]], dtype=np.float64)


def to_mmd_mat(m):
    return m * np.outer(_AXIS, _AXIS)


class _Entry(object):
    __slots__ = ("mmd", "src", "src_child", "rest_dir", "parent", "special")

    def __init__(self, mmd, src=None, src_child=None, rest_dir=None,
                 parent=None, special=False):
        self.mmd = mmd
        self.src = src
        self.src_child = src_child
        self.rest_dir = rest_dir
        self.parent = parent
        self.special = special


class RetargetResult(object):
    def __init__(self):
        self.frames = 0
        self.fps = 30.0
        self.scale = 1.0
        self.rot = {}     # mmd 骨名 -> (F,4) 局部四元数
        self.pos = {}     # mmd 骨名 -> (F,3) 位移
        self.report = {}


def _norm(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else np.array([0.0, 0.0, 0.0])


def _quat_from_axis_angle(axis, angle):
    a = _norm(np.asarray(axis, dtype=np.float64))
    s = np.sin(angle * 0.5)
    return np.array([a[0] * s, a[1] * s, a[2] * s, np.cos(angle * 0.5)])


def _signed_angle_about(axis, v_from, v_to):
    """v_from -> v_to 绕 axis 的带符号角(弧度)，先把两个向量投影到垂直 axis 的平面。"""
    a = _norm(np.asarray(axis, dtype=np.float64))
    v = np.asarray(v_from, dtype=np.float64)
    w = np.asarray(v_to, dtype=np.float64)
    v = v - a * np.dot(v, a)
    w = w - a * np.dot(w, a)
    nv, nw = np.linalg.norm(v), np.linalg.norm(w)
    if nv < 1e-4 or nw < 1e-4:
        return None
    return float(np.arctan2(np.dot(a, np.cross(v, w)), np.dot(v, w)))


def build_entries(pmx):
    """构造「MMD 骨 <- 源骨」的重定向计划。"""
    entries = []
    missing_pmx = []
    aim_map = mp.build_aim_map()
    seen = set()
    for mmd_name, src_name, src_child in aim_map:
        if mmd_name in seen:
            continue
        seen.add(mmd_name)
        if not pmx.has(mmd_name):
            missing_pmx.append(mmd_name)
            continue
        child = mp.MMD_AIM_CHILD.get(mmd_name)
        if child and pmx.has(child):
            d = pmx.child_direction(mmd_name, child)
        else:
            d = _norm(np.array(mp.FIXED_DIR.get(mmd_name, (0.0, 1.0, 0.0)),
                               dtype=np.float64))
        entries.append(_Entry(mmd_name, src_name, src_child, d))
    entries.append(_Entry(mp.ROOT_ROT_BONE, special=True))

    mapped = set(e.mmd for e in entries)
    for e in entries:
        p = pmx.name_to_bone[e.mmd].parent
        while p >= 0:
            pn = pmx.bones[p].name
            if pn in mapped:
                e.parent = pn
                break
            p = pmx.bones[p].parent
    return entries, missing_pmx


def default_scale(sk, pmx, ref_frame=0, margin=0.98):
    """按「源最大髋-踝距离 * s <= MMD 腿长」自动选缩放，保证 IK 够得到。"""
    leg = pmx.leg_length("左")
    idx_up, idx_ft = sk.joint_index["LeftUpLeg"], sk.joint_index["LeftFoot"]
    dmax = 0.0
    for f in range(sk.frames):
        w = sk.world_matrices(f)
        d = np.linalg.norm(w[idx_ft][:3, 3] - w[idx_up][:3, 3])
        dmax = max(dmax, d)
    hip_ratio = pmx.vec("腰")[1] / max(1e-6, sk.joint_position(ref_frame, "Hips")[1])
    return margin * leg / max(1e-6, dmax), hip_ratio


def retarget(glb_path, pmx_path, scale=None, ref_frame=0, verbose=True,
             dir_source="axis", use_twist=True, head="aim", hand="aim",
             palm_align=True):
    sk = load_glb(glb_path)
    pmx = PmxModelInfo(pmx_path)
    entries, missing_pmx = build_entries(pmx)

    # 兜底: 复刻 text2VMD 的「该骨不写旋转」(局部单位四元数)
    identity_bones = set()
    if head == "none":
        identity_bones |= {"首", "頭"}
    if hand == "none":
        identity_bones |= {"左手首", "右手首"}

    s_leg, hip_ratio = default_scale(sk, pmx, ref_frame)
    if scale is None:
        scale = s_leg
    scale = float(scale)

    res = RetargetResult()
    res.frames = sk.frames
    res.fps = sk.fps
    res.scale = scale
    F = sk.frames

    # 每个被写键的骨都有旋转轨道（默认单位）
    for e in entries:
        res.rot[e.mmd] = np.tile(_IDQ, (F, 1))
    res.rot[mp.ROOT_POS_BONE] = np.tile(_IDQ, (F, 1))
    res.pos[mp.ROOT_POS_BONE] = np.zeros((F, 3))
    for ik_name, _, _, _ in mp.LEG_IK:
        res.pos[ik_name] = np.zeros((F, 3))
    # 足ＩＫ 旋转轨道（带动子骨 つま先ＩＫ 目标绕踝转动）
    for ik_name in mp.FOOT_IK_ROT:
        res.rot[ik_name] = np.tile(_IDQ, (F, 1))
    # 腿部 FK 初值轨道（足/ひざ/足首）
    for mmd_bone, _src in mp.LEG_FK:
        res.rot[mmd_bone] = np.tile(_IDQ, (F, 1))

    w_ref = sk.world_matrices(ref_frame)
    src_names = set([mp.SRC_HIPS])
    for e in entries:
        if not e.special:
            src_names.add(e.src)
            src_names.add(e.src_child)
    for _, _, sj, _ in mp.LEG_IK:
        src_names.add(sj)
    for triple in mp.SRC_PALM.values():
        src_names.update(triple)
    src_names = {n for n in src_names if n in sk.joint_index}
    ref_pos = {n: w_ref[sk.joint_index[n]][:3, 3] for n in src_names}

    # 源骨 bind 世界旋转(MMD 轴) —— twist 的参考基准
    src_rot_bind = {}
    for e in entries:
        if not e.special:
            src_rot_bind[e.src] = to_mmd_mat(sk.rest_world_rotation(e.src))
    # 腿部 FK 增量基准: 源腿骨在 ref 帧的世界旋转(MMD 轴)
    src_leg_rot_ref = {}
    for _m, _s in mp.LEG_FK:
        if _s in sk.joint_index:
            src_leg_rot_ref[_s] = to_mmd_mat(w_ref[sk.joint_index[_s]][:3, :3])
    # 模型(MMD)静止掌面法线 + 掌面 roll 相关的骨 → 定标基准
    mmd_palm_rest = {}
    for key, (a, b, c) in mp.MMD_PALM.items():
        if pmx.has(a) and pmx.has(b) and pmx.has(c):
            # 与源侧同构: 先在 MMD 轴下取向量再叉乘
            mmd_palm_rest[key] = _norm(np.cross(pmx.vec(b) - pmx.vec(a),
                                                pmx.vec(c) - pmx.vec(a)))
    palm_bone_side = {}
    for _n in ("ひじ", "手首", "親指０", "親指１", "親指２",
               "人指１", "人指２", "人指３", "中指１", "中指２", "中指３",
               "薬指１", "薬指２", "薬指３", "小指１", "小指２", "小指３"):
        palm_bone_side["左" + _n] = "左手首"
        palm_bone_side["右" + _n] = "右手首"

    # 每个骨的「一次性静止对齐」T_b
    # 之后 Q_world(t) = Δ(t) ∘ T_b (Δ = 源骨世界旋转相对 bind 的变化量)
    # 方向精确 + roll 精确跟随源(旋前落在肘部), 且不会出现逐帧摆动轴退化
    # 手上再加一个「常量掌面对齐」: 让模型静止掌心朝向 = 源 bind 掌心朝向
    side_phi = {}
    if palm_align:
        wr = sk.rest_world_matrices()
        for key, (ha, hb, hc) in mp.SRC_PALM.items():
            if key not in mmd_palm_rest:
                continue
            hm, mm_, pm_ = mp.MMD_PALM[key]
            n_model = mmd_palm_rest[key]
            Rb = to_mmd_mat(sk.rest_world_rotation(ha))
            a_bind = Rb[:, 1]
            p = {k: wr[sk.joint_index[k]][:3, 3] for k in (ha, hb, hc)}
            # 叉乘是赝矢量: 必须先把向量换到 MMD 轴再叉乘, 才能与模型侧法线同向
            n_src = _norm(np.cross(to_mmd_vec(p[hb] - p[ha]),
                                   to_mmd_vec(p[hc] - p[ha])))
            d_rest = _norm(np.array(pmx.pos(mm_)) - np.array(pmx.pos(hm)))
            pred = quat_to_mat(quat_from_two_vectors(d_rest, a_bind)) @ n_model
            phi = _signed_angle_about(a_bind, pred, n_src)
            side_phi[key] = 0.0 if phi is None else phi

    t_bind = {}
    for e in entries:
        if e.special:
            continue
        a_b = src_rot_bind[e.src][:, 1]
        t = quat_from_two_vectors(e.rest_dir, a_b)
        key = palm_bone_side.get(e.mmd)
        if key is not None and key in side_phi:
            t = quat_mul(_quat_from_axis_angle(a_b, side_phi[key]), t)
        t_bind[e.mmd] = t

    reach = []
    footik_angle = []  # 报告用: 足ＩＫ 旋转角(=脚向变化幅度)
    for f in range(F):
        w = sk.world_matrices(f)
        pos = {n: w[sk.joint_index[n]][:3, 3] for n in src_names}

        qworld = {}
        R_hips = to_mmd_mat(w[sk.joint_index[mp.SRC_HIPS]][:3, :3])
        qworld[mp.ROOT_ROT_BONE] = quat_normalize(mat_to_quat(R_hips))
        for e in entries:
            if e.special:
                continue
            if dir_source == "axis":
                # 方向 = 源骨自身 Y 轴；roll 跟随源(Δ)
                S_cur = to_mmd_mat(w[sk.joint_index[e.src]][:3, :3])
                if not use_twist:
                    qworld[e.mmd] = quat_from_two_vectors(e.rest_dir, S_cur[:, 1])
                else:
                    delta = S_cur @ src_rot_bind[e.src].T
                    qworld[e.mmd] = quat_mul(mat_to_quat(delta), t_bind[e.mmd])
            else:
                # 兼容旧行为: 方向 = 子关节位置差, 纯 swing
                d_src = _norm(to_mmd_vec(pos[e.src_child] - pos[e.src]))
                qworld[e.mmd] = quat_from_two_vectors(e.rest_dir, d_src)

        # 兜底骨: 继承父级(= 局部单位旋转)
        for e in entries:
            if e.mmd in identity_bones:
                qworld[e.mmd] = qworld.get(e.parent, _IDQ) if e.parent else _IDQ

        for e in entries:
            q = qworld[e.mmd]
            if e.parent is not None and e.parent in qworld:
                q = quat_mul(quat_inv(qworld[e.parent]), q)
            res.rot[e.mmd][f] = quat_normalize(q)

        res.pos[mp.ROOT_POS_BONE][f] = (
            to_mmd_vec(pos[mp.SRC_HIPS] - ref_pos[mp.SRC_HIPS]) * scale
        )
        for ik_name, _, sj, _ in mp.LEG_IK:
            res.pos[ik_name][f] = to_mmd_vec(pos[sj] - ref_pos[sj]) * scale

        # 腿部 FK: Q(t) = 源骨世界旋转相对 ref 帧的增量(首帧=单位)
        qleg = {}
        for mmd_bone, src_bone in mp.LEG_FK:
            S_cur = to_mmd_mat(w[sk.joint_index[src_bone]][:3, :3])
            qleg[mmd_bone] = quat_normalize(
                mat_to_quat(S_cur @ src_leg_rot_ref[src_bone].T))
        # 目标世界姿态 = Q(t) · W_ref, 其中 W_ref = 腰在 ref 帧的世界旋转
        # (腰 写的是 Hips 绝对旋转; ref 帧腿部链上局部全为 I, 世界=W_ref)
        W_ref_mat = to_mmd_mat(w_ref[sk.joint_index[mp.SRC_HIPS]][:3, :3])
        q_wref = quat_normalize(mat_to_quat(W_ref_mat))
        R_hips_q = quat_normalize(mat_to_quat(R_hips))
        for side in ("左", "右"):
            b_up, b_kn, b_an = side + "足", side + "ひざ", side + "足首"
            # 链: ...腰(=R_hips) -> 下半身(I) -> 足 -> ひざ -> 足首
            # 局部 = 父链世界旋转^-1 · 自身目标世界旋转
            w_up = quat_mul(qleg[b_up], q_wref)
            w_kn = quat_mul(qleg[b_kn], q_wref)
            w_an = quat_mul(qleg[b_an], q_wref)
            res.rot[b_up][f] = quat_normalize(quat_mul(quat_inv(R_hips_q), w_up))
            res.rot[b_kn][f] = quat_normalize(quat_mul(quat_inv(w_up), w_kn))
            res.rot[b_an][f] = quat_normalize(quat_mul(quat_inv(w_kn), w_an))

        # 足ＩＫ 旋转: 让子骨 つま先ＩＫ 的目标方向 = FK 足首的目标世界方向
        # (w_an 已含 W_ref 基底) => つま先ＩＫ 对 足首 的残差恒为 0, 不与 FK 抢脚踝
        for ik_name, (_, _, m_ankle, m_toe) in mp.FOOT_IK_ROT.items():
            d_m = _norm(pmx.vec(m_toe) - pmx.vec(m_ankle))
            w_an = quat_mul(qleg[ik_name[0] + "足首"], q_wref)
            d_fk = quat_to_mat(w_an) @ d_m
            res.rot[ik_name][f] = quat_normalize(
                quat_from_two_vectors(d_m, d_fk))
            footik_angle.append(float(np.degrees(np.arccos(
                np.clip(np.dot(d_m, d_fk), -1.0, 1.0)))))

        hip = pmx.vec("左足") + res.pos[mp.ROOT_POS_BONE][f]
        ankle = pmx.vec("左足首") + res.pos["左足ＩＫ"][f]
        reach.append(float(np.linalg.norm(ankle - hip)))

    leg = pmx.leg_length("左")
    res.report = {
        "scale_used": scale,
        "scale_leg_limit": float(s_leg),
        "scale_hip_ratio": float(hip_ratio),
        "mmd_leg_length": float(leg),
        "max_reach_ratio": (max(reach) / leg) if leg else 0.0,
        "missing_in_pmx": missing_pmx,
        "bones_written": sorted(res.rot.keys()),
        "ik_written": [k for k, _, _, _ in mp.LEG_IK],
        "dir_source": dir_source,
        "use_twist": bool(use_twist),
        "head": head,
        "hand": hand,
        "palm_align": bool(palm_align),
        "palm_phi_deg": {k: float(np.degrees(v)) for k, v in side_phi.items()},
        "foot_ik_swing_deg": {
            "mean": float(np.mean(footik_angle)) if footik_angle else 0.0,
            "max": float(np.max(footik_angle)) if footik_angle else 0.0,
        },
        "toe_target_length": {  # つま先ＩＫ 目标到踝目标的距离 = 模型自身脚长
            "左": float(np.linalg.norm(pmx.vec("左つま先") - pmx.vec("左足首"))),
            "右": float(np.linalg.norm(pmx.vec("右つま先") - pmx.vec("右足首"))),
        },
    }
    if verbose:
        r = res.report
        print("[retarget] frames=%d  fps=%.2f" % (res.frames, res.fps))
        print("[retarget] scale=%.3f  (leg-limit %.3f / hip-ratio %.3f)"
              % (r["scale_used"], r["scale_leg_limit"], r["scale_hip_ratio"]))
        print("[retarget] max(hip->ankle)/leg = %.3f   (<=1 才够得到)"
              % r["max_reach_ratio"])
        if missing_pmx:
            print("[retarget] WARN PMX 缺骨: %s" % missing_pmx)
        print("[retarget] 旋转键 %d 根: %s"
              % (len(r["bones_written"]), " ".join(r["bones_written"])))
        print("[retarget] 位移键: %s" % " ".join(sorted(res.pos.keys())))
    return res
