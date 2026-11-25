"""MMD 领域知识库（单一真源）—— 给 AI 看 VMD / PMX / 骨骼 / 动作 / 本软件用法。

为什么需要它
------------
AI 做 MMD 动作时最常犯的错是「不知道骨名、不知道哪根轴管什么、不知道 VMD 存四元数」。
本模块把领域知识整理成结构化数据：

* ``core_text()``   —— **精简摘要**，注入系统提示（约 1.5~2 KB，覆盖最高频的知识）。
* ``topic(name)``   —— **章节全文**（Markdown），供 ``get_mmd_knowledge`` 工具按需拉取。
* ``BONE_SPECS``    —— 82 根标准骨骼（日文/英文/中文/父骨/分组/推荐轴/幅度/说明），
                      供 ``list_bones`` 补全英文名与父骨。

与文档同源
----------
``docs/mmd/*.md`` 是人可读版本，内容与本模块对齐；改一处要同步另一处。

轴向约定（MMD / PMX 通用，VMD 里 rotation 是四元数，拆成 YXZ 欧拉后）：
    X 轴：+ 前俯（低头 / 前倾），- 后仰
    Y 轴：+ 左转（角色视角逆时针），- 右转
    Z 轴：+ 左倾（左肩下沉），- 右倾
"""

from __future__ import annotations

from typing import Any

# ------------------------------------------------------------------ 分组名

GROUP_CENTER = "センター"
GROUP_TORSO = "上半身"
GROUP_LOWER = "下半身"
GROUP_ARM = "腕"
GROUP_LEG = "足"
GROUP_IK = "IK"
GROUP_HEAD = "頭部"
GROUP_FACE = "顔"
GROUP_FINGER = "指"
GROUP_OTHER = "その他"

# ------------------------------------------------------------------ 82 根标准骨骼
#
# 结构：(日文, 英文, 中文, 父骨日文 or "", 分组, 轴提示, 幅度提示, 说明)
#
# ★ 顺序 = PMX 标准骨架顺序（babylon-mmd standardBoneObject.ts 实测）。
#   父骨用日文名（"" 表示根）；list_bones 的 parentIndex 才是权威。

