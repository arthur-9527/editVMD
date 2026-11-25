"""标签空间统一定义（训练与推理共享，避免两侧不一致）。

相比旧版的变化：
  - side 去掉 "双"（哑参数，系统无双手语义；本轮不做单双手）
  - strength 扩展为 3 档 [0.5, 1.0, 1.5]（支持"大幅/用力地"）
  - speed 保持 3 档
  - repeat 保持 1~5

所有训练脚本与推理脚本都必须从这里 import，禁止各自硬编码。
"""
from __future__ import annotations

# 侧别：None=不指定（用动作默认手），左/右=镜像选择
SIDE_CLASSES: list = [None, "左", "右"]

# 速度：0.6=慢，1.0=正常，1.5=快
SPEED_CLASSES: list = [0.6, 1.0, 1.5]

# 幅度：0.5=轻微，1.0=正常，1.5=大幅
STRENGTH_CLASSES: list = [0.5, 1.0, 1.5]

# 重复次数
REPEAT_CLASSES: list = [1, 2, 3, 4, 5]

# 无法执行的动作统一标签
UNSUPPORTED = "__unsupported__"

# 中文表述 -> 类别值（语料生成与文本解析共用）
SIDE_WORDS = {
    "左": ["左手", "用左手", "左侧", "往左", "拿着左手"],
    "右": ["右手", "用右手", "右侧", "往右", "拿着右手"],
}
SPEED_WORDS = {
    0.6: ["慢慢", "缓缓", "缓慢", "悠着点", "轻缓"],
    1.5: ["快速", "飞快", "迅速", "赶紧", "连忙", "赶紧地"],
}
STRENGTH_WORDS = {
    0.5: ["轻轻", "小幅", "含蓄", "微微", "轻柔"],
    # 移除「重重」：中文里「重重挥手」「重重介绍」不成话，
    # 语料里会产出大量病句（实测 270/11327）。1.5 档用「用力/使劲/夸张/大幅」足够。
    1.5: ["用力", "大幅", "夸张", "使劲"],
}
REPEAT_WORDS = {
    2: ["两次", "两遍", "两回", "再来一次"],
    3: ["三次", "三遍", "三回", "连做三次"],
    4: ["四次", "四遍", "四回"],
    5: ["五次", "五遍", "五回"],
}


def nearest(cls_list, val, default):
    """把任意数值吸附到最近的类别。"""
    try:
        v = float(val)
    except (TypeError, ValueError):
        return default
    return min(cls_list, key=lambda c: abs(float(c) - v))


def describe() -> str:
    return (f"side={SIDE_CLASSES} speed={SPEED_CLASSES} "
            f"strength={STRENGTH_CLASSES} repeat={REPEAT_CLASSES}")


if __name__ == "__main__":
    print(describe())