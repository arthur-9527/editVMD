"""VMD 导出器：关键帧数据 -> VMD 二进制。

严格按 MMD 标准写:
  - 30 字节头 "Vocaloid Motion Data 0002"
  - 20 字节模型名 (Shift-JIS)
  - 骨骼帧: 15 名字 + 4 帧号 + 12 pos + 16 rot + 64 插值 = 111 字节
  - morph / camera / light / shadow / IK 段全部写 0（但字段必须存在）
"""
from __future__ import annotations

import struct
from pathlib import Path

HEADER = b"Vocaloid Motion Data 0002" + b"\x00" * 5  # 30 字节


def default_interp() -> bytes:
    """标准线性插值参数（64 字节），与 MMD/本项目导出器一致。

    实测原始 VMD 的插值字节恒为:
      [20]*8 + [107]*8 + [1] + [0]*47
    """
    return bytes([20] * 8 + [107] * 8 + [1] + [0] * 47)


_DEFAULT_INTERP = default_interp()


def _slerp(q0, q1, t):
    import math
    d = sum(a * b for a, b in zip(q0, q1))
    if d < 0:
        q1 = [-x for x in q1]
        d = -d
    if d > 0.9995:
        r = [q0[i] + t * (q1[i] - q0[i]) for i in range(4)]
        n = math.sqrt(sum(x * x for x in r)) or 1.0
        return [x / n for x in r]
    th = math.acos(max(-1.0, min(1.0, d)))
    s = math.sin(th)
    a = math.sin((1 - t) * th) / s
    b = math.sin(t * th) / s
    return [a * q0[i] + b * q1[i] for i in range(4)]


def encode_bone_name(name: str) -> bytes:
    """骨骼名 -> 15 字节 Shift-JIS（补零）。"""
    raw = name.encode("shift_jis")
    if len(raw) > 15:
        raise ValueError(f"骨骼名超过 15 字节: {name!r} ({len(raw)} 字节)")
    return raw + b"\x00" * (15 - len(raw))


def encode_morph_name(name: str) -> bytes:
    """morph 名 -> 15 字节 Shift-JIS（补零）。"""
    raw = name.encode("shift_jis")
    if len(raw) > 15:
        raise ValueError(f"morph 名超过 15 字节: {name!r} ({len(raw)} 字节)")
    return raw + b"\x00" * (15 - len(raw))


def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def write_vmd(records, path, model_name: str = "", morphs=None) -> int:
    """写 VMD 文件。

    records: list of (name_jp, frame, pos3, rot4) 或
             (name_jp, frame, pos3, rot4, interp64)
    morphs:  list of (morph_name_jp, frame, weight)，可为 None
    返回写入的骨骼帧数。
    """
    # 按帧号排序（MMD 习惯，非强制但更规范）
    norm = []
    for rec in records:
        if len(rec) == 5:
            name, frame, pos, rot, interp = rec
        else:
            name, frame, pos, rot = rec
            interp = _DEFAULT_INTERP
        norm.append((int(frame), name, tuple(pos), tuple(rot), interp))
    norm.sort(key=lambda r: (r[1], r[0]))  # 按骨骼名再帧号

    out = bytearray()
    out += HEADER

    mn = model_name.encode("shift_jis")[:20]
    out += mn + b"\x00" * (20 - len(mn))

    out += struct.pack("<I", len(norm))
    for frame, name, pos, rot, interp in norm:
        out += encode_bone_name(name)
        out += struct.pack("<I", frame)
        out += struct.pack("<3f", *pos)
        out += struct.pack("<4f", *rot)
        if len(interp) != 64:
            interp = _DEFAULT_INTERP
        out += interp

    # --- morph 帧 (23 字节/帧: 15 name + 4 frame + 4 weight) ---
    morph_list = []
    for rec in (morphs or []):
        morph_list.append((rec[0], int(rec[1]), _clamp01(float(rec[2]))))
    morph_list.sort(key=lambda r: (r[0], r[1]))

    out += struct.pack("<I", len(morph_list))
    for name, frame, weight in morph_list:
        out += encode_morph_name(name)
        out += struct.pack("<I", frame)
        out += struct.pack("<f", weight)

    # 剩余段：全部写 0（字段必须存在）
    out += struct.pack("<I", 0)  # camera
    out += struct.pack("<I", 0)  # light
    out += struct.pack("<I", 0)  # shadow
    out += struct.pack("<I", 0)  # IK

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(bytes(out))
    return len(norm)