BONE_SPECS: list[tuple[str, str, str, str, str, str, str, str]] = [
    # ---------------- 中轴
    ("全ての親", "root", "总根", "", GROUP_CENTER,
     "整体移动/旋转", "位移克制", "最根骨，整体移动/旋转（含 IK）"),
    ("センター", "center", "中心", "全ての親", GROUP_CENTER,
     "位移 X左右/Y升降/Z前后", "蹲 Y -0.5~-1.5", "★ 主要位移骨，整体上下/前后/左右"),
    ("グルーブ", "groove", "重心", "センター", GROUP_CENTER,
     "Z 左倾胯 / Y 左扭胯", "±3~5 / ±10~20", "骨盆倾斜、扭胯、重心晃动"),
    ("腰", "waist", "腰", "グルーブ", GROUP_CENTER,
     "X 前倾 / Y 左转", "少动", "连接上下半身；动捕时承接 Hips 世界旋转"),
    ("上半身", "upper_body", "上半身", "腰", GROUP_TORSO,
     "X 前俯 / Y 左转 / Z 左侧倾", "前倾 10~40（>50 塌）", "躯干主体：鞠躬/驼背/扭转"),
    ("上半身2", "upper_body2", "胸腔", "上半身", GROUP_TORSO,
     "X- 后弯(挺胸) / Z 侧弯", "呼吸 -3", "呼吸起伏/挺胸含胸（部分模型无）"),
    ("下半身", "lower_body", "下半身", "腰", GROUP_LOWER,
     "X 前倾 / Y 左转 / Z 左侧摆", "鞠躬配合 +8", "骨盆以下：前倾/扭转/侧摆"),
    ("首", "neck", "脖子", "上半身2", GROUP_HEAD,
     "X 低头 / Y 左转 / Z 左歪", "点头 8~15；转 ±30", "脖子"),
    ("頭", "head", "头", "首", GROUP_HEAD,
     "X 低头 / Y 左转 / Z 左歪", "点 10~20；转 ±30；歪 5~15", "头部"),
    # ---------------- 腿 IK
    ("右足IK親", "right_leg_ik_parent", "右足IK父", "全ての親", GROUP_IK,
     "位移平移整条腿", "小", "★ 半角 IK；整体挪动右脚（不参与 IK 解算）"),
    ("右足ＩＫ", "right_leg_ik", "右腿IK", "右足IK親", GROUP_IK,
     "位移=踝落点 / Z 脚朝向", "—", "★ 全角 ＩＫ；控右腿落点（目标=右足首）"),
    ("右つま先ＩＫ", "right_toe_ik", "右趾IK", "右足ＩＫ", GROUP_IK,
     "Y 脚尖朝向", "±20", "控右脚朝向/滚动（★ 全角 ＩＫ）"),
    ("左足IK親", "left_leg_ik_parent", "左足IK父", "全ての親", GROUP_IK,
     "位移平移整条腿", "小", "半角 IK；整体挪动左脚"),
    ("左足ＩＫ", "left_leg_ik", "左腿IK", "左足IK親", GROUP_IK,
     "位移=踝落点 / Z 脚朝向", "—", "全角 ＩＫ；控左腿落点"),
    ("左つま先ＩＫ", "left_toe_ik", "左趾IK", "左足ＩＫ", GROUP_IK,
     "Y 脚尖朝向", "±20", "控左脚朝向/滚动"),
    # ---------------- 右臂
    ("右肩P", "right_shoulder_p", "右肩P", "上半身2", GROUP_ARM,
     "位移 肩带平移", "小", "肩部父骨（准标准）；耸肩整体平移用它"),
    ("右肩", "right_shoulder", "右肩", "右肩P", GROUP_ARM,
     "Z 抬肩 / Y 前送", "抬肩 10~20", "右锁骨"),
    ("右肩C", "right_shoulder_c", "右肩C", "右肩", GROUP_ARM,
     "—", "一般不动", "肩子补偿骨（准标准）"),
    ("右腕", "right_arm", "右上臂", "右肩C", GROUP_ARM,
     "Z 抬臂(负) / X 前摆 / Y 内旋", "站姿 -70；T -90", "右上臂"),
    ("右腕捩", "right_arm_twist", "右腕捩", "右腕", GROUP_ARM,
     "Y 长轴扭转", "±45~90", "上臂扭转（准标准）；手心朝向用它"),
    ("右ひじ", "right_elbow", "右肘", "右腕捩", GROUP_ARM,
     "Z 屈肘(负)", "弯 10~110", "右肘"),
    ("右手捩", "right_wrist_twist", "右手捩", "右ひじ", GROUP_ARM,
     "Y 长轴扭转", "±45~90", "前臂扭转（准标准）；翻掌用它"),
    ("右手首", "right_wrist", "右手腕", "右手捩", GROUP_ARM,
     "Y 内旋 / X 屈腕", "±20", "右手腕"),
    # ---------------- 左臂
    ("左肩P", "left_shoulder_p", "左肩P", "上半身2", GROUP_ARM,
     "位移 肩带平移", "小", "肩部父骨（准标准）"),
    ("左肩", "left_shoulder", "左肩", "左肩P", GROUP_ARM,
     "Z 抬肩 / Y 前送", "抬肩 10~20", "左锁骨"),
    ("左肩C", "left_shoulder_c", "左肩C", "左肩", GROUP_ARM,
     "—", "一般不动", "肩子补偿骨（准标准）"),
    ("左腕", "left_arm", "左上臂", "左肩C", GROUP_ARM,
     "Z 抬臂(正) / X 前摆 / Y 内旋", "站姿 +70；T +90", "★ 左上臂（抬臂看 Z）"),
    ("左腕捩", "left_arm_twist", "左腕捩", "左腕", GROUP_ARM,
     "Y 长轴扭转", "±45~90", "上臂扭转（准标准）"),
    ("左ひじ", "left_elbow", "左肘", "左腕捩", GROUP_ARM,
     "Z 屈肘(正)", "弯 10~110（>120 穿透）", "★ 左肘"),
    ("左手捩", "left_wrist_twist", "左手捩", "左ひじ", GROUP_ARM,
     "Y 长轴扭转", "±45~90", "前臂扭转（准标准）"),
    ("左手首", "left_wrist", "左手腕", "左手捩", GROUP_ARM,
     "Y 内旋 / X 屈腕", "±20", "左手腕"),
    # ---------------- 右腿
    ("腰キャンセル右", "right_leg_cancel", "腰取消右", "下半身", GROUP_LOWER,
     "抵消腰部旋转", "—", "扭腰但腿不动时用（准标准）"),
    ("右足", "right_leg", "右大腿", "腰キャンセル右", GROUP_LEG,
     "X 前抬(负) / Z 外八", "前抬 -20 小/-45 大/-85 坐", "右大腿"),
    ("右ひざ", "right_knee", "右膝", "右足", GROUP_LEG,
     "Z 弯膝(负)", "0~90（走 10~35）", "★ 右膝（负值弯）"),
    ("右足首", "right_ankle", "右踝", "右ひざ", GROUP_LEG,
     "X 勾脚 / Z 撇", "蹲补偿 20~35", "右踝"),
    ("右つま先", "right_toe", "右脚趾", "右足首", GROUP_LEG,
     "X 踮脚", "20~30", "右脚趾"),
    ("右足D", "right_leg_d", "右足D", "腰キャンセル右", GROUP_LEG,
     "—", "★ 不要手写", "变形用腿骨（会翻倍变形）"),
    ("右ひざD", "right_knee_d", "右膝D", "右足D", GROUP_LEG,
     "—", "★ 不要手写", "变形用小骨"),
    ("右足首D", "right_ankle_d", "右踝D", "右ひざD", GROUP_LEG,
     "—", "★ 不要手写", "变形用踝骨"),
    ("右足先EX", "right_toe_ex", "右足先EX", "右足首D", GROUP_LEG,
     "—", "★ 不要手写", "脚尖 EX 变形"),
    ("腰キャンセル左", "left_leg_cancel", "腰取消左", "下半身", GROUP_LOWER,
     "抵消腰部旋转", "—", "扭腰但腿不动时用（准标准）"),
    ("左足", "left_leg", "左大腿", "腰キャンセル左", GROUP_LEG,
     "X 前抬(负) / Z 外八", "前抬 -20 小/-45 大/-85 坐", "左大腿"),
    ("左ひざ", "left_knee", "左膝", "左足", GROUP_LEG,
     "Z 弯膝(正)", "0~90（走 10~35）", "★ 左膝（正值弯）"),
    ("左足首", "left_ankle", "左踝", "左ひざ", GROUP_LEG,
     "X 勾脚 / Z 撇", "蹲补偿 20~35", "左踝"),
    ("左つま先", "left_toe", "左脚趾", "左足首", GROUP_LEG,
     "X 踮脚", "20~30", "左脚趾"),
    ("左足D", "left_leg_d", "左足D", "腰キャンセル左", GROUP_LEG,
     "—", "★ 不要手写", "变形用腿骨"),
    ("左ひざD", "left_knee_d", "左膝D", "左足D", GROUP_LEG,
     "—", "★ 不要手写", "变形用小骨"),
    ("左足首D", "left_ankle_d", "左踝D", "左ひざD", GROUP_LEG,
     "—", "★ 不要手写", "变形用踝骨"),
    ("左足先EX", "left_toe_ex", "左足先EX", "左足首D", GROUP_LEG,
     "—", "★ 不要手写", "脚尖 EX 变形"),
    # ---------------- 眼
    ("右目", "right_eye", "右眼", "頭", GROUP_FACE, "Y 左右 / X 上下", "±15", "右眼球"),
    ("左目", "left_eye", "左眼", "頭", GROUP_FACE, "Y 左右 / X 上下", "±15", "左眼球"),
    ("両目", "both_eyes", "双眼", "頭", GROUP_FACE, "Y 左右 / X 上下", "±15", "★ 双眼整体（视线方向）"),
]

