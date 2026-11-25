"""非标准模型 → 标准骨骼（youla）的**一次性 LLM 映射**。

问题
----
项目的动作生成 / VMD 交换一律用一套固定日文标准骨名（センター / 上半身2 / 左ひじ …）。
如果用户载入的模型骨名不标准（英文、简繁差异、缺 上半身3、全半角不同），
标准骨名写出的动作轨就会**静默失效**（模型不动），这正是「骨骼不匹配」的根因。

做法
----
载入非标准模型时，把该模型的可旋转/可见骨（已在前端按 PMX flags 过滤）连同
标准关键骨清单一并交给 LLM，请它输出：

    {"is_human": true, "reason": "…", "mapping": {"センター": "<模型骨名或 null>", …}}

然后把结果**严格校验**（值必须逐字来自给定模型骨名，且不允许两标准骨撞同一模型骨），
缓存下来供后续 VMD 导入复用。

设计约束
--------
* **fail-open**：LLM 不可用 / 超时 / 返回不可解析，一律退化为启发式映射（同名 + 英文 +
  别名），并且不把模型判成非人物。绝不因为「AI 挂了」或「网络慢」拦住用户载模型。
* **不猜**：只有 LLM 明确 `is_human=false` 才允许前端拒载；启发式只做提示。
* 单次调用：`max_turns=1`、无工具、无 MCP、无 setting 源 —— 只做一次结构化问答。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import settings
from .tools import standard_skeleton as std

log = logging.getLogger("editvmd.ai.bone_map")

LLM_TIMEOUT_SECONDS = 25.0
_CACHE_SCHEMA = 1

# 进程内缓存：fingerprint -> 结果
_MEM_CACHE: dict[str, dict[str, Any]] = {}

# 标准关键骨的英文名（启发式用；youla 的 PMX english_name 多为空/错，不可依赖）
STANDARD_EN: dict[str, str] = {
    "全ての親": "root",
    "センター": "center",
    "グルーブ": "groove",
    "腰": "waist",
    "下半身": "lower_body",
    "上半身": "upper_body",
    "上半身2": "upper_body2",
    "上半身3": "upper_body3",
    "首": "neck",
    "頭": "head",
    "両目": "both_eyes",
    "左肩": "left_shoulder",
    "右肩": "right_shoulder",
    "左腕": "left_upper_arm",
    "右腕": "right_upper_arm",
    "左ひじ": "left_elbow",
    "右ひじ": "right_elbow",
    "左手首": "left_wrist",
    "右手首": "right_wrist",
    "左足": "left_upper_leg",
    "右足": "right_upper_leg",
    "左ひざ": "left_knee",
    "右ひざ": "right_knee",
    "左足首": "left_ankle",
    "右足首": "right_ankle",
    "左つま先": "left_toe",
    "右つま先": "right_toe",
    "左足ＩＫ": "left_leg_ik",
    "右足ＩＫ": "right_leg_ik",
}

# 名称折叠：全角→半角、假名变体、常见异体字
_FOLD_PAIRS = {
    "ひざ": "膝",
    "ひじ": "肘",
    "つま先": "爪先",
    "人指": "人差指",
    "ＩＫ": "IK",
}
_FULLWIDTH = {chr(0xFF01 + i): chr(0x21 + i) for i in range(0x5E)}
_FULLWIDTH["　"] = " "


def _norm(text: str) -> str:
    """归一化骨名：全角→半角、去空白/下划线/点/连字符、小写、假名变体折叠。"""
    s = str(text or "")
    s = "".join(_FULLWIDTH.get(ch, ch) for ch in s)
    s = s.lower().replace("_", "").replace("-", "").replace(".", "").replace(" ", "")
    for a, b in _FOLD_PAIRS.items():
        s = s.replace(a.lower(), b.lower())
    return s


def fingerprint(model_bones: list[dict[str, Any]], pmx_sha256: str | None = None) -> str:
    """由「模型骨名集合（+ 可选 PMX 字节哈希）」算稳定指纹。"""
    names = sorted(_norm(b.get("name") or "") for b in model_bones)
    raw = "|".join(names)
    if pmx_sha256:
        raw += "#" + str(pmx_sha256)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------- 磁盘缓存


def _safe_asset_id(asset_id: str | None) -> str | None:
    """只接受简单的资源 id，避免路径穿越。"""
    if not asset_id:
        return None
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", str(asset_id)):
        return str(asset_id)
    return None



def _read_disk_cache(asset_id: str | None) -> dict[str, Any] | None:
    path = _cache_path(asset_id)
    if not path or not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("schema") == _CACHE_SCHEMA:
            return data
    except Exception as exc:  # noqa: BLE001 - 缓存坏了当没有
        log.warning("[bone_map] 读缓存失败 %s：%s", path, exc)
    return None


def _write_disk_cache(asset_id: str | None, result: dict[str, Any]) -> None:
    path = _cache_path(asset_id)
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"schema": _CACHE_SCHEMA, **result}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - 写不进缓存不影响本次结果
        log.warning("[bone_map] 写缓存失败 %s：%s", path, exc)


def _cache_path(asset_id: str | None) -> Path | None:
    sid = _safe_asset_id(asset_id)
    if not sid:
        return None
    return settings.storage_root / "models" / sid / "bone_map.json"


# ---------------------------------------------------------------- 提示词


def build_prompt(model_name: str, model_bones: list[dict[str, Any]]) -> str:
    """构造一次性映射提示词（仅输出 JSON）。"""
    keys = std.key_bone_names()
    lines: list[str] = []
    for b in model_bones:
        name = str(b.get("name") or "")
        if not name:
            continue
        bits = [name]
        en = str(b.get("nameEn") or "").strip()
        if en:
            bits.append(f"en={en}")
        parent = b.get("parent")
        if parent not in (None, "", -1):
            bits.append(f"parent={parent}")
        pos = b.get("pos")
        if isinstance(pos, (list, tuple)) and len(pos) == 3:
            try:
                bits.append(f"pos=({float(pos[0]):.1f},{float(pos[1]):.1f},{float(pos[2]):.1f})")
            except (TypeError, ValueError):
                pass
        if b.get("ik"):
            bits.append("IK")
        lines.append("  - " + " | ".join(bits))

    return (
        "你是 MMD(PMX) 骨骼映射助手。任务：把「标准骨骼」映射到「目标模型骨骼」。\n"
        "\n"
        "# 标准骨骼（来自 youla 模型，日文名）\n"
        + "\n".join(f"  - {n}" for n in keys)
        + "\n\n# 目标模型候选骨骼（name | 英文名 | 父索引 | 静止坐标 | IK）\n模型名："
        + (model_name or "(未知)")
        + "\n"
        + ("\n".join(lines) if lines else "  (空)")
        + "\n\n"
        "# 输出要求（务必严格遵守）\n"
        "1. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。\n"
        "2. 形状：\n"
        '   {"is_human": true/false, "reason": "中文一句话", "mapping": {"<标准骨名>": "<目标模型骨名或 null>"}}\n'
        "3. is_human：判断目标模型是不是『可动的人形骨骼』。\n"
        "   - 是人物（头/躯干/四肢/两足）→ true；\n"
        "   - 明显不是人物（道具/武器/车辆/只有单肢/没有躯干头颈）→ false。\n"
        "4. mapping：key 必须是上面『标准骨骼』里的名字，必须**全部出现**。\n"
        "5. value 必须**逐字**取自上面的『目标模型候选骨骼』名字；\n"
        "   目标模型没有对应骨时写 null；**绝不编造**不存在的名字。\n"
        "6. 一个目标骨最多被一根标准骨占用；拿不准就写 null。\n"
        "7. 当 is_human=false 时，mapping 的值全部写 null。\n"
    )


# ---------------------------------------------------------------- 解析 / 校验


def parse_llm_json(text: str) -> dict[str, Any] | None:
    """从 LLM 文本里抠出第一个 JSON 对象（容忍 ```json 围栏 / 前后废话）。"""
    if not text:
        return None
    s = text.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", s, re.S)
    if fence:
        s = fence.group(1).strip()
    start = s.find("{")
    end = s.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(s[start : end + 1])
    except Exception:  # noqa: BLE001 - 不可解析就当没有
        return None
    return obj if isinstance(obj, dict) else None


def validate_mapping(
    raw: Any, model_names: set[str]
) -> tuple[dict[str, str | None], list[str], list[str]]:
    """校验 LLM 的 mapping。

    Returns:
        (合法映射（只含标准 key 骨）, 非法/被丢弃的项描述, 未映射的标准骨)
    """
    keys = std.key_bone_names()
    mapping: dict[str, str | None] = {k: None for k in keys}
    invalid: list[str] = []
    used: dict[str, str] = {}

    if not isinstance(raw, dict):
        return mapping, ["mapping 不是对象"], list(keys)

    for key in keys:
        if key not in raw:
            continue
        value = raw.get(key)
        if value is None or value == "":
            continue
        value_s = str(value)
        if value_s not in model_names:
            invalid.append(f"{key}→{value_s}(不存在)")
            continue
        if value_s in used:
            invalid.append(f"{key}→{value_s}(与 {used[value_s]} 冲突)")
            continue
        used[value_s] = key
        mapping[key] = value_s

    unmapped = [k for k in keys if mapping.get(k) is None]
    return mapping, invalid, unmapped



# ---------------------------------------------------------------- 启发式映射


def _side_of(name: str) -> str:
    """只在**明确的前缀**上判左右，避免 lowerleg / leg 这类词被误判。"""
    s = str(name or "").strip()
    low = s.lower()
    if s.startswith("左") or low.startswith("left") or low.startswith("l_"):
        return "L"
    if s.startswith("右") or low.startswith("right") or low.startswith("r_"):
        return "R"
    return ""


# 关节部位关键词（日文/中/英），用于「左右 + 部位」匹配。
# ★ 顺序敏感：上/下半身、上/下臂、上/下腿 先匹配，宽泛词（arm / leg）只作兜底，
#   否则 左ひざ 会被「leg」抢到 LeftUpperLeg。
_PART_KW: dict[str, tuple[str, ...]] = {
    "上半身3": ("上半身3", "upperbody3", "spine2"),
    "上半身2": ("上半身2", "upperbody2", "spine1", "chest"),
    "上半身": ("上半身", "upperbody", "spine"),
    "下半身": ("下半身", "lowerbody", "pelvis", "hips"),
    "腰": ("腰", "waist"),
    "グルーブ": ("グルーブ", "groove"),
    "センター": ("センター", "center"),
    "全ての親": ("全ての親", "master", "root"),
    "首": ("首", "neck"),
    "頭": ("頭", "head"),
    "両目": ("両目", "botheyes", "eye"),
    "肩": ("肩", "shoulder", "clavicle"),
    "腕": ("腕", "upperarm", "arm"),
    "ひじ": ("ひじ", "肘", "elbow", "forearm", "lowerarm"),
    "手首": ("手首", "wrist", "hand"),
    "足": ("足", "upperleg", "thigh", "upleg"),
    "ひざ": ("ひざ", "膝", "knee", "lowerleg", "shin", "calf"),
    "足首": ("足首", "ankle", "foot"),
    "つま先": ("つま先", "爪先", "toe"),
}

# 关键词的排除词：避免「腕」抢到 forearm、「足」抢到 lowerleg
_PART_KW_EXCLUDE: dict[str, tuple[str, ...]] = {
    "腕": ("forearm", "lowerarm", "elbow", "hand", "wrist"),
    "足": ("lowerleg", "shin", "knee", "foot", "ankle", "toe"),
    "頭": ("headtop", "headend"),
}


def heuristic_map(model_bones: list[dict[str, Any]]) -> dict[str, str | None]:
    """规则映射：同名 → 归一化同名/英文名 → 左右+部位关键词。拿不准写 None。

    ★ 三遍扫描且**目标骨去重**：一根模型骨只能被一根标准骨占用，
      避免 全ての親 / センター 同时抢 center 这类错配。
    """
    names = [str(b.get("name") or "") for b in model_bones if b.get("name")]
    by_exact = set(names)
    by_norm: dict[str, str] = {}
    for b in model_bones:
        name = str(b.get("name") or "")
        if not name:
            continue
        by_norm.setdefault(_norm(name), name)
        en = str(b.get("nameEn") or "")
        if en:
            by_norm.setdefault(_norm(en), name)

    out: dict[str, str | None] = {}
    used: set[str] = set()

    def take(key: str, cand: str | None) -> bool:
        if not cand or cand in used:
            return False
        out[key] = cand
        used.add(cand)
        return True

    # ① 完全同名（最高优先）
    for key in std.key_bone_names():
        if key in by_exact:
            take(key, key)

    # ② 归一化同名 / 标准英文名
    for key in std.key_bone_names():
        if out.get(key):
            continue
        std_en = STANDARD_EN.get(key, "")
        hit = by_norm.get(_norm(key))
        if hit is None and std_en:
            hit = by_norm.get(_norm(std_en))
        take(key, hit)

    # ③ 左右 + 部位关键词（只补空缺）
    for key in std.key_bone_names():
        if out.get(key):
            continue
        take(key, _keyword_candidate(key, model_bones))

    for key in std.key_bone_names():
        out.setdefault(key, None)
    return out


def _keyword_candidate(key: str, model_bones: list[dict[str, Any]]) -> str | None:
    is_ik = key.endswith("ＩＫ")
    base = key[1:] if key[:1] in ("左", "右") else key
    if is_ik:
        base = base[: -len("ＩＫ")]
    kws = _PART_KW.get(base)
    if not kws:
        return None
    exclude = _PART_KW_EXCLUDE.get(base, ())
    want_side = _side_of(key)

    for b in model_bones:
        name = str(b.get("name") or "")
        if not name:
            continue
        en = str(b.get("nameEn") or "")
        hay = _norm(name) + "|" + _norm(en)
        if not any(_norm(k) in hay for k in kws):
            continue
        if exclude and any(_norm(x) in hay for x in exclude):
            continue
        if is_ik:
            raw = name + " " + en
            if "ＩＫ" not in raw and "IK" not in raw and "ik" not in _norm(en):
                continue
        if want_side:
            side = _side_of(name) or _side_of(en)
            if side and side != want_side:
                continue
        return name
    return None


def looks_human(model_bones: list[dict[str, Any]]) -> bool:
    """结构启发式：至少有「中轴 + 头 + 两条腿/脚」，才认为像人物。"""
    mapping = heuristic_map(model_bones)
    have_center = mapping.get("センター") or mapping.get("上半身") or mapping.get("腰")
    have_head = mapping.get("頭") or mapping.get("首")
    legs = sum(1 for k in ("左足", "右足", "左ひざ", "右ひざ", "左足首", "右足首") if mapping.get(k))
    return bool(have_center and have_head and legs >= 2)




# ---------------------------------------------------------------- LLM 调用


def _llm_available() -> bool:
    try:
        from . import options as opt

        return bool(settings.ai_enabled and opt.sdk_available() and opt.credentials_present())
    except Exception:  # noqa: BLE001 - 任何异常都当作不可用
        return False


async def _llm_json(prompt: str, timeout: float = LLM_TIMEOUT_SECONDS) -> str | None:
    """跑一次无工具的一次性 query，拼接全部文本块。失败返回 None。"""
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except Exception as exc:  # noqa: BLE001 - SDK 是可选依赖
        log.warning("[bone_map] claude-agent-sdk 不可用：%s", exc)
        return None

    # ★ 这条路径不走 options.build_options()，必须自己确保 ANTHROPIC_*
    #   （写死的网关 / 模型 / 用户 Key）已写入进程环境，否则 CLI 子进程
    #   可能拿到未配置的端点。_ensure_env() 是幂等的。
    from . import options as opt

    opt._ensure_env()

    cwd = Path(settings.ai_workdir) / "_bonemap"
    try:
        cwd.mkdir(parents=True, exist_ok=True)
    except Exception:  # noqa: BLE001 - 建不出就用进程 cwd
        cwd = Path.cwd()

    opts = ClaudeAgentOptions(
        max_turns=1,
        allowed_tools=[],
        disallowed_tools=["Task", "Agent", "Bash", "Write", "Edit", "Read"],
        setting_sources=[],
        permission_mode="dontAsk",
        cwd=str(cwd),
        model=settings.ai_model,
        system_prompt="你是 MMD 骨骼映射助手，只输出符合要求的 JSON，不要任何多余文字。",
    )

    async def _run() -> str:
        parts: list[str] = []
        async for msg in query(prompt=prompt, options=opts):
            content = getattr(msg, "content", None)
            if isinstance(content, list):
                for block in content:
                    text = getattr(block, "text", None)
                    if isinstance(text, str):
                        parts.append(text)
        return "".join(parts)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout)
    except asyncio.TimeoutError:
        log.warning("[bone_map] LLM 映射超时（%.0fs）", timeout)
        return None
    except Exception as exc:  # noqa: BLE001 - 任何失败都退化为启发式
        log.warning("[bone_map] LLM 映射失败：%s", exc)
        return None


# ---------------------------------------------------------------- 对外入口


def _heuristic_result(model_bones: list[dict[str, Any]], reason: str) -> dict[str, Any]:
    mapping = heuristic_map(model_bones)
    unmapped = [k for k, v in mapping.items() if not v]
    return {
        "ok": True,
        "human": looks_human(model_bones),
        "reason": reason,
        "mapping": mapping,
        "unmapped": unmapped,
        "invalid": [],
        "source": "heuristic",
    }


async def map_bones(
    model_name: str,
    model_bones: list[dict[str, Any]],
    *,
    pmx_sha256: str | None = None,
    asset_id: str | None = None,
    use_llm: bool = True,
) -> dict[str, Any]:
    """主入口：标准骨 → 模型骨映射（缓存 → LLM → 启发式）。"""
    if not model_bones:
        return _heuristic_result([], "前端未提供模型骨骼清单")

    fp = fingerprint(model_bones, pmx_sha256)
    cached = _MEM_CACHE.get(fp)
    if cached is not None:
        return {**cached, "source": "cache"}

    disk = _read_disk_cache(asset_id)
    if disk is not None and disk.get("fingerprint") == fp:
        result = {
            "ok": True,
            "human": bool(disk.get("human", True)),
            "reason": str(disk.get("reason") or ""),
            "mapping": disk.get("mapping") or {},
            "unmapped": disk.get("unmapped") or [],
            "invalid": [],
            "source": "cache",
        }
        _MEM_CACHE[fp] = result
        return result

    if use_llm and _llm_available():
        prompt = build_prompt(model_name, model_bones)
        text = await _llm_json(prompt)
        parsed = parse_llm_json(text) if text else None
        if parsed is not None:
            model_names = {str(b.get("name")) for b in model_bones if b.get("name")}
            mapping, invalid, unmapped = validate_mapping(parsed.get("mapping"), model_names)
            human = bool(parsed.get("is_human", True))
            reason = str(parsed.get("reason") or "")
            if not human:
                mapping = {k: None for k in std.key_bone_names()}
                unmapped = list(mapping.keys())
            result = {
                "ok": True,
                "human": human,
                "reason": reason,
                "mapping": mapping,
                "unmapped": unmapped,
                "invalid": invalid,
                "source": "llm",
            }
            _MEM_CACHE[fp] = result
            _write_disk_cache(
                asset_id,
                {"fingerprint": fp, "createdAt": datetime.now(timezone.utc).isoformat(), **result},
            )
            return result
        log.warning("[bone_map] LLM 输出无法解析，退化为启发式")
        result = _heuristic_result(model_bones, "LLM 输出无法解析，已按同名/英文规则映射")
    else:
        result = _heuristic_result(model_bones, "AI 不可用，已按同名/英文规则映射")

    _MEM_CACHE[fp] = result
    return result

