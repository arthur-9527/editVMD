"""动作 VMD + 情绪 VMD -> 最终 VMD（编排层）。

职责
----
把两条**互相独立**的产物合成一份 VMD：

    动作 VMD（仅骨骼） ─┐
                        ├─> merge_vmd() ─> 最终 VMD（骨骼 + morph 同文件）
    情绪 VMD / morph 记录 ┘

★ 骨骼段**原样搬运**：解析动作 VMD 的骨骼关键帧后按原样重写，不做任何骨骼级
  改造（骨骼相关处理由上层/后续负责）。

与 text2motion `server/combined.py` 的区别
------------------------------------------
那里直接拿 `motion` 对象写一次；这里拿到的是**动作 VMD 字节**（可能来自本地模型，
也可能来自视频管线），因此在字节/关键帧层做合并，两条来源都能用。
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

log = logging.getLogger("editvmd.expressiongen.combined")


def _safe_model_name(name: str) -> str:
    """VMD 头的模型名必须是 Shift-JIS 可编码字符串，否则退回空。"""
    try:
        (name or "").encode("shift_jis")
        return name or ""
    except UnicodeEncodeError:
        return ""


def merge_vmd(
    action_vmd_bytes: bytes,
    morph_records: list,
    *,
    model_name: str = "",
    drop_action_morphs: bool = True,
) -> tuple[bytes, dict]:
    """把 morph 关键帧合并进动作 VMD。

    parameters
    ----------
    action_vmd_bytes:
        动作 VMD 字节（只含骨骼；若带旧 morph，默认会被丢弃并覆盖）。
    morph_records:
        `[(morph_name_jp, frame, weight), ...]`。
    model_name:
        写进最终 VMD 头的模型名；空则沿用动作 VMD 里的模型名。
    drop_action_morphs:
        True（默认）= 覆盖语义：不保留动作 VMD 里的旧 morph。

    returns
    -------
    (最终 VMD 字节, 统计信息)
    """
    import vmd_lib
    import vmd_export

    if not action_vmd_bytes:
        # 没有动作时也允许产出 morph-only（调用方一般不这样用）
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "combined.vmd"
            vmd_export.write_vmd([], out,
                                 model_name=_safe_model_name(model_name),
                                 morphs=morph_records or [])
            return out.read_bytes(), {
                "bone_records": 0,
                "morph_records": len(morph_records or []),
                "model_name": _safe_model_name(model_name),
            }

    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "action.vmd"
        src.write_bytes(action_vmd_bytes)
        v = vmd_lib.parse_vmd(src)

        records = []
        for name, keys in v.bones.items():
            for k in keys:
                records.append((name, k.frame, k.pos, k.rot, k.interp))

        merged_model = _safe_model_name(model_name) or _safe_model_name(
            v.model_name)

        recs = list(morph_records or [])
        if not drop_action_morphs:
            for name, keys in v.morphs.items():
                for f, w in keys:
                    recs.append((name, f, w))

        out = Path(td) / "combined.vmd"
        vmd_export.write_vmd(records, out, model_name=merged_model,
                             morphs=recs)
        data = out.read_bytes()

    return data, {
        "bone_records": len(records),
        "morph_records": len(recs),
        "model_name": merged_model,
        "source_model": v.model_name,
        "source_bones": len(v.bones),
    }


__all__ = ["merge_vmd"]