# ------------------------------------------------------------------ 手指（左/右 × 五指 × 3 节）

_FINGERS = [
    ("親指", "thumb", "０", ["０", "１", "２"]),
    ("人指", "index", "１", ["１", "２", "３"]),
    ("中指", "middle", "１", ["１", "２", "３"]),
    ("薬指", "ring", "１", ["１", "２", "３"]),
    ("小指", "pinky", "１", ["１", "２", "３"]),
]

for _side, _en in (("左", "left"), ("右", "right")):
    for _jp, _en_f, _first, _segs in _FINGERS:
        for _i, _seg in enumerate(_segs):
            _name = f"{_side}{_jp}{_seg}"
            BONE_SPECS.append((
                _name,
                f"{_en}_{_en_f}{_i + 1}",
                f"{_side}{_jp}{_seg}",
                f"{_side}手首" if _seg == _first else f"{_side}{_jp}{_segs[_i - 1]}",
                GROUP_FINGER,
                "Z 弯(负=弯)",
                "握拳 -90",
                f"{_side}手{_jp}第{_i + 1}节",
            ))

del _side, _en, _jp, _en_f, _first, _segs, _i, _seg, _name

# 日文名 -> spec
BONE_INDEX: dict[str, tuple[str, str, str, str, str, str, str, str]] = {
    b[0]: b for b in BONE_SPECS
}

# ------------------------------------------------------------------ 别名 / 常见写法

BONE_ALIASES: dict[str, str] = {
    "肘": "ひじ",
    "膝": "ひざ",
    "人差指": "人指",
    "爪先": "つま先",
    "足先": "つま先",
    "上半身3": "上半身2",  # 无分层时的近似
    "胸": "上半身2",
    "胸2": "上半身2",
    "左足IK": "左足ＩＫ",
    "右足IK": "右足ＩＫ",
    "左つま先IK": "左つま先ＩＫ",
    "右つま先IK": "右つま先ＩＫ",
}

# ------------------------------------------------------------------ 常犯错误

PITFALLS: list[str] = [
    "骨名是**日文**：左腕/左ひじ（不是肘）/左ひざ（不是膝）/左足ＩＫ（ＩＫ 是**全角**）。",
    "`右足IK親` 的 IK 是**半角**，`右足ＩＫ` 的 ＩＫ 是**全角** —— 两者相反。",
    "抬臂看 **Z**（站姿左腕 z=+70、T 字 z=+90）；前俯/屈伸看 **X**；扭转看 **Y**。",
    "**左膝 z 正、右膝 z 负**；左肘 z 正、右肘 z 负。",
    "位移只认真动 `センター`；其它骨位移通常保持 0。",
    "`足D`/`ひざD`/`足首D`/`足先EX` 是变形辅助骨，**不要手写**（会翻倍变形）。",
    "头发/裙摆/衣摆多为**物理骨**，手写关键帧会抖动。",
    "VMD 存的是**四元数**；工具/UI 用**欧拉角（度，YXZ）**。",
    "VMD 的相机旋转是**弧度**，不是度。",
    "手指用**全角数字**：親指０/１/２，人指・中指・薬指・小指 １/２/３。",
    "表情权重 0..1；VMD 表情**没有插值曲线**（线性）。",
    "循环动作首尾帧必须一致。",
    "手肘 >120° 会穿透；膝盖 >90° 会穿。",
    "先 `list_bones` —— 模型可能缺 `上半身2`/`腰`/`グルーブ`/手指。",
]

# ------------------------------------------------------------------ 精简注入文本（核心）

_CORE_AXES = """\
# MMD 动作速查（常驻）
轴向（欧拉 YXZ，单位度）：X+ 前俯/低头、Y+ 左转、Z+ 左倾（关节侧弯多在 Z）。
范围：旋转 X -90..90、Y/Z -180..180；位移 -10..10（センター可超）。30 FPS。
抬臂看 Z：站姿 左腕 z=+70 / 右腕 z=-70；T 字 ±90。屈伸看 X；扭转看 Y。
膝盖：左ひざ z 正、右ひざ z 负。屈肘 ≤110°，弯膝 ≤90°。
位移只认真动 センター（X 左右 / Y 升降 / Z 前后）；其它骨位移通常 0。
VMD 存四元数，工具写欧拉角（度）；相机旋转在 VMD 里是弧度。
"""

_CORE_BONES = """\
# 常用骨（★ 以 list_bones 为准）
中轴：全ての親→センター→グルーブ→腰→{上半身→上半身2→首→頭, 下半身→足(腿)}
臂：肩P→肩→肩C→腕→腕捩→ひじ→手捩→手首→手指
腿：足→ひざ→足首→つま先 ； IK：足IK親(半角IK)→足ＩＫ(全角)→つま先ＩＫ(全角)
关键骨名：左腕/左ひじ/左ひざ/左足ＩＫ/左つま先ＩＫ/両目/あご
注意：右足IK親(半角) vs 右足ＩＫ(全角)；足D/ひざD/足首D/足先EX 不要手写。
"""

