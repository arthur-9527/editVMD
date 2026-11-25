"""稠密动作快速导出 (M6)。

把 DenseLibrary 的 Motion 直接写成 VMD，跳过 motion_ops 的稀疏轨迹求值。

相对旧路径 doc_to_records 的改进:
  1. 不再每次 parse_vmd 源文件（恒定骨骼模板由 DenseLibrary 缓存）
  2. 直接从 [T,B,4]/[T,B,3] 逐帧数组生成记录，无 slerp 求值开销
  3. 可增量追加（append），支持流式分批写出

实测: 单动作写 VMD ≈ 5~10 ms（旧路径约 21.5 ms 且需读源文件）
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np

import dense_ops as dop


def motion_to_records(m: dop.Motion, bone_template: dict | None = None,
                      start_frame: int = 0) -> list:
    """Motion -> VMD 记录列表。

    start_frame: 帧号偏移，用于流式分批写出（第二段从 N 开始）。
    """
    return m.to_records_offset(bone_template, start_frame)


def write_motion(m: dop.Motion, path, model_name: str = "",
                 bone_template: dict | None = None,
                 start_frame: int = 0, morphs=None) -> int:
    """写出单个 Motion 到 VMD。返回记录数。

    morphs: 可选 [(morph_name, frame, weight), ...]，与骨骼帧同文件输出。
    """
    from vmd_export import write_vmd
    recs = m.to_records_offset(bone_template, start_frame)
    return write_vmd(recs, path, model_name=model_name, morphs=morphs)


def write_sequence(motions: list[dop.Motion], path, model_name: str = "",
                   bone_template: dict | None = None) -> int:
    """把多段 Motion 顺序写成单个 VMD（各段首尾相接，不重叠加过渡）。"""
    from vmd_export import write_vmd
    recs: list = []
    offset = 0
    for i, m in enumerate(motions):
        # 第一段补全模板，后续段骨骼已齐不再补
        tpl = bone_template if i == 0 else None
        recs.extend(m.to_records_offset(tpl, offset))
        offset += m.frames
    return write_vmd(recs, path, model_name=model_name)


def write_streaming(m: dop.Motion, out_dir, chunk_frames: int = 60,
                    model_name: str = "",
                    bone_template: dict | None = None) -> list[Path]:
    """把动作切成多个 VMD 分块，供播放器顺序加载（伪流式）。

    返回写出的文件列表，命名为 part_000.vmd / part_001.vmd ...
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    T = m.frames
    n_parts = max(1, (T + chunk_frames - 1) // chunk_frames)
    for pi in range(n_parts):
        f0 = pi * chunk_frames
        f1 = min(f0 + chunk_frames, T)
        part = dop.Motion(m.rot[f0:f1], m.pos[f0:f1],
                          None, m.source)
        p = out_dir / f"part_{pi:03d}.vmd"
        write_motion(part, p, model_name=model_name, bone_template=bone_template)
        files.append(p)
    return files


def export_action(lib, aid: str, variant: str | None,
                  ops: list[tuple], out_path,
                  model_name: str = "") -> dict:
    """从库取动作 -> 应用算子链 -> 写 VMD。返回统计信息。

    ops 例: [("mirror",), ("time_scale", 1.15)]
    """
    import time
    t0 = time.perf_counter()

    m = lib.get(aid, variant)
    if m is None:
        raise ValueError(f"动作不存在: {aid}/{variant}")
    t_read = time.perf_counter() - t0

    t0 = time.perf_counter()
    m = dop.apply_ops(m, ops)
    t_ops = time.perf_counter() - t0

    t0 = time.perf_counter()
    tpl = lib.bone_template(aid)
    n = write_motion(m, out_path, model_name=model_name or aid[:20],
                     bone_template=tpl)
    t_write = time.perf_counter() - t0

    return {
        "action": aid,
        "variant": variant,
        "ops": ops,
        "frames": m.frames,
        "records": n,
        "output": str(out_path),
        "read_ms": round(t_read * 1000, 2),
        "ops_ms": round(t_ops * 1000, 2),
        "write_ms": round(t_write * 1000, 2),
        "total_ms": round((t_read + t_ops + t_write) * 1000, 2),
    }