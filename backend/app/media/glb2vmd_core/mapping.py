# coding: utf-8
"""Mixamo(mixamorig:*) -> MMD 标准骨骼 映射表。

说明:
  * MMD 骨只用「日文名」匹配（本模型的 english_name 数据是错的，不可用）。
  * 每项含一个 src_child：用于取「源骨自身段方向」(P_child - P_self)。
  * 未列出的 MMD 骨一律保持静止(单位旋转)，不写键；腿由 IK 驱动，不写 FK 键。
"""

# (mmd_bone, mixamo_bone, mixamo_child)
# 中轴
SPINE_MAP = [
    ("上半身", "Spine", "Spine1"),
    ("上半身3", "Spine1", "Spine2"),
    ("上半身2", "Spine2", "Neck"),
    ("首", "Neck", "Head"),
    ("頭", "Head", "HeadTop_End"),
]

# (mmd_left, mmd_right, mixamo_left, mixamo_right, child_suffix_left, child_suffix_right)
# child 用同一侧的下一节
SIDE_MAP = [
    ("左肩", "右肩", "LeftShoulder", "RightShoulder", "LeftArm", "RightArm"),
    ("左腕", "右腕", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm"),
    ("左ひじ", "右ひじ", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand"),
    ("左手首", "右手首", "LeftHand", "RightHand", "LeftHandMiddle1", "RightHandMiddle1"),
    # 手指（MMD 每指 3 节；mixamo 第 4 节是指尖，只用来取方向）
    ("左親指０", "右親指０", "LeftHandThumb1", "RightHandThumb1",
     "LeftHandThumb2", "RightHandThumb2"),
    ("左親指１", "右親指１", "LeftHandThumb2", "RightHandThumb2",
     "LeftHandThumb3", "RightHandThumb3"),
    ("左親指２", "右親指２", "LeftHandThumb3", "RightHandThumb3",
     "LeftHandThumb4", "RightHandThumb4"),
    ("左人指１", "右人指１", "LeftHandIndex1", "RightHandIndex1",
     "LeftHandIndex2", "RightHandIndex2"),
    ("左人指２", "右人指２", "LeftHandIndex2", "RightHandIndex2",
     "LeftHandIndex3", "RightHandIndex3"),
    ("左人指３", "右人指３", "LeftHandIndex3", "RightHandIndex3",
     "LeftHandIndex4", "RightHandIndex4"),
    ("左中指１", "右中指１", "LeftHandMiddle1", "RightHandMiddle1",
     "LeftHandMiddle2", "RightHandMiddle2"),
    ("左中指２", "右中指２", "LeftHandMiddle2", "RightHandMiddle2",
     "LeftHandMiddle3", "RightHandMiddle3"),
    ("左中指３", "右中指３", "LeftHandMiddle3", "RightHandMiddle3",
     "LeftHandMiddle4", "RightHandMiddle4"),
    ("左薬指１", "右薬指１", "LeftHandRing1", "RightHandRing1",
     "LeftHandRing2", "RightHandRing2"),
    ("左薬指２", "右薬指２", "LeftHandRing2", "RightHandRing2",
     "LeftHandRing3", "RightHandRing3"),
    ("左薬指３", "右薬指３", "LeftHandRing3", "RightHandRing3",
     "LeftHandRing4", "RightHandRing4"),
    ("左小指１", "右小指１", "LeftHandPinky1", "RightHandPinky1",
     "LeftHandPinky2", "RightHandPinky2"),
    ("左小指２", "右小指２", "LeftHandPinky2", "RightHandPinky2",
     "LeftHandPinky3", "RightHandPinky3"),
    ("左小指３", "右小指３", "LeftHandPinky3", "RightHandPinky3",
     "LeftHandPinky4", "RightHandPinky4"),
]

# 骨盆/中轴控制骨
ROOT_ROT_BONE = "腰"          # 承接 Hips 的世界旋转
ROOT_POS_BONE = "センター"    # 承接 Hips 的世界位移
SRC_HIPS = "Hips"

# 腿部 IK 目标骨: (mmd_ik_bone, mmd_fk_child, mixamo_joint)
# 只写 足ＩＫ（位置=踝位移, 旋转=让 つま先ＩＫ 目标跟随 FK 脚向）。
# つま先ＩＫ 完全不写键 —— 它是 足ＩＫ 的子骨, 静止偏移恰为 足首->つま先(模型自身脚长),
# 由 足ＩＫ 的旋转带动。这样 1-link つま先ＩＫ 的目标与 足首 FK 朝向天然一致,
# 残差为 0, 不会再用「最短弧 Swing」硬掰脚踝 —— 崴脚的根源。
LEG_IK = [
    ("左足ＩＫ", "左足首", "LeftFoot", None),
    ("右足ＩＫ", "右足首", "RightFoot", None),
]

# 腿部 FK 初值: (mmd_bone, src_bone)
# 写「相对 ref 帧的旋转变化」Δ(t)=R_src(t)·R_src(ref)^-1:
#   首帧模型保持自身站姿(脚掌贴地/高跟形态不变), 之后跟随动捕。
# 足   <- UpLeg : 提供正确的膝盖弯曲平面(不再随骨盆乱扭)
# ひざ <- Leg   : 小腿朝向
# 足首 <- Foot  : 脚踝完整朝向(含解剖学 roll) —— 脚的朝向由 FK 精确控制
LEG_FK = [
    ("左足", "LeftUpLeg"),
    ("左ひざ", "LeftLeg"),
    ("左足首", "LeftFoot"),
    ("右足", "RightUpLeg"),
    ("右ひざ", "RightLeg"),
    ("右足首", "RightFoot"),
]

# 足ＩＫ 旋转驱动表: mmd 足ＩＫ -> (源踝, 源趾, 模型踝骨, 模型趾骨)
# 足ＩＫ 旋转 = swing(模型静止足向 d_m -> Δ_足首FK(t)·d_m):
#   让「つま先ＩＫ 目标」精确落在 足首 FK 已经指向的脚尖方向上
#   => つま先ＩＫ 残差恒为 0(不与 FK 抢脚踝), 目标长度恒为模型自身脚长。
FOOT_IK_ROT = {
    "左足ＩＫ": ("LeftFoot", "LeftToeBase", "左足首", "左つま先"),
    "右足ＩＫ": ("RightFoot", "RightToeBase", "右足首", "右つま先"),
}

# 需要「方向对齐」的 MMD 骨 -> 目标子骨（用于校验/预览）
def build_aim_map():
    """返回 [(mmd_bone, src_bone, src_child)]，已展开左右。"""
    out = []
    out.extend(SPINE_MAP)
    for ml, mr, sl, sr, cl, cr in SIDE_MAP:
        out.append((ml, sl, cl))
        out.append((mr, sr, cr))
    return out


# ---- MMD 骨自身的静止方向参考骨 ----
# 值 = 该 MMD 骨指向的子骨名；None 表示用固定向量（见 retarget.FIXED_DIR）
_ARM_AIM = {
    "上半身": "上半身3",
    "上半身3": "上半身2",
    "上半身2": "首",
    "首": "頭",
    "頭": None,
}
_SIDE_ARM = [
    ("左肩", "左肩C"), ("右肩", "右肩C"),
    ("左腕", "左ひじ"), ("右腕", "右ひじ"),
    ("左ひじ", "左手首"), ("右ひじ", "右手首"),
    # 手掌朝向取「中指根部」方向，最接近源 Hand -> Middle1
    ("左手首", "左中指１"), ("右手首", "右中指１"),
]

_FINGER_NAMES = ["人指", "中指", "薬指", "小指"]


def build_mmd_aim_child():
    m = dict(_ARM_AIM)
    for a, b in _SIDE_ARM:
        m[a] = b
    for side in ("左", "右"):
        for fn in _FINGER_NAMES:
            m[side + fn + "１"] = side + fn + "２"
            m[side + fn + "２"] = side + fn + "３"
            m[side + fn + "３"] = side + fn + "先"
        m[side + "親指０"] = side + "親指１"
        m[side + "親指１"] = side + "親指２"
        m[side + "親指２"] = side + "親指先"
    return m


MMD_AIM_CHILD = build_mmd_aim_child()

# 固定方向（拿不到子骨时）
FIXED_DIR = {
    "頭": (0.0, 1.0, 0.0),
}

# ---- 掌面法线定标(roll) ----
# 用「腕-中指根-小指根」三点叉乘 = 掌面法线。源与目标都用同一个语义向量，
# 因此可以直接算出绕骨轴的 roll，不需要猜「模型静止手掌朝哪」。
# 作用骨: 前臂 + 手首(旋前/旋后发生在肘部, 手掌随之翻转)
PALM_ROLL_BONES = {"左ひじ", "右ひじ", "左手首", "右手首"}

# 源: (k=键名, 腕, 中指根, 小指根)  —— mixamo
SRC_PALM = {
    "左手首": ("LeftHand", "LeftHandMiddle1", "LeftHandPinky1"),
    "右手首": ("RightHand", "RightHandMiddle1", "RightHandPinky1"),
}
# 目标: MMD 骨名
MMD_PALM = {
    "左手首": ("左手首", "左中指１", "左小指１"),
    "右手首": ("右手首", "右中指１", "右小指１"),
}


# 源骨 -> 取方向用的「子关节」名（用于 aim 计算）
def build_src_child_map():
    m = {}
    for _, s, c in SPINE_MAP:
        m[s] = c
    for ml, mr, sl, sr, cl, cr in SIDE_MAP:
        m[sl] = cl
        m[sr] = cr
    return m
