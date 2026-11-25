"""MMD 标准骨骼字典（日文名 / 英文名 / 中文说明 / 分组 / 方向约定）。

为什么需要它
------------
MMD 骨骼名是**日文**（センター / 上半身 / 左ひじ / 左足ＩＫ …），
AI 生成动作时最大的坑就是"不知道骨名叫什么、哪根轴是弯曲"。
这份字典给 `list_bones` 补英文名与说明，并注入系统提示供 AI 查。

命名字典与 docs/bone-reference.md **同源**，改一处要同步另一处。
`left` 前缀表示该骨有左右同名版本（スフィンクス等无左右差异的除外）。

方向约定（MMD / PMX 通用，VMD 里 rotation 是四元数，拆成 YXZ 欧拉后）：
    X 轴：+ 前俯（低头 / 前倾），- 后仰
    Y 轴：+ 左转（角色视角逆时针），- 右转
    Z 轴：+ 左倾（左肩下沉），- 右倾
具体每根骨的解释见 note 字段 —— 这是给 AI 读的，尽量口语化。
"""

from __future__ import annotations

from typing import Any

# 分组名（与 lib/animation.ts 的 BONE_GROUP_ORDER 对齐）
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

# bone -> (english, group, note)
BONE_REFERENCE: dict[str, tuple[str, str, str]] = {
    # ---------------------------------------------------------------- 躯干
    "センター": ("center", GROUP_CENTER, "根骨，整体位移与朝向都从这里下；改位置优先动它"),
    "グルーブ": ("groove", GROUP_CENTER, "センター的子骨，做骨盆倾斜/扭动"),
    "腰": ("waist", GROUP_CENTER, "腰节点，连接上半身与下半身"),
    "上半身": ("upper_body", GROUP_TORSO, "躯干主体，前俯/后仰/扭转用它"),
    "上半身2": ("upper_body2", GROUP_TORSO, "胸腔，比上半身更靠上，呼吸起伏 / 上身弯曲"),
    "首": ("neck", GROUP_HEAD, "脖子，点头 / 转头"),
    "頭": ("head", GROUP_HEAD, "头部，点头 / 转头 / 侧倾"),
    "下半身": ("lower_body", GROUP_LOWER, "骨盆以下躯干，前倾 / 扭转 / 侧摆"),
    "全ての親": ("root", GROUP_CENTER, "最根骨骼，整体移动 / 旋转（含 IK）"),
    # ---------------------------------------------------------------- 手臂（左 / 右）
    "左肩": ("left_shoulder", GROUP_ARM, "左肩（锁骨），抬肩用；父骨是上半身2"),
    "右肩": ("right_shoulder", GROUP_ARM, "右肩（锁骨）"),
    "左腕": ("left_arm", GROUP_ARM, "左上臂，抬臂 / 手臂张开；Y 轴前摆，Z 轴外展"),
    "右腕": ("right_arm", GROUP_ARM, "右上臂"),
    "左ひじ": ("left_elbow", GROUP_ARM, "左肘，弯曲前臂（负 Y 或正 Z，看模型约定，通常 Z 轴弯曲）"),
    "右ひじ": ("right_elbow", GROUP_ARM, "右肘"),
    "左手首": ("left_wrist", GROUP_ARM, "左腕，手掌朝向 / 手腕翻转"),
    "右手首": ("right_wrist", GROUP_ARM, "右腕"),
    # ---------------------------------------------------------------- 腿（左 / 右）
    "左足": ("left_leg", GROUP_LEG, "左大腿，抬腿 / 前后摆；父骨是下半身"),
    "右足": ("right_leg", GROUP_LEG, "右大腿"),
    "左ひざ": ("left_knee", GROUP_LEG, "左膝，弯曲小腿（正值）"),
    "右ひざ": ("right_knee", GROUP_LEG, "右膝"),
    "左足首": ("left_ankle", GROUP_LEG, "左踝，脚掌朝向 / 蹲姿脚踝补偿"),
    "右足首": ("right_ankle", GROUP_LEG, "右踝"),
    "左つま先": ("left_toe", GROUP_LEG, "左脚趾（部分模型有），行走踮脚"),
    "右つま先": ("right_toe", GROUP_LEG, "右脚趾"),
    # ---------------------------------------------------------------- IK
    "左足ＩＫ": ("left_leg_ik", GROUP_IK, "左腿 IK 目标，控制整条腿落点；开关用 IK 轨"),
    "右足ＩＫ": ("right_leg_ik", GROUP_IK, "右腿 IK 目标"),
    "左つま先ＩＫ": ("left_toe_ik", GROUP_IK, "左脚尖 IK，脚的朝向与滚动"),
    "右つま先ＩＫ": ("right_toe_ik", GROUP_IK, "右脚尖 IK"),
    # ---------------------------------------------------------------- 面部
    "両目": ("both_eyes", GROUP_FACE, "双眼整体，做视线方向（追视骨骼）"),
    "左目": ("left_eye", GROUP_FACE, "左眼球"),
    "右目": ("right_eye", GROUP_FACE, "右眼球"),
    "口": ("mouth", GROUP_FACE, "嘴部骨骼（部分模型有），张口 / 嘟嘴"),
    "あご": ("jaw", GROUP_FACE, "下巴，开合嘴"),
}

# 手指（左右 × 五指的常见命名，多数模型带，做精细手势用）
_FINGER_BONES = {
    "親指": "thumb",
    "人指": "index",
    "中指": "middle",
    "薬指": "ring",
    "小指": "pinky",
}
for _side, _side_en in (("左", "left"), ("右", "right")):
    for _jp, _en in _FINGER_BONES.items():
        _bone_name = _side + _jp
        BONE_REFERENCE[_bone_name] = (
            f"{_side_en}_{_en}",
            GROUP_FINGER,
            f"{_side}手的{_jp}，握拳 / 张开 / 指点",
        )

del _side, _side_en, _jp, _en, _bone_name


def lookup(bone_name: str) -> dict[str, Any]:
    """查一根骨：命中给 en/group/note，未命中标 custom。"""
    info = BONE_REFERENCE.get(bone_name)
    if info is None:
        return {"jp": bone_name, "en": "", "group": GROUP_OTHER, "note": "", "custom": True}
    en, group, note = info
    return {"jp": bone_name, "en": en, "group": group, "note": note, "custom": False}


def reference_text() -> str:
    """生成注入系统提示的骨骼参考文本（按分组罗列）。"""
    by_group: dict[str, list[str]] = {}
    for jp, (en, group, note) in BONE_REFERENCE.items():
        by_group.setdefault(group, []).append(f"  - {jp}（{en}）：{note}")
    lines = ["# MMD 标准骨骼参考（日文名 / 英文名 / 说明）", ""]
    for group, items in by_group.items():
        lines.append(f"## {group}")
        lines.extend(items)
        lines.append("")
    lines.append("轴向约定：X+ 前俯、Y+ 左转、Z+ 左倾（欧拉 YXZ）。")
    lines.append("左 / 右同名骨靠前缀区分；未列出的为模型自定义骨。")
    return "\n".join(lines)
