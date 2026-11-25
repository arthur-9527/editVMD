"""VMD 元信息解析（只读，够用为止）。

为什么后端自己解析而不依赖 pymeshio
---------------------------------
上传 / 保存时只想在列表里显示「帧数 / 骨骼数 / 表情数」，不需要
把整份 VMD 建成对象图。这里直接按磁盘布局跳着读计数段即可，
零依赖、几毫秒。

布局（与 `frontend/src/io/vmd.ts` 严格一致）：
    HEADER(30) + 模型名(20)
    u32 骨骼帧数   → 每帧 111B（名 15 + 帧号 u32 + …）
    u32 表情帧数   → 每帧  23B（名 15 + 帧号 u32 + 权重 f32）
    u32 相机帧数   → 每帧  61B（帧号 u32 + …）
    u32 光照帧数   → 每帧  28B
    u32 自阴影帧数 → 每帧   9B
"""

from __future__ import annotations

import struct

HEADER = b"Vocaloid Motion Data"
HEADER_SIZE = 30
MODEL_NAME_SIZE = 20
BONE_NAME_SIZE = 15
BONE_FRAME_SIZE = 111
MORPH_NAME_SIZE = 15
MORPH_FRAME_SIZE = 23
CAMERA_FRAME_SIZE = 61
LIGHT_FRAME_SIZE = 28
SELF_SHADOW_FRAME_SIZE = 9


def _decode_name(raw: bytes) -> str:
    """VMD 名字是 Shift-JIS，按 0 截断。"""
    cut = raw.split(b"\x00", 1)[0]
    try:
        return cut.decode("shift_jis", errors="replace")
    except LookupError:  # pragma: no cover - 理论上不会缺 codec
        return cut.decode("latin-1", errors="replace")


def parse_vmd_meta(data: bytes) -> dict:
    """返回 {frame_count, bone_count, morph_count, model_name}。

    任何越界 / 非法都返回尽量已知的默认值，绝不抛异常 ——
    元信息缺失不应阻断上传。
    """
    size = len(data)
    result = {"frame_count": 0, "bone_count": 0, "morph_count": 0, "model_name": ""}

    if size < HEADER_SIZE + MODEL_NAME_SIZE:
        return result
    if not data.startswith(HEADER):
        # 不是合法 VMD 头：不猜，原样返回
        return result

    result["model_name"] = _decode_name(data[HEADER_SIZE : HEADER_SIZE + MODEL_NAME_SIZE])

    offset = HEADER_SIZE + MODEL_NAME_SIZE
    max_frame = 0

    def read_u32(pos: int) -> tuple[int, int]:
        return struct.unpack_from("<I", data, pos)[0], pos + 4

    # ---- 骨骼段
    if offset + 4 > size:
        return _finish(result, max_frame)
    bone_count, offset = read_u32(offset)
    max_frame = max(max_frame, _scan_bone_frames(data, offset, bone_count))
    offset += bone_count * BONE_FRAME_SIZE

    # ---- 表情段
    if offset + 4 > size:
        return _finish(result, max_frame)
    morph_count, offset = read_u32(offset)
    max_frame = max(max_frame, _scan_morph_frames(data, offset, morph_count))
    offset += morph_count * MORPH_FRAME_SIZE

    # ---- 相机段
    if offset + 4 > size:
        return _finish(result, max_frame)
    camera_count, offset = read_u32(offset)
    max_frame = max(max_frame, _scan_camera_frames(data, offset, camera_count))
    # 光照 / 自阴影不影响帧数统计，到此为止

    result["bone_count"] = bone_count
    result["morph_count"] = morph_count
    return _finish(result, max_frame)


def _finish(result: dict, max_frame: int) -> dict:
    result["frame_count"] = max_frame
    return result


def _scan_bone_frames(data: bytes, offset: int, count: int) -> int:
    max_frame = 0
    for i in range(count):
        pos = offset + i * BONE_FRAME_SIZE
        if pos + BONE_NAME_SIZE + 4 > len(data):
            break
        frame = struct.unpack_from("<I", data, pos + BONE_NAME_SIZE)[0]
        if frame > max_frame:
            max_frame = frame
    return max_frame


def _scan_morph_frames(data: bytes, offset: int, count: int) -> int:
    max_frame = 0
    for i in range(count):
        pos = offset + i * MORPH_FRAME_SIZE
        if pos + MORPH_NAME_SIZE + 4 > len(data):
            break
        frame = struct.unpack_from("<I", data, pos + MORPH_NAME_SIZE)[0]
        if frame > max_frame:
            max_frame = frame
    return max_frame


def _scan_camera_frames(data: bytes, offset: int, count: int) -> int:
    max_frame = 0
    for i in range(count):
        pos = offset + i * CAMERA_FRAME_SIZE
        if pos + 4 > len(data):
            break
        frame = struct.unpack_from("<I", data, pos)[0]
        if frame > max_frame:
            max_frame = frame
    return max_frame
