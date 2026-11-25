# coding: utf-8
"""GLB(glTF 2.0 binary) 骨架动画读取器。

只做一件事：把 .glb 里的「骨骼层级 + 静止姿态 + 逐帧动画」读出来，
输出 numpy 数组，供 retarget.py 使用。

- 结构解析用 pygltflib
- accessor 二进制解码用 numpy（pygltflib 不提供 accessor 解码助手）
"""
import numpy as np
from pygltflib import GLTF2

# glTF accessor componentType -> numpy dtype
_COMPONENT = {
    5120: np.int8,
    5121: np.uint8,
    5122: np.int16,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _read_accessor(gltf, blob, index):
    """按 glTF 规范解码一个 accessor（支持 byteStride 交织）。"""
    acc = gltf.accessors[index]
    bv = gltf.bufferViews[acc.bufferView]
    dtype = np.dtype(_COMPONENT[acc.componentType])
    n = _NCOMP[acc.type]
    base = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    stride = bv.byteStride or n * dtype.itemsize
    count = acc.count
    if stride == n * dtype.itemsize:
        flat = np.frombuffer(blob, dtype=dtype, count=count * n, offset=base)
        return flat.reshape(count, n).astype(np.float64)
    out = np.empty((count, n), dtype=np.float64)
    for i in range(count):
        out[i] = np.frombuffer(blob, dtype=dtype, count=n, offset=base + i * stride)
    return out


def quat_to_mat(q):
    """(x,y,z,w) -> 3x3 旋转矩阵（右手系，glTF 约定）。"""
    x, y, z, w = q
    n = x * x + y * y + z * z + w * w
    if n < 1e-12:
        return np.eye(3)
    s = 2.0 / n
    return np.array(
        [
            [1 - s * (y * y + z * z), s * (x * y - z * w), s * (x * z + y * w)],
            [s * (x * y + z * w), 1 - s * (x * x + z * z), s * (y * z - x * w)],
            [s * (x * z - y * w), s * (y * z + x * w), 1 - s * (x * x + y * y)],
        ]
    )


def mat_to_quat(m):
    """3x3 旋转矩阵 -> (x,y,z,w)。"""
    m = np.asarray(m, dtype=np.float64)
    t = np.trace(m)
    if t > 0.0:
        s = np.sqrt(t + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w], dtype=np.float64)
    return q / np.linalg.norm(q)


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ]
    )


def quat_inv(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def quat_normalize(q):
    q = np.asarray(q, dtype=np.float64)
    n = np.linalg.norm(q)
    return q / n if n > 1e-12 else np.array([0.0, 0.0, 0.0, 1.0])


def quat_from_two_vectors(a, b):
    """最短弧旋转：把单位向量 a 转到 b。"""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    d = float(np.clip(np.dot(a, b), -1.0, 1.0))
    if d > 1.0 - 1e-9:
        return np.array([0.0, 0.0, 0.0, 1.0])
    if d < -1.0 + 1e-9:
        # 反向：绕任意与 a 垂直的轴转 180 度
        axis = np.cross(a, np.array([1.0, 0.0, 0.0]))
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, np.array([0.0, 0.0, 1.0]))
        axis = axis / np.linalg.norm(axis)
        return np.array([axis[0], axis[1], axis[2], 0.0])
    axis = np.cross(a, b)
    w = 1.0 + d
    return quat_normalize(np.array([axis[0], axis[1], axis[2], w]))