def load_skeleton_map() -> tuple[dict[str, str], dict[str, str]]:
    """返回 (jp_to_en, en_to_jp)。"""
    import json
    root = Path(__file__).resolve().parent.parent
    smap = json.loads((root / "data" / "skeleton_map.json")
                      .read_text(encoding="utf-8"))
    return smap["jp_to_en"], smap["en_to_jp"]


def doc_to_records(doc: dict, source_vmd: str | Path | None = None,
                   en_to_jp: dict[str, str] | None = None) -> list:
    """关键帧 doc -> VMD 记录列表。

    同一骨骼的 rot 与 pos 通道会合并成一条记录。
    keyframes 中缺失的骨骼（恒定被抽稀跳过）从 source_vmd 首帧补全，
    否则 MMD 会使用模型默认姿势导致姿态错误。
    """
    if en_to_jp is None:
        _, en_to_jp = load_skeleton_map()

    T = doc["duration_frames"]

    # 按骨骼收集 rot / pos 两条序列
    rot_series: dict[str, list] = {}   # jp -> [(frame, q4)]
    pos_series: dict[str, list] = {}   # jp -> [(frame, p3)]
    for tr in doc["tracks"]:
        en = tr["bone"]
        jp = en_to_jp.get(en)
        if jp is None:
            continue
        if tr["channel"] == "rot":
            rot_series[jp] = [(int(k[0]),
                               [float(k[1]), float(k[2]),
                                float(k[3]), float(k[4])]) for k in tr["keys"]]
        else:
            pos_series[jp] = [(int(k[0]),
                               [float(k[1]), float(k[2]), float(k[3])])
                              for k in tr["keys"]]

    # 每根骨骼在 rot/pos 两序列帧号并集上求值（各自按既定插值）
    def eval_rot(series, f):
        for i in range(len(series) - 1):
            f0, q0 = series[i]
            f1, q1 = series[i + 1]
            if f0 <= f <= f1:
                if f1 == f0:
                    return q0
                t = (f - f0) / (f1 - f0)
                return _slerp(q0, q1, t)
        return series[-1][1] if f >= series[-1][0] else series[0][1]

    def eval_pos(series, f):
        for i in range(len(series) - 1):
            f0, p0 = series[i]
            f1, p1 = series[i + 1]
            if f0 <= f <= f1:
                if f1 == f0:
                    return p0
                t = (f - f0) / (f1 - f0)
                return [p0[c] + t * (p1[c] - p0[c]) for c in range(3)]
        return series[-1][1] if f >= series[-1][0] else series[0][1]

    data: dict[str, dict[int, list]] = {}
    all_bones = set(rot_series) | set(pos_series)
    for jp in all_bones:
        frames = set()
        if jp in rot_series:
            frames.update(f for f, _ in rot_series[jp])
        if jp in pos_series:
            frames.update(f for f, _ in pos_series[jp])
        for f in frames:
            rot = eval_rot(rot_series[jp], f) if jp in rot_series \
                else [0.0, 0.0, 0.0, 1.0]
            pos = eval_pos(pos_series[jp], f) if jp in pos_series \
                else [0.0, 0.0, 0.0]
            data.setdefault(jp, {})[f] = [pos, rot]

    # 补全缺失骨骼
    filled = 0
    if source_vmd is not None:
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from vmd_lib import parse_vmd
        vmd = parse_vmd(source_vmd)
        for jp, keys in vmd.bones.items():
            if jp in data:
                continue
            first = keys[0]
            data[jp] = {
                0: [list(first.pos), list(first.rot)],
                max(1, T - 1): [list(first.pos), list(first.rot)],
            }
            filled += 1

    records = []
    for jp, frames in data.items():
        for f, (pos, rot) in frames.items():
            records.append((jp, f, pos, rot))
    if filled:
        print(f"  (补全 {filled} 根恒定骨骼，取自源 VMD 首帧)")
    return records


def keyframe_key_to_source(key: str) -> Path | None:
    """key 形如 'G2-01a__G2-01a_v01' -> motion/G2-01a/G2-01a_v01.vmd"""
    root = Path(__file__).resolve().parent.parent
    if "__" not in key:
        return None
    aid, vname = key.split("__", 1)
    p = root / "motion" / aid / f"{vname}.vmd"
    return p if p.exists() else None