_CORE_WORKFLOW = """\
# 做动作流程（AI）
1 先 list_bones / get_editor_state；2 摆姿势用 pose_body 或 apply_pose_preset；
3 capture_pose_image 看图；4 不对用 set_bone_rotation 微调；5 apply_interpolation_preset 调节奏；
6 成品 save_vmd_to_storage / export_vmd。
生成动作：原地(挥手/鞠躬/转身圈)→generate_action；含位移或要精细→generate_action_from_text；
调整刚生成的→generate_action_from_video。失败如实说，不要用 pose_body 偷偷拼凑。
★ 只动脸（情绪/神情）→ generate_emotion（后端表情小模型，输入自然口语即可）。
★ 要「带表情的完整 VMD」→ generate_vmd（内部：动作 VMD + 情绪 VMD → 合并；本地动作做不了会自动走视频兜底）。
  动作工具（generate_action*）只出骨骼、不出表情。
需要细节先调 get_mmd_knowledge(topic)：bones/vmd/pmx/rotation/morphs/expression/motion/retarget/xyz/app/tools。
表情铁律：跨面板（眉/目/口）可叠加，同面板只能择一。panel 分组看 PMX panel，不靠名字猜。
"""


def core_text() -> str:
    """精简注入系统提示的文本（约 1.5~2 KB）。"""
    return "\n".join([_CORE_AXES.rstrip(), "", _CORE_BONES.rstrip(), "", _CORE_WORKFLOW.rstrip()])


# ------------------------------------------------------------------ 章节全文（按需）