class GlbSkeleton(object):
    """骨骼层级 + 动画。

    Attributes:
        names      : list[str]        节点名
        parents    : list[int|-1]     父节点索引
        rest_t     : (N,3)            静止局部平移
        rest_q     : (N,4)            静止局部旋转 (x,y,z,w)
        frames     : int              帧数
        fps        : float            帧率
        anim_t     : (F,N,3)          逐帧局部平移
        anim_q     : (F,N,4)          逐帧局部旋转
        joint_index: dict[str,int]    名字 -> 索引
        joint_ids  : list[int]        参与蒙皮的关节索引
    """

    def __init__(self):
        self.names = []
        self.parents = []
        self.rest_t = None
        self.rest_q = None
        self.frames = 0
        self.fps = 30.0
        self.anim_t = None
        self.anim_q = None
        self.joint_index = {}
        self.joint_ids = []

    def world_matrices(self, frame):
        """返回该帧每个节点的 4x4 世界矩阵 (N,4,4)。

        注意：glTF 节点的索引顺序不保证父在子前，所以用递归+记忆化。
        """
        t = self.anim_t[:, frame]
        q = self.anim_q[:, frame]
        mats = [None] * len(self.names)

        def build(i):
            if mats[i] is not None:
                return mats[i]
            m = np.eye(4)
            m[:3, :3] = quat_to_mat(q[i])
            m[:3, 3] = t[i]
            p = self.parents[i]
            mats[i] = m if p < 0 else build(p) @ m
            return mats[i]

        for i in range(len(self.names)):
            build(i)
        return np.stack(mats)

    def rest_world_matrices(self):
        """静止(bind)姿态下每个节点的 4x4 世界矩阵。"""
        mats = [None] * len(self.names)

        def build(i):
            if mats[i] is not None:
                return mats[i]
            m = np.eye(4)
            m[:3, :3] = quat_to_mat(self.rest_q[i])
            m[:3, 3] = self.rest_t[i]
            p = self.parents[i]
            mats[i] = m if p < 0 else build(p) @ m
            return mats[i]

        for i in range(len(self.names)):
            build(i)
        return np.stack(mats)

    def joint_position(self, frame, name, world=None):
        i = self.joint_index[name]
        if world is None:
            world = self.world_matrices(frame)
        return world[i][:3, 3]

    def rest_world_rotation(self, name):
        """静止（绑定）姿态下该关节的世界 3x3 旋转。"""
        i = self.joint_index[name]
        R = np.eye(3)
        while i >= 0:
            R = quat_to_mat(self.rest_q[i]) @ R
            i = self.parents[i]
        return R


def load_glb(path):
    gltf = GLTF2().load(path)
    blob = bytes(gltf.binary_blob() or b"")

    sk = GlbSkeleton()
    nodes = gltf.nodes
    sk.names = [n.name or "" for n in nodes]
    children2parent = {}
    for i, n in enumerate(nodes):
        for c in n.children or []:
            children2parent[c] = i
    sk.parents = [children2parent.get(i, -1) for i in range(len(nodes))]

    rest_t = np.zeros((len(nodes), 3))
    rest_q = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (len(nodes), 1))
    for i, n in enumerate(nodes):
        if n.translation:
            rest_t[i] = n.translation
        if n.rotation:
            rest_q[i] = n.rotation
    sk.rest_t, sk.rest_q = rest_t, rest_q

    anim = gltf.animations[0]
    times = None
    for ch in anim.channels:
        s = anim.samplers[ch.sampler]
        times = _read_accessor(gltf, blob, s.input)[:, 0]
        break
    frames = len(times)
    sk.frames = frames
    sk.fps = 1.0 / float(times[1] - times[0]) if frames > 1 else 30.0

    anim_t = np.repeat(rest_t[:, None, :], frames, axis=1)
    anim_q = np.repeat(rest_q[:, None, :], frames, axis=1)
    for ch in anim.channels:
        s = anim.samplers[ch.sampler]
        out = _read_accessor(gltf, blob, s.output)
        ni = ch.target.node
        if ch.target.path == "translation":
            anim_t[ni] = out
        elif ch.target.path == "rotation":
            anim_q[ni] = out
    sk.anim_t, sk.anim_q = anim_t, anim_q

    if gltf.skins:
        sk.joint_ids = list(gltf.skins[0].joints)
    else:
        sk.joint_ids = [
            i for i, n in enumerate(nodes) if sk.names[i].startswith("mixamorig")
        ]
    sk.joint_index = {sk.names[i]: i for i in sk.joint_ids}
    # 同时登记去掉 "mixamorig:" 前缀的短名
    for i in sk.joint_ids:
        short = sk.names[i].split(":")[-1]
        sk.joint_index.setdefault(short, i)
    return sk
