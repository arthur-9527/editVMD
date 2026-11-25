# coding: utf-8
"""PMX(MMD 模型)读取器 —— 薄封装 pymeshio。

只用 pymeshio 已经在真实模型上验证过的接口：
    pymeshio.pmx.reader.read_from_file(path) -> PmxModel
PmxModel.bones[i] 字段: name / english_name / position / parent_index / flag /
                        tail_index / effect_index / effect_factor / ik
"""
import pymeshio.pmx as pmx
from pymeshio.pmx import reader as pmx_reader


class MmdBone(object):
    __slots__ = ("index", "name", "position", "parent", "flag",
                 "effect_index", "effect_factor", "has_ik")

    def __init__(self, index, name, position, parent, flag,
                 effect_index, effect_factor, has_ik):
        self.index = index
        self.name = name
        self.position = position
        self.parent = parent
        self.flag = flag
        self.effect_index = effect_index
        self.effect_factor = effect_factor
        self.has_ik = has_ik


class PmxModelInfo(object):
    """只取我们需要的骨架信息。"""

    def __init__(self, path):
        m = pmx_reader.read_from_file(path)
        self.name = m.name
        self.bones = []
        for i, b in enumerate(m.bones):
            self.bones.append(
                MmdBone(
                    index=i,
                    name=b.name,
                    position=(b.position.x, b.position.y, b.position.z),
                    parent=b.parent_index,
                    flag=b.flag,
                    effect_index=b.effect_index,
                    effect_factor=b.effect_factor,
                    has_ik=b.ik is not None,
                )
            )
        self.name_to_bone = {b.name: b for b in self.bones}

    def pos(self, name):
        return self.bones[self.name_to_bone[name].index].position

    def has(self, name):
        return name in self.name_to_bone

    def vec(self, name):
        import numpy as np
        return np.array(self.pos(name), dtype=float)

    def bone_length(self, name):
        import numpy as np
        b = self.name_to_bone[name]
        if b.parent < 0:
            return 0.0
        p = np.array(b.position)
        q = np.array(self.bones[b.parent].position)
        return float(np.linalg.norm(p - q))

    def segment_length(self, a, b):
        """两骨之间的距离（如 足 -> ひざ）。"""
        import numpy as np
        return float(np.linalg.norm(self.vec(b) - self.vec(a)))

    def leg_length(self, side="左"):
        return self.segment_length(side + "足", side + "ひざ") + \
            self.segment_length(side + "ひざ", side + "足首")

    def child_direction(self, name, child):
        """MMD 骨的静止方向（指向指定子骨）。"""
        import numpy as np
        v = self.vec(child) - self.vec(name)
        n = np.linalg.norm(v)
        return v / n if n > 1e-9 else np.array([0.0, 1.0, 0.0])

    def height(self):
        import numpy as np
        ys = [b.position[1] for b in self.bones]
        return float(max(ys) - min(ys))

    def ik_bones(self):
        return [b for b in self.bones if b.has_ik]
