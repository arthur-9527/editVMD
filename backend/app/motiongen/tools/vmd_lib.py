"""VMD (Vocaloid Motion Data) 解析器。

只做解析，不做插值。输出原始关键帧，供上层按需处理。
格式参考: VMD 0002, 骨骼帧 111 字节定长记录。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

HEADER_SIG = b"Vocaloid Motion Data"
BONE_RECORD_SIZE = 111
DEFAULT_FPS = 30


@dataclass
class BoneKey:
    frame: int
    pos: tuple[float, float, float]
    rot: tuple[float, float, float, float]  # (x, y, z, w)
    interp: bytes = b""


@dataclass
class VMD:
    version: str
    model_name: str
    bones: dict[str, list[BoneKey]] = field(default_factory=dict)
    morphs: dict[str, list[tuple[int, float]]] = field(default_factory=dict)
    ik: list[tuple[int, list[tuple[str, bool]]]] = field(default_factory=list)
    camera_count: int = 0
    light_count: int = 0
    shadow_count: int = 0

    @property
    def max_frame(self) -> int:
        m = 0
        for keys in self.bones.values():
            if keys:
                m = max(m, keys[-1].frame)
        for keys in self.morphs.values():
            if keys:
                m = max(m, keys[-1][0])
        return m

    @property
    def duration_frames(self) -> int:
        return self.max_frame + 1

    @property
    def duration_seconds(self) -> float:
        return self.max_frame / DEFAULT_FPS


def _decode_name(raw: bytes) -> tuple[str, bool]:
    """Shift-JIS 解码骨骼名。返回 (名字, 是否成功)。"""
    raw = raw.split(b"\x00")[0]
    if not raw:
        return "", True
    try:
        return raw.decode("shift_jis"), True
    except UnicodeDecodeError:
        return raw.decode("shift_jis", errors="replace"), False


class VMDParseError(Exception):
    pass


def parse_vmd(path: str | Path) -> VMD:
    data = Path(path).read_bytes()
    if not data.startswith(HEADER_SIG):
        raise VMDParseError(f"非法文件头: {Path(path).name}")

    sig = data[:30].split(b"\x00")[0].decode("ascii", "replace")
    version = "0002" if "0002" in sig else "0001"
    off = 30

    name_len = 20 if version == "0002" else 10
    model_name, _ = _decode_name(data[off:off + name_len])
    off += name_len

    vmd = VMD(version=version, model_name=model_name)

    # --- 骨骼帧 ---
    if off + 4 > len(data):
        raise VMDParseError("骨骼帧数缺失")
    bone_count, = struct.unpack_from("<I", data, off)
    off += 4

    need = bone_count * BONE_RECORD_SIZE
    if off + need > len(data):
        raise VMDParseError(
            f"骨骼帧数据截断: 需要 {need} 字节, 剩余 {len(data) - off}"
        )

    for _ in range(bone_count):
        name, _ok = _decode_name(data[off:off + 15])
        off += 15
        frame, = struct.unpack_from("<I", data, off)
        off += 4
        px, py, pz, qx, qy, qz, qw = struct.unpack_from("<7f", data, off)
        off += 28
        interp = data[off:off + 64]
        off += 64
        vmd.bones.setdefault(name, []).append(
            BoneKey(frame, (px, py, pz), (qx, qy, qz, qw), interp)
        )

    for keys in vmd.bones.values():
        keys.sort(key=lambda k: k.frame)

    # --- morph 帧 (23 字节/帧: 15 name + 4 frame + 4 weight) ---
    if off + 4 > len(data):
        return vmd
    morph_count, = struct.unpack_from("<I", data, off)
    off += 4
    need = morph_count * 23
    if off + need > len(data):
        raise VMDParseError(
            f"morph 帧数据截断: 需要 {need} 字节, 剩余 {len(data) - off}"
        )
    for _ in range(morph_count):
        name, _ok = _decode_name(data[off:off + 15])
        off += 15
        frame, = struct.unpack_from("<I", data, off)
        off += 4
        weight, = struct.unpack_from("<f", data, off)
        off += 4
        vmd.morphs.setdefault(name, []).append((frame, weight))
    for keys in vmd.morphs.values():
        keys.sort(key=lambda k: k[0])

    # --- 摄像机帧 (61 字节/帧) ---
    if off + 4 > len(data):
        return vmd
    vmd.camera_count, = struct.unpack_from("<I", data, off)
    off += 4
    off += vmd.camera_count * 61

    # --- 光照帧 (28 字节/帧) ---
    if off + 4 > len(data):
        return vmd
    vmd.light_count, = struct.unpack_from("<I", data, off)
    off += 4
    off += vmd.light_count * 28

    # --- 阴影帧 (9 字节/帧) --- 部分导出器不写这一段
    if off + 4 > len(data):
        return vmd
    vmd.shadow_count, = struct.unpack_from("<I", data, off)
    off += 4
    off += vmd.shadow_count * 9

    # --- IK 帧 (0002 才有) --- 部分导出器不写这一段
    if version == "0002" and off + 4 <= len(data):
        ik_count, = struct.unpack_from("<I", data, off)
        off += 4
        for _ in range(ik_count):
            if off + 9 > len(data):
                break
            frame, show, cnt = struct.unpack_from("<IBI", data, off)
            off += 9
            entries: list[tuple[str, bool]] = []
            for _ in range(cnt):
                if off + 21 > len(data):
                    break
                nm, _g = _decode_name(data[off:off + 20])
                off += 20
                enabled = bool(data[off])
                off += 1
                entries.append((nm, enabled))
            vmd.ik.append((frame, entries))

    return vmd


def bone_names_union(paths: list[str | Path]) -> dict[str, int]:
    """统计所有文件中出现的骨骼名与出现次数。"""
    counter: dict[str, int] = {}
    for p in paths:
        try:
            vmd = parse_vmd(p)
        except VMDParseError:
            continue
        for name in vmd.bones:
            counter[name] = counter.get(name, 0) + 1
    return counter


if __name__ == "__main__":
    import sys

    for arg in sys.argv[1:]:
        v = parse_vmd(arg)
        print(f"{arg}")
        print(f"  版本={v.version} 模型={v.model_name!r}")
        print(f"  骨骼={len(v.bones)} 帧={v.max_frame} 时长={v.duration_seconds:.2f}s")
        n_morph_keys = sum(len(k) for k in v.morphs.values())
        print(f"  morph={len(v.morphs)} (keys={n_morph_keys}) ik={len(v.ik)} "
              f"cam={v.camera_count} light={v.light_count}")
        if v.morphs:
            for name, keys in sorted(v.morphs.items())[:10]:
                print(f"    {name}: {len(keys)} keys, "
                      f"max_w={max(w for _, w in keys):.3f}")