def _bones_table_text() -> str:
    """82 根骨骼的 Markdown 表。"""
    lines = [
        "# MMD 标准骨骼（82 根）",
        "",
        "| 日文 | 英文 | 中文 | 父骨 | 分组 | 轴 | 幅度 | 说明 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for jp, en, cn, parent, group, axes, rng, note in BONE_SPECS:
        lines.append(f"| `{jp}` | {en} | {cn} | {parent or '—'} | {group} | {axes} | {rng} | {note} |")
    return "\n".join(lines)


_XYZ_TEXT = """\
# 调 XYZ → 效果（逐骨）

口诀：X=前后俯仰(屈伸)，Y=左右转(扭转)，Z=左右倾+关节侧弯。位移只认真动 センター。

| 骨 | X+ | X− | Y+ | Z+ | 典型值 |
|---|---|---|---|---|---|
| 上半身 | 前俯(鞠躬) | 后仰 | 躯干左转 | 左侧倾 | 鞠躬 35；前倾 10~40（>50 塌） |
| 上半身2 | 含胸 | 挺胸 | 左转 | 左侧弯 | 呼吸 x=-3 |
| 首 | 低头 | 抬头 | 左转 | 左歪 | 点头 8~15 |
| 頭 | 低头 | 抬头 | 左转 | 左歪 | 点 10~20；转 ±30；歪 5~15 |
| 肩 | 沉肩 | 抬肩 | 前送 | 抬肩外展 | 抬肩 10~20 |
| 腕(上臂) | 前摆 | 后摆 | 内旋 | 抬臂外展 | 站姿 z=70；T z=90；A z=45 |
| ひじ | 前摆 | 后摆 | — | 屈肘 | 10~110（>120 穿透） |
| 手首 | 屈腕 | 背伸 | 内旋 | 外偏 | ±20 |
| 足(大腿) | 后摆 | 前抬 | 内/外旋 | 外八 | -20 小步/-45 大步/-85 坐 |
| ひざ | — | 伸 | — | 弯膝 | 0~90（左正右负） |
| 足首 | 勾脚 | 绷脚 | — | 撇 | 蹲补偿 20~35 |
| つま先 | 下压 | 上翘 | — | — | 踮脚 20~30 |
| センター(位移) | 左右 | — | — | — | Y 升降：蹲 -0.5~-1.5 |
| グルーブ | 骨盆前倾 | 后倾 | 扭胯 | 倾胯 | ±3~5 / 扭 ±10~20 |
| 両目/目 | 看下 | 看上 | 看左 | — | ±15 |

## 意图 → joints 配方（可直接喂 pose_body）
- 鞠躬：{上半身 x35, 下半身 x8, 首 x12, 頭 x10, 左腕 z62, 右腕 z-62}
- 叉腰：{左腕 x30 z55, 左ひじ z95, 右腕 x30 z-55, 右ひじ z-95}
- 举手：{左腕 z95, 左ひじ z40, 上半身 z-3}
- 坐：{左足 x-85, 右足 x-85, 左ひざ z90, 右ひざ z-90, 左足首 x30, 右足首 x30}
- 站姿：{左腕 z70, 右腕 z-70, 左ひじ z10, 右ひじ z-10}
预设 apply_pose_preset：stand/tpose/apose/raise_hand/akimbo/bow/sit。

## 常见错误
1 抬不起手臂→抬了 x 不是 z；2 膝反关节→左正右负记反；3 穿地→センター Y 太低；
4 手肘穿透→ひじ>120；5 镜像错→骨名换左右+四元数(x,-y,-z,w)+位移(-x,y,z)；
6 脚打滑→IK 脚没跟 センター 移；7 物理骨被手写→抖动。
"""

_VMD_TEXT = """\
# VMD 格式要点（完整见 docs/mmd/01-vmd-format.md）
签名 30B "Vocaloid Motion Data 0002" + 模型名 20B(Shift-JIS)。
段：骨骼帧(111B/帧) 表情帧(23B) 相机帧(61B) 光照帧(28B) 自阴影帧(9B) IK/显示段。
骨骼帧 = 名15 + 帧号u32 + 位移3f32 + 四元数4f32 + 插值64B。
表情帧 = 名15 + 帧号u32 + 权重f32(0..1)，无插值曲线。
相机帧 = 帧号 + 距离 + 目标3 + 旋转3(弧度) + 插值24B + FOV(u32) + 保留1。
★ 所有段计数必须写（空段写 u32 0），否则 MMD 读取越界。
★ 64B 插值 = 4 通道(X/Y/Z/旋转)×16B，通道 c 从 raw[c*16] 读；byte2/3 是物理开关。
★ 名字定长：骨名 15、IK 名 20、模型名 20；解码遇 0x00 截止，编码不按 size-1 截断。
★ 重复帧后者覆盖。30 FPS。
"""

_PMX_TEXT = """\
# PMX 格式要点（完整见 docs/mmd/02-pmx-format.md）
Little-Endian；文本编码看 Globals[0]（0=UTF16LE / 1=UTF8）。
结构：Header + Vertex + Surface + Texture + Material + Bone + Morph + Display + RigidBody + Joint(+SoftBody 2.1)。
索引宽度 1/2/4 由 Globals 指定；Bone/Texture/Material/Morph/RigidBody 空值 = -1。
Bone 字段：日文名 + 英文名(★不可靠) + 位置 + 父索引(-1=根) + Layer + Flags(2字节) + 尾端 + [继承/固定轴/局部/外部父/IK]。
Bone Flags：bit1 可旋转、bit2 可位移、bit5 IK、bit8 继承旋转、bit9 继承位移、bit10 固定轴。
IK 结构：目标骨索引 + 循环次数 + 角度限制 + 链接数 + 链接[(骨索引, 有限制?, min/max 弧度)]。
Morph：Panel(0眉/1目/2口/3其它) + 类型(0组/1顶点/2骨/3UV/8材质...) + offset。
★ 英文骨名大量模型是错的，只用日文名匹配。
★ 动作看 Bone + Morph；VMD 只存 morph 权重，变形定义在 PMX。
"""

_ROTATION_TEXT = """\
# 旋转数学（完整见 docs/mmd/05-rotation-math.md）
VMD 存四元数 (x,y,z,w)；工具/UI 用欧拉角(度，YXZ)。单位四元数 (0,0,0,1)。
YXZ：R = Ry(ey)·Rx(ex)·Rz(ez)。
四元数→欧拉：ex=asin(clamp(-r12)); ey=atan2(r02,r22); ez=atan2(r10,r11)（ca≈0 时 ez=0，万向锁）。
★ ey 不能写 asin(R02)，会偏小（30°→37.8°）。
欧拉→四元数：q = qy*qx*qz（各轴半角）。
X 来自 asin 故 ±90；Y/Z atan2 故 ±180。
镜像：四元数 (x,-y,-z,w)；位移 (-x,y,z)；骨名 左⇄右。
旋转插值是 slerp，不能按欧拉线性插值（跨 180° 会绕远路）。
插值预设(0..127)：linear(20,20)(107,107) easeIn(60,0)(120,100) easeOut(0,0)(60,100)
easeInOut(40,0)(60,100) step(127,0)(127,0)。
"""

_MORPH_TEXT = """\
# 表情 / Morph（完整见 docs/mmd/06-morphs.md）
VMD 只存权重 0..1；变形定义在 PMX。先 list_morphs 查当前模型有哪些。

## ★ 分组以 PMX 的 panel 为准，不要按名字猜
PMX 每个 morph 有一个 panel 字节：**1=眉 2=目 3=口 4=その他**（MMD 界面分页，作者手工指定）。
实测按名字正则猜的偏差率高达 **45%~60%**，典型错例：
  · `真面目 / 困る / にこり / 怒り / 上 / 下 / 前` 真实都在「眉」，名字里根本没有「眉」字；
  · `笑い` 含「笑」但真实在「目」，不是口型；
  · `びっくり / なごみ / 眼角上 / 眼角下 / 下眼上` 真实在「目」；
  · `ワ / ん / ω / てへぺろ / ぺろっ` 真实在「口」；
  · `照れ` 在「その他」（材质类，不是「感情」页）。
本项目 `lib/morph-meta.ts` 用 `readPmxDocument()` 读 panel；`groupOfMorph(name, meta)`
有 panel 用 panel，没有才回落到名字规则。

## 面板 → 常见表情名（按实测归位）
眉(1)：真面目 / 困る / にこり / 怒り / 上 / 下 / 前（左右/左右变体另算）
目(2)：まばたき / 笑い / なごみ / ウィンク / びっくり / じと目 / ジト目 / 怒り目 / 涙 / 瞳小 / 眼角上/下
口(3)：あいうえお / にやり / ω / ん / 口角上げ / 口角下げ / 舌広げ / てへぺろ
その他(4)：照れ / 赤面 / 涙（材质类，改颜色不是几何，叠加多个会过曝）

## ★ 多表情叠加：跨面板叠加，同面板择一
实测 5 个真实模型两两顶点重叠率：
  · 跨面板（眉 vs 目）：**0%** → 顶点完全不相交，可同时满权重；
  · 同面板（まばたき vs 笑い）：**80%~96%** → 同一批顶点的两套位移，会互相拉扯/抵消。
权重分层：主表情 0.7~1.0 / 辅助 0.4~0.7 / 微表情（缩瞳、嘴角）0.15~0.4。
眨眼(瞬时4帧)：n=0, n+1=1, n+3=1, n+4=0（约 1.8 秒一次）。
★ 权重 0..1；无插值曲线；没有的表情不能凭空造。
★ 纯表情需求用 `generate_emotion`（后端表情小模型）；带表情的完整 VMD 用 `generate_vmd`。
"""

_EXPRESSION_TEXT = """\
# 表情生成规范（★ 表情原理参考 · 人工整理语义表）
#
# ★ 生成表情不需要你自己算：后端已内嵌 text2motion 表情小模型。
#   AI 工具 generate_emotion 负责「只动脸」；generate_vmd 负责「动作 + 表情合并」。
#   输入自然口语即可（开心 / 生气 / 翻白眼 / 苦笑 / 缓缓闭上眼…）。
#   下面的槽位 / 候选 / 配方是原理与排查参考（手工微调、看某个表情为何没出来时用）。

## 0. 表情模型：6 个槽
| 槽 | 说明 | 规则 |
|---|---|---|
| 眉 brow | 眉毛形态 | 选 1 |
| 眼·开合 eyeOpen | 眼球开放状态 | **闭眼 / 睁大 / 微眯 三层互斥**，选 1 |
| 眼·修饰 eyeMod | 眼角、下眼皮 | 眼角(上/下 互斥) + 下眼皮，**可与开合共存** |
| 瞳孔 pupil | 瞳小 / 瞳大 | **独立**，可空 |
| 口 mouth | 嘴形 | 选 1 |
| 其它 other | 照れ/涙（材质类） | 可空 |

权重全部 0..1；**模型生成的峰值默认 1.0**（跨槽独立、不归一，只有「微微/有点」这类
强度档降到 0.5）。手工微调时可自行降低，但要弱化表情优先「换更弱的 morph / 少用槽」，
而不是在所有槽上乘系数。

## 1. 眉（panel1）—— 选一个
| 名 | 作用 |
|---|---|
| 困る | 双眉眉尖上扬，八字眉，带弧度 |
| にこり | 双眉眉尖上扬，八字眉，直线 |
| 怒り | 双眉眉尖下挑成勾，小幅度 |
| 真面目 | 双眉眉尖下挑成勾，大幅度 |
| 上 | 双眉上扬 |
| 下 | 双眉下压 |
| 前 | 双眉紧簇 |

（带「左/右」后缀的变体＝只动单侧眉毛；模型没有对称名时会自动写左右两个。）

## 2. 眼（panel2）—— 分三层，规则不同

### 2.1 开合层：闭眼 / 睁大 / 微眯 **三层互斥**，只能选一个
| 层 | 名字 | 作用 |
|---|---|---|
| 闭眼 | まばたき / なごみ | 双目闭合 |
| 闭眼 | 笑い | 双目闭合 + 眼尾上翘（微笑） |
| 闭眼 | ウィンク / ウィンク２ / なごみ左 | 左眼闭合 |
| 闭眼 | ウィンク右 / ウィンク２右 / なごみ右 | 右眼闭合 |
| 睁大 | びっくり | 双目圆睁变大 |
| 微眯 | じと目 | 眼皮半垂 |
| 微眯 | ジト目 | 双目微眯，翻白眼 |
| 微眯 | 怒り目 | 双目微眯，生气 |
| 微眯 | 喜び | 双目微眯，喜悦 |

★ 闭眼与睁大、闭眼与微眯、睁大与微眯 —— **都不能共存**（实测顶点重叠 98~100%，方向相反）。

### 2.2 修饰层：可与开合层**共存**
| 组 | 名字 | 作用 |
|---|---|---|
| 眼角 | 眼角上 | 双眼角尾巴上扬 |
| 眼角 | 眼角下 | 双眼角尾巴下沉 |
| 下眼皮 | 下眼上 | 下眼皮上眯 |

★ 眼角上 / 眼角下 **互斥**（同组）；眼角组与下眼皮组可同时用。
★ 注意：修饰层与开合层**顶点高度重叠（99~100%）但语义正交**，所以能共存 ——
  说明「顶点重叠 ≠ 冲突」，真正的判断标准是**位移方向是否互斥**。

### 2.3 瞳孔：独立，可空
| 名 | 作用 |
|---|---|
| 瞳小 | 瞳孔变小 |
| 瞳大 | 瞳孔变大 |

★ 瞳孔与其它所有 morph 顶点重叠 **0%**，完全独立，可任意共存。
  缩瞳权重建议 0.2~0.4（过大失真）。

## 3. 口（panel3）—— 选一个
| 名 | 作用 |
|---|---|
| にやり | 两边嘴角上扬 |
| にやり２ | 左边嘴角上扬 |
| にやり３ | 左边嘴角上扬 + 龇牙 |
| ω | 上嘴唇成 w 型（卖萌） |
| てへぺろ | 舌头伸出，舔左上角嘴唇 |
| ぺろっ | 伸舌头朝下 |
| 口角上げ | 双嘴角上扬 |
| 口角下げ | 双嘴角下压 |
| 口横広げ | 双嘴角外拉变长 |
| 口横狭め | 嘟嘴 |

## 4. 情绪 → 分层配方（峰值统一 1.0；需要弱化就换更弱的 morph）

| 情绪 | 眉 | 眼开合 | 眼修饰 | 瞳孔 | 口 | 其它 |
|---|---|---|---|---|---|---|
| 开心 happy | にこり | 笑い（闭眼+眼尾上翘） | 眼角上 | — | 口角上げ | — |
| 生气 angry | 怒り | 怒り目（微眯） | — | 瞳小 | 口角下げ | 照れ |
| 难过 sad | 困る | じと目（微眯） | 眼角下 | — | 口角下げ | — |
| 惊讶 surprised | 上 | びっくり（睁大） | — | 瞳小 | あ | — |
| 害羞 shy | 困る | じと目（微眯） | — | — | にこり | 照れ |
| 无语 speechless | 下 | ジト目（微眯） | — | — | ω | — |
| 平静 neutral | 真面目 | じと目（微眯） | — | — | ω | — |

（瞳孔/照れ等「修饰类」形变本身很小，峰值同样是 1.0；材质类 `照れ` 可按需降低。）

### 生气逐部位示例（用户最常问）
- 眉 `怒り` 1.0 —— 眉尖下挑成勾（小幅）
- 眼 `怒り目` 1.0 —— 双目微眯（互斥层选一个）
- 瞳 `瞳小` 1.0 —— 缩瞳是紧张/愤怒的生理信号（瞳孔 morph 本身形变小）
- 口 `口角下げ` 1.0 —— 双嘴角下压
- 附加 `照れ` 0.35 —— 气到脸涨红（材质类，按需微调）
- **不要**再加 `笑い`/`じと目`（同属开合层，会打架）

## 5. 其他模型：按名字推断，无法确定就不用
```
1) 命中内置语义词典（上表）→ 直接用
2) 关键词 / 英文名推断：
   眉|まゆ|brow                              → 眉
   まばたき|なごみ|ウィンク|blink|wink|eye_close → 开合·闭眼
   びっくり|驚|surprise|見開|はちゅ|はぅ|ｷﾘｯ  → 开合·睁大
   じと|ジト|睨|怒り目|半眼|jit|kiri|half     → 开合·微眯
   笑|喜|smile|wail|joy                      → 开合·闭眼（弯眼）
   眼角|眼尻|眼尾|corner|eye_corner          → 修饰·眼角
   下眼|下まぶた|under_eye|lower_lid         → 修饰·下眼皮
   瞳|pupil                                  → 瞳孔
   口角|にや|にやり|くち|mouth|▲|∧|□         → 口
3) 仍无法确定 → **跳过不用**（绝不乱猜）
```

## 6. 时序与叠加（工具自动完成）
- **morph 生命周期**：每个 morph 有自己的 `(attack, hold, release)`，单位帧@30fps，
  唯一真源是 `expression_schema.MORPH_TIMING`（眨眼 9 帧 / 笑 46 帧 / 嘟嘴 37 帧 / 挑眉 25 帧…）
- 曲线到点**立即归零**，与动作总帧数无关；`frames` 只决定时间轴长度，不会把表情拉到动作末尾
- `hold` 硬约束 1~60 帧（1 帧 ~ 2 秒）；段太短时生命周期等比压进段内（`_fit_life`）
- 节奏词只做整体缩放（`TEMPO_SCALE`：very_slow ×1.8 / slow ×1.4 / normal ×1.0 / fast ×0.7 / very_fast ×0.5）
- 显式重复（`眨眨眼` / `眨两下` / `挑了?两下眉`）才重复，默认单次；间隔由 `gap` 控制
- hold 段叠加 ±4% 低频「呼吸」起伏，防止表情僵死
- 自主眨眼独立叠加：`まばたき`，`n=0, n+1=1, n+3=1, n+4=0`（闭 2 + 持 1 + 睁 5），间隔 55±18 帧；
  `笑い` 等闭眼类表情提前归零后，眨眼会自动恢复

## 7. 用法
- AI 工具：`generate_emotion(text, frames?, duration?, blink?, seed?, name?)`
  → 仅 morph 的表情片段（进动作片段库，可在编排里与骨骼动作**叠加合并**）
- AI 工具：`generate_vmd(text, expression?, name?, duration?, frames?, blink?, seed?)`
  → 动作 VMD + 情绪 VMD **合并**后的最终 VMD（骨骼 + 表情同文件）
- 单帧手写：`set_morph_weight(morph, frame, weight)`（0..1）
- 分组用 PMX `panel`（1眉/2目/3口/4その他），**不要按名字猜**（实测偏差 45%~60%）

"""

_MOTION_TEXT = """\
# 动作 Cookbook（完整见 docs/mmd/07-motion-cookbook.md）
姿势库：stand(腕 z±70)/tpose(±90)/apose(±45)/raise_hand/akimbo/bow/sit。
关键帧间隔 8~15 帧最自然；dense=true 每帧都写，false 靠插值。
缓动：抬手停住 easeOut；发力 easeIn；自然 easeInOut；Q弹 Over；柔和 SlowIO。
重心：整体位移→センター；骨盆倾斜/扭胯→グルーブ；蹲 Y -0.5~-1.5。
走路(原地)：period=30 cycles=2 amplitude=1，手脚反向；跑步 amplitude 1.8~2.5 period 20~24。
呼吸：period=60，上半身2 x=-3。
循环：首尾帧一致。
避雷：手肘>120穿透、膝反关节、センター Y 过低穿地、物理骨手写抖动、关键帧太稀跳变。
"""

_RETARGET_TEXT = """\
# 重定向（完整见 docs/mmd/08-retarget-notes.md）
管线：MiniMax i2v → AnimChar 动捕 → Mixamo glb → glb2vmd → VMD（目标=当前系统 PMX）。
映射：Spine→上半身/上半身2/上半身3、Neck→首、Head→頭；Left/RightArm→腕、ForeArm→ひじ、Hand→手首。
骨盆：Hips 世界旋转→腰、世界位移→センター。
腿：只写 足ＩＫ(位置) + 腿 FK 初值(足/ひざ/足首)，つま先ＩＫ 不写键（残差 0，防崴脚）。
掌面 roll：腕-中指根-小指根叉乘定标。
scale auto = 0.98×MMD腿长/源髋踝距离；ref_frame=0 保持首帧自然站姿。
脚打滑/脚位偏 = 视频动捕固有误差。
精密路线：固定首帧 pose.png、768P/4s/9:16、有位移或要精细才用。
"""

_APP_TEXT = """\
# 本软件操作（完整见 docs/mmd/09-app-usage.md）
布局：左栏(文件/骨骼树/表情/相机) + 视口 + 时间轴(关键帧/编排) + 右栏(属性/相机/画面/信息) + AI 侧栏。
右栏属性：旋转滑块 X-90..90 Y/Z-180..180(2位小数)；位移 -10..10(3位小数)；插值曲线 127×127 + 8预设；插入/删除。
★ 草稿预览：拖滑块只预览不落帧；点「插入」按钮才写关键帧；取消/换帧/播放/切 Tab 自动丢弃。
★ AI 的 set_bone_rotation 是直接落帧（没有草稿阶段）。
★ 不提快捷键：引导用户操作时用「按钮名 / 菜单项」（如「点『插入』」），不要写具体键位。
存储三层：本地文件 / 系统存储 storage/vmd / 动作库(内存)；AI 会话目录删会话即删。
保存：无关联→新建；有关联未改名→覆盖；有关联改名→另存。
"""

_TOOLS_TEXT = """\
# 本机工具（完整见 docs/mmd/11-local-tools.md）
生成三件套：
- generate_action 快(本地)+自动视频兜底: 动作（**仅骨骼**）。
- generate_emotion: 情绪/神情 → 仅 morph 的表情片段（后端表情小模型，自然口语输入）。
- generate_vmd: 文本 → 动作VMD + 情绪VMD → **合并**成最终 VMD（本地动作做不了会自动走视频兜底）。
显式动作细分：
- generate_action_from_text 慢(1~5min): 有明确位移(向前走/向前跳/后退/冲过去) 或 用户要精细/高精度/动捕。
- generate_action_from_video 慢: 调整刚生成的(幅度/换手/慢一点)，reference 传上次 video_path。
判定：看站立位置是否真正平移；转身/转圈脚不挪窝=原地。generate_action 内部会自动降级。
失败：返回「无法生成：…」→ 如实告知，不要用 pose_body 偷偷拼凑。
参数化(用户要自己摆时)：pose_body / apply_pose_preset / generate_motion / generate_walk_cycle /
generate_idle_breath / mirror_pose / add_action_to_library。
看图：capture_pose_image(单帧) / capture_motion_sheet(多帧网格)。摆完必看图。
存储：save_vmd_to_storage / import_vmd_from_storage / export_vmd。
本机 skill(非 MCP)：minimax-video(t2v/i2v/fl2v/ref2v/regen/context-ir, 人物动作 768P/4~5s/9:16)、
image-gen(t2i/edit)、animchar-mocap(pose/motion/glb2vmd)；后端已封装到 media/，优先用 MCP。
"""

_SEMI_TEXT = """\
# 准标准骨（完整见 docs/mmd/04-bones-semistandard.md）
肩P/肩/肩C：抬肩动 肩；肩带整体平移用 肩P；肩C 一般不动。
腕捩/手捩：骨头长轴扭转（手心朝向/翻掌用它）；没有就并进 腕/ひじ/手首（会稍扭曲）。
足D/ひざD/足首D/足先EX：变形辅助骨，★ 不要手写（翻倍变形）。
腰キャンセル：扭腰但腿不动；原理是反向旋转抵消。
足IK親(半角)：整条腿平移；足ＩＫ(全角) 才是 IK；つま先ＩＫ(全角) 脚尖朝向。
上半身3/胸/胸2：更细分层，没有就用 上半身2。
足捩/ひざ捩：腿长轴扭转（少见）。
物理骨(头发/裙/衣摆)：不要手写关键帧。
"""


_TOPICS: dict[str, tuple[str, str]] = {
    "bones": ("标准骨骼完整表（82 根）", _bones_table_text()),
    "semistandard": ("准标准/追加骨", _SEMI_TEXT),
    "xyz": ("调 XYZ → 效果 + 意图配方", _XYZ_TEXT),
    "vmd": ("VMD 文件格式", _VMD_TEXT),
    "pmx": ("PMX 文件格式", _PMX_TEXT),
    "rotation": ("旋转数学（四元数/YXZ/镜像/插值）", _ROTATION_TEXT),
    "morphs": ("表情 / Morph（panel 权威分组 + 叠加铁律）", _MORPH_TEXT),
    "expression": ("★ 表情生成规范（6 组情绪完整配方）", _EXPRESSION_TEXT),
    "motion": ("动作设计 Cookbook", _MOTION_TEXT),
    "retarget": ("动作重定向（Mixamo→MMD）", _RETARGET_TEXT),
    "app": ("本软件操作手册", _APP_TEXT),
    "tools": ("本机工具速查", _TOOLS_TEXT),
    "pitfalls": ("常见坑清单", "\n".join(f"- {p}" for p in PITFALLS)),
}

TOPIC_NAMES: list[str] = list(_TOPICS.keys())


def topic_names() -> list[str]:
    """全部 topic 名（供工具描述/报错提示）。"""
    return list(TOPIC_NAMES)


def topic(name: str) -> str:
    """取一个章节的全文。未知 topic 返回可用列表。"""
    key = (name or "").strip().lower()
    hit = _TOPICS.get(key)
    if hit is None:
        avail = "、".join(f"{k}（{v[0]}）" for k, v in _TOPICS.items())
        return f"未知 topic：{name}。可用：{avail}"
    title, body = hit
    # body 自带一级标题时不再重复附加（各 _TEXT 首行就是 "# …"）
    if body.lstrip().startswith("# "):
        return body
    return f"# {title}\n\n{body}"


# ------------------------------------------------------------------ list_bones 补全

def lookup(bone_name: str) -> dict[str, Any]:
    """查一根骨：命中给 en/cn/parent/group/axes/note，未命中标 custom。"""
    spec = BONE_INDEX.get(bone_name)
    if spec is None:
        return {
            "jp": bone_name,
            "en": "",
            "cn": "",
            "parent": "",
            "group": GROUP_OTHER,
            "axes": "",
            "note": "",
            "custom": True,
        }
    jp, en, cn, parent, group, axes, rng, note = spec
    return {
        "jp": jp,
        "en": en,
        "cn": cn,
        "parent": parent,
        "group": group,
        "axes": axes,
        "range": rng,
        "note": note,
        "custom": False,
    }


def suggest(name: str) -> str:
    """把常见错误写法纠正成标准骨名（命中别名返回标准名，否则原样）。"""
    return BONE_ALIASES.get(name, name)


__all__ = [
    "BONE_SPECS",
    "BONE_INDEX",
    "BONE_ALIASES",
    "PITFALLS",
    "TOPIC_NAMES",
    "core_text",
    "topic",
    "topic_names",
    "lookup",
    "suggest",
]
