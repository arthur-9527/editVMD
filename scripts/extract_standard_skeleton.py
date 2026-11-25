#!/usr/bin/env python3
"""抽取「标准骨骼」——从 youla.pmx 读骨架，产出机器可读的标准骨架 JSON。

为什么需要它
------------
本项目的动作生成（backend/app/motiongen）产出的 VMD 骨名是一套**固定日文标准名**
（センター / 上半身2 / 左ひじ / 左足ＩＫ …）。这份标准名过去只以隐性约定散落在
`motiongen/data/skeleton_map.json`、`docs/mmd/03-bones-standard.md` 里，没有一个
「带父骨 + 静止坐标」的权威文件。

现在以 **youla 模型的真实骨架**为基准抽出来，作为：
  * 前端「载入模型时判断是否就是标准骨架」的参照；
  * 非 youla 模型让 LLM 做骨骼映射时的「标准骨清单」。

`storage/` 被 .gitignore 排除（模型本体不入库），所以本脚本的**产物 JSON 要提交**；
脚本本身可随时重跑再生成，不依赖运行期读模型文件。

用法
----
    backend/.venv/bin/python scripts/extract_standard_skeleton.py
    backend/.venv/bin/python scripts/extract_standard_skeleton.py --pmx /path/to/model.pmx --out /tmp/std.json

依赖：pymeshio（见 backend/requirements.txt，已装在 backend/.venv）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_PMX = (
    REPO_ROOT
    / "storage"
    / "models"
    / "b9f82688d5d04f90b5560d05208f3970"
    / "youla"
    / "youla.pmx"
)
DEFAULT_OUT = REPO_ROOT / "backend" / "app" / "ai" / "tools" / "standard_skeleton.json"

# 关键骨骼：动作生成 / 姿势预设真正会写键的那些大骨。
# ★ 顺序 = 从根到末梢，便于人读；映射时前端按名匹配，与顺序无关。
# ★ 手指（親指０ / 人指１ …）与准标准骨（腕捩 / 手捩 / 肩P / 肩C / 足D）默认**不列入**
#   —— 它们绝大多数模型同名，命名差异集中在下面这些大骨上。
KEY_BONES: list[str] = [
    # 中轴
    "全ての親",
    "センター",
    "グルーブ",
    "腰",
    "下半身",
    "上半身",
    "上半身2",
    "上半身3",
    # 头
    "首",
    "頭",
    "両目",
    # 手臂
    "左肩",
    "右肩",
    "左腕",
    "右腕",
    "左ひじ",
    "右ひじ",
    "左手首",
    "右手首",
    # 腿
    "左足",
    "右足",
    "左ひざ",
    "右ひざ",
    "左足首",
    "右足首",
    "左つま先",
    "右つま先",
    # 腿 IK
    "左足ＩＫ",
    "右足ＩＫ",
]

# 关键骨 → 分组（与 lib/animation.ts: BONE_GROUP_ORDER / bone_ref.py 对齐）
GROUP_OF: dict[str, str] = {
    "全ての親": "センター",
    "センター": "センター",
    "グルーブ": "センター",
    "腰": "センター",
    "下半身": "下半身",
    "上半身": "上半身",
    "上半身2": "上半身",
    "上半身3": "上半身",
    "首": "頭部",
    "頭": "頭部",
    "両目": "顔",
    "左肩": "腕",
    "右肩": "腕",
    "左腕": "腕",
    "右腕": "腕",
    "左ひじ": "腕",
    "右ひじ": "腕",
    "左手首": "腕",
    "右手首": "腕",
    "左足": "足",
    "右足": "足",
    "左ひざ": "足",
    "右ひざ": "足",
    "左足首": "足",
    "右足首": "足",
    "左つま先": "足",
    "右つま先": "足",
    "左足ＩＫ": "IK",
    "右足ＩＫ": "IK",
}


def _pos(v) -> list[float]:
    return [round(float(v.x), 6), round(float(v.y), 6), round(float(v.z), 6)]


def extract(pmx_path: Path) -> dict:
    try:
        from pymeshio.pmx import reader
    except ImportError:  # pragma: no cover - 运行环境问题，提示清楚
        sys.stderr.write(
            "缺少 pymeshio。请用 backend/.venv 运行：\n"
            "  backend/.venv/bin/python scripts/extract_standard_skeleton.py\n"
        )
        raise

    model = reader.read_from_file(str(pmx_path))
    by_name = {b.name: (i, b) for i, b in enumerate(model.bones)}

    missing = [n for n in KEY_BONES if n not in by_name]
    if missing:
        sys.stderr.write(
            f"⚠ 该模型缺少 {len(missing)} 根关键骨：{missing}\n"
            "  （仍会输出已有的；换一个更标准的模型可得到完整表）\n"
        )

    key_bones = []
    for name in KEY_BONES:
        hit = by_name.get(name)
        if hit is None:
            continue
        index, bone = hit
        parent_index = int(bone.parent_index)
        parent_name = ""
        if 0 <= parent_index < len(model.bones):
            parent_name = model.bones[parent_index].name
        key_bones.append(
            {
                "name": name,
                "en": bone.english_name or "",
                "parent": parent_index,
                "parentName": parent_name,
                "group": GROUP_OF.get(name, "その他"),
                "pos": _pos(bone.position),
                "ik": bool(bone.getIkFlag()),
                "rotatable": bool(bone.getRotatable()),
            }
        )

    return {
        "version": 1,
        "source": f"{pmx_path.name} ({model.name}{' / ' + model.english_name if model.english_name else ''})",
        "boneCount": len(model.bones),
        "key_bones": key_bones,
        # 全骨名仅作参考 / 排错；不参与映射（映射只针对 key_bones）
        "all_bones": [b.name for b in model.bones],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="抽取 youla 标准骨架 → JSON")
    ap.add_argument("--pmx", type=Path, default=DEFAULT_PMX, help="源 PMX 路径")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="输出 JSON 路径")
    args = ap.parse_args()

    if not args.pmx.exists():
        sys.stderr.write(
            f"找不到 PMX：{args.pmx}\n"
            "storage/ 不入库，请先用 --pmx 指定本地模型路径。\n"
        )
        return 2

    data = extract(args.pmx)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"✓ 已写出 {args.out}\n"
        f"  源：{data['source']}\n"
        f"  关键骨 {len(data['key_bones'])} 根 / 全骨 {data['boneCount']} 根"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
