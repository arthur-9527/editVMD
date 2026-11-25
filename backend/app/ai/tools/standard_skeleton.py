"""标准骨架（youla 抽取）的**读取层**。

数据真源是同目录的 `standard_skeleton.json`（由 `scripts/extract_standard_skeleton.py`
从 youla.pmx 抽取，产物已提交入库）。本模块只负责把 JSON 读成结构化对象，
供两处使用：

  1. `ai/bone_map.py`：构造「让 LLM 把非标准模型映射到标准骨」的提示词；
  2. `ai/tools/mmd_ref.py` / `get_mmd_knowledge`：领域知识里说明标准骨架的来源。

★ 为什么会有两份「标准骨」资料
  * 本文件：**机器可读**、带父骨与静止坐标、只有 29 根**关键骨**（映射/校验用）；
  * `mmd_ref.BONE_SPECS` / `docs/mmd/03-bones-standard.md`：**人工注解**的 82 骨表
    （给 AI 读说明、轴约定、幅度建议）。
  两者互补：机器该判的看本文件，人/模型该读的看 82 骨表。

★ 读不到 JSON 时不抛异常：返回空骨架，调用方（bone_map）自动退化为「只用内置
  关键骨名清单」。绝不因为缺数据把模型载入链路打断。
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

log = logging.getLogger("editvmd.ai.standard_skeleton")

_JSON_PATH = Path(__file__).resolve().parent / "standard_skeleton.json"

# 兜底关键骨清单：与 standard_skeleton.json 的 key_bones 同源。
# ★ 只在 JSON 缺失/损坏时使用，顺序与 JSON 保持一致。
FALLBACK_KEY_BONES: tuple[str, ...] = (
    "全ての親",
    "センター",
    "グルーブ",
    "腰",
    "下半身",
    "上半身",
    "上半身2",
    "上半身3",
    "首",
    "頭",
    "両目",
    "左肩",
    "右肩",
    "左腕",
    "右腕",
    "左ひじ",
    "右ひじ",
    "左手首",
    "右手首",
    "左足",
    "右足",
    "左ひざ",
    "右ひざ",
    "左足首",
    "右足首",
    "左つま先",
    "右つま先",
    "左足ＩＫ",
    "右足ＩＫ",
)


@lru_cache(maxsize=1)
def load() -> dict[str, Any]:
    """读 standard_skeleton.json；失败返回最小可用结构（空 key_bones + 兜底名）。"""
    try:
        data = json.loads(_JSON_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("标准骨架 JSON 不是对象")
        return data
    except Exception as exc:  # noqa: BLE001 - 缺文件也不该让 AI 侧崩
        log.warning("[bone_map] 读取标准骨架失败（将用兜底清单）：%s", exc)
        return {
            "version": 0,
            "source": "fallback",
            "boneCount": 0,
            "key_bones": [],
            "all_bones": [],
        }


def key_bone_names() -> list[str]:
    """关键骨名（按标准骨架顺序）。JSON 坏掉时回落到 FALLBACK_KEY_BONES。"""
    names = [str(b.get("name") or "") for b in load().get("key_bones") or []]
    names = [n for n in names if n]
    return names or list(FALLBACK_KEY_BONES)


def key_bones() -> list[dict[str, Any]]:
    """关键骨完整信息（含 en / parent / pos）。缺 JSON 时只有名字。"""
    rows = load().get("key_bones") or []
    if rows:
        return list(rows)
    return [{"name": n, "en": "", "parent": -1, "parentName": "", "group": "", "pos": None} for n in FALLBACK_KEY_BONES]


def source_text() -> str:
    """一句话描述来源（写进提示词 / 文档）。"""
    data = load()
    src = str(data.get("source") or "")
    count = data.get("boneCount") or 0
    if not src:
        return "内置关键骨清单（未找到 standard_skeleton.json）"
    return f"{src}，全骨 {count} 根；关键骨 {len(key_bone_names())} 根"


def reference_text() -> str:
    """给 LLM / 领域知识读的标准骨速览文本。"""
    lines = ["# 标准骨骼（youla 抽取）", "", f"来源：{source_text()}", ""]
    for b in key_bones():
        pos = b.get("pos")
        pos_txt = ""
        if isinstance(pos, (list, tuple)) and len(pos) == 3:
            pos_txt = f" pos=({pos[0]:.2f},{pos[1]:.2f},{pos[2]:.2f})"
        parent = b.get("parentName") or b.get("parent")
        lines.append(f"- {b.get('name')}（{b.get('en') or '-'}）父={parent}{pos_txt}")
    return "\n".join(lines)
