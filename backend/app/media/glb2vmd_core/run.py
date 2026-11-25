"""进程内入口：`convert(glb, pmx, out)` → 写出 MMD `.vmd`。

与原 CLI（`glb2vmd.py`）的区别：
  * 不打印任何东西（原来 print 一堆体检信息）；
  * 不写 `.report.json`（那是给人看的）；
  * 不做回读校验 / 预览 GIF（preview.py 未内嵌）。
只做功能本身：读取 .glb + .pmx → 重定向 → 写 .vmd。

出错抛异常（ValueError / 底层 OSError），由上层 `media/glb2vmd.py` 包装成
可读中文错误（MediaError）。
"""

from __future__ import annotations

from pathlib import Path

from .retarget import retarget
from .vmd_writer import write_vmd


def convert(
    glb: Path | str,
    pmx: Path | str,
    out: Path | str,
    *,
    scale: str | float = "auto",
    ref_frame: int = 0,
    frame_start: int = 0,
) -> Path:
    """把 Mixamo `.glb` 重定向为 MMD `.vmd`，返回输出路径。"""
    glb_p = Path(glb)
    pmx_p = Path(pmx)
    out_p = Path(out)

    if not glb_p.is_file():
        raise ValueError(f"glb 文件不存在：{glb_p}")
    if not pmx_p.is_file():
        raise ValueError(f"PMX 模型不存在：{pmx_p}")

    scale_val = None if str(scale).lower() == "auto" else float(scale)
    res = retarget(
        str(glb_p),
        str(pmx_p),
        scale=scale_val,
        ref_frame=int(ref_frame),
        verbose=False,
    )
    out_p.parent.mkdir(parents=True, exist_ok=True)
    write_vmd(res, str(out_p), model_name="", frame_start=int(frame_start))
    return out_p


__all__ = ["convert"]
