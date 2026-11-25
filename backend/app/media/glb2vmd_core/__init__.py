"""内嵌的 glb2vmd 转换器（Mixamo .glb → MMD .vmd）。

来源：`~/raspi_mmd/glb2vmd` 的源码闭包，**已复制进本系统**，
不再依赖外部目录 / 外部 venv / subprocess。

模块：
    glb_reader.py  glTF/GLB 读取（pygltflib）
    mapping.py     Mixamo → MMD 骨骼映射表
    pmx_reader.py  PMX 模型骨架读取（pymeshio）
    retarget.py    重定向核心（位置 / 旋转 / 腿部 IK 协同）
    vmd_writer.py  VMD 写入（pymeshio）
    run.py         进程内入口 convert()（无 print / 无 report.json）

只改了 retarget.py 的 3 处 import 为包内相对导入，其余保持原样。
"""

from __future__ import annotations

from .run import convert

__all__ = ["convert"]
