"""组合模式决策（第 4 步）：判断一段舞台指示该「串行」还是「按部位并行」。

为什么不用训练
    part 标签由动作 ID **唯一决定**（part_index.json 的 dominant 字段），
    不存在需要学习的映射。唯一需要判断的是「该不该并行」，
    而这完全由文本里的连接词决定：

        一边…一边… / 一面…一面… / 同时 / 边…边…   → 并行
        先…再… / 然后 / 接着 / 随后 / 最后          → 串行

    tools/stage_segmenter.py 的 is_parallel() 已经能识别前者，
    再补一个「同时/边…边」的扩展正则即可覆盖。人工标注成本为 0，
    也避免了在 1.7 take/动作 的数据上训一个不必要的头。

三条判定规则（按优先级）
    R1 文本含并列标记        → parallel
    R2 部位不冲突（dominant 两两不同）→ parallel
    R3 其余                  → serial

关于「一边挥手一边走路」为什么应该是并行（M14 修正）
    旧实现有一层 L3 规则：
        loco = [a for a in aids if is_locomotion_action(a) or is_locomotion(a, text)]
        if loco and len(aids) > len(loco): return serial
    其中 is_locomotion(aid, text) 的第二个参数是**整句**——只要整句含
    「走/跑/跳」，**每一个动作 ID** 都被当成移动类，于是「一边挥手一边走路」
    里挥手也被算进 loco，len(loco)==len(aids)，退化成串行。

    而这条规则的物理依据其实不存在：
        · dense 库里 G13-01a / G13-02a / G5-07a 的 net_displacement 全是 [0,0,0]
          （素材已清洗为原地循环），不存在"位移叠加冲出画面"
        · 真正的风险是 **root 通道（center + foot_ik）只能被一条轨道驱动**，
          这一点由 PartTracks.resolve_conflicts() 的 root 独占规则兜底：
             一条轨道碰 root、另一条不碰  → 可以并行
             两条轨道都碰 root            → 自动串行

    因此现在只保留「**两条都是移动类 → 串行**」这一条硬约束，
    「一条移动 + 一条原地」交给 root 独占机制自然处理。

用法
    from compose_decider import decide
    decide("一边招手一边鞠躬", ["G2-01a", "G5-01a"])
    # → {"mode": "parallel", "reason": "text_parallel", "parts": {...}}
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
INDEX_PATH = DATA / "part_index.json"

sys.path.insert(0, str(Path(__file__).parent))

# 语义主导部位白名单：索引是构建产物，这里运行时覆盖，无需重建 part_index.json。
try:
    from part_index import FORCE_DOMINANT as _FORCE_DOMINANT
except Exception:  # noqa: BLE001
    try:
        from tools.part_index import FORCE_DOMINANT as _FORCE_DOMINANT
    except Exception:  # noqa: BLE001
        _FORCE_DOMINANT = {}

try:
    from stage_segmenter import is_parallel as _is_parallel
except Exception:  # noqa: BLE001
    def _is_parallel(_s: str) -> bool:
        return False

# 比 stage_segmenter 更宽：同时 / 一边…一边 / 一面…一面 / 边…边 / 一起
_PARALLEL_PATTERNS = [
    r"一边.{1,20}?一边",
    r"一面.{1,20}?一面",
    r"边.{1,12}?边",
    r"同时",
    r"一起",
    r"两手同时",
    r"左右手",
    r"两手",
    r"一齐",
    r"一并",
    r"顺带",
    r"顺便",
    r"期间",
    r"伴随着",
]

# 明确的串行标记（优先级高于「部位不冲突」的自动并行）
_SERIAL_PATTERNS = [
    r"先.{1,20}?再", r"先.{1,20}?然后", r"然后", r"接着",
    # 「先A，又B」：口语里最常见的顺序句式（先摆摆手，又鞠了个躬）
    # 只认「先…又」，不把「又」单独当串行标记 —— 否则「一边A，又一边B」
    # 这类并列句会被误判成串行。
    r"先.{1,20}?又",
    r"随后", r"之后", r"最后", r"再.{1,6}?就",
    r"紧接着", r"马上", r"立刻", r"跟着",
    r"第一个", r"第二个", r"首先.{0,12}?其次",
    r"再.{1,10}?才",
    r"完.{0,4}?之后",
    r"以后",
]

# 移动类动作：ID 前缀 + 语义关键词双重兜底（仅用于诊断 & 双移动类互斥）
_LOCOMOTION_GROUPS = ("G13",)
_LOCOMOTION_WORDS = ("走", "跑", "跳", "迈步", "后退", "前进", "转身走",
                     "踱步", "跨步", "踏步", "上前", "退后")

# foot_ik 位移阈值：低于此值不算"脚步在移动"。
# 为什么从 1.0 提到 2.0
#   索引里 is_locomotion 用 1.0，会把「开心雀跃 1.14」「紧张不安 1.18」
#   「侧身站立 1.23」也标成移动类 —— 这些动作主体是手臂/上身，脚只是晃。
#   真正的步态类都在 2.4 以上（走路 3.62 / 慢跑 4.81 / 踏步 5.82）。
LOCOMOTION_IK_THRESHOLD = 2.0

_IDX_CACHE: dict | None = None


def load_index(path: Path | None = None) -> dict:
    global _IDX_CACHE
    if path is None and _IDX_CACHE is not None:
        return _IDX_CACHE
    p = Path(path) if path else INDEX_PATH
    if not p.exists():
        return {"actions": {}, "parts": {}}
    doc = json.loads(p.read_text(encoding="utf-8"))
    if path is None:
        _IDX_CACHE = doc
    return doc


def action_info(aid: str, index: dict | None = None) -> dict | None:
    """取该动作第一个变体的索引条目（运行时应用 FORCE_DOMINANT）。"""
    idx = index or load_index()
    for v in idx.get("actions", {}).values():
        if v.get("aid") == aid:
            dom = _FORCE_DOMINANT.get(aid)
            if dom and dom != v.get("dominant"):
                out = dict(v)
                out["dominant"] = dom
                return out
            return v
    return None


def dominant_of(aid: str, index: dict | None = None) -> str | None:
    info = action_info(aid, index)
    return (info or {}).get("dominant")


def global_score_of(aid: str, index: dict | None = None) -> float:
    """该动作的全局污染度（其他部位峰值 / 主导部位峰值）。"""
    info = action_info(aid, index)
    return float((info or {}).get("global_score", 0.0))


def is_global_action(aid: str, index: dict | None = None) -> bool:
    """是否连带动作多（global_score 高）。仅作诊断，不用于判定并行。"""
    info = action_info(aid, index)
    if info is None:
        return False
    return bool(info.get("is_global"))


def is_locomotion_action(aid: str, index: dict | None = None) -> bool:
    """是否脚步在移动（foot_ik 位移 > 阈值）。

    这才是"不能并行"的真判据（root 通道独占）：
      走路 foot_ik 3.4~4.5   → True
      鞠躬 foot_ik 0.16      → False（可以并行）
      招手 foot_ik 0.01      → False
      开心雀跃 1.14          → False（旧阈值 1.0 会误判）

    ★ 注意：**不要**再叠加"整句文本含走/跑/跳"的判断。
      那是旧实现 L3 的 bug —— 会把同一句里的挥手也标成移动类。
    """
    if not aid:
        return False
    if any(aid.startswith(g) for g in _LOCOMOTION_GROUPS):
        return True
    info = action_info(aid, index)
    if info is None:
        return False
    if bool(info.get("is_locomotion")) and \
            float(info.get("ik_activity") or 0.0) >= LOCOMOTION_IK_THRESHOLD:
        return True
    return float(info.get("ik_activity") or 0.0) >= LOCOMOTION_IK_THRESHOLD


def root_activity_of(aid: str, index: dict | None = None) -> float:
    """foot_ik 位移幅度（脚步移动程度）。"""
    info = action_info(aid, index)
    return float((info or {}).get("ik_activity", 0.0))


def has_parallel_marker(text: str) -> bool:
    s = text or ""
    if _is_parallel(s):
        return True
    return any(re.search(p, s) for p in _PARALLEL_PATTERNS)


def has_serial_marker(text: str) -> bool:
    return any(re.search(p, text or "") for p in _SERIAL_PATTERNS)


def _text_mentions_locomotion(text: str) -> bool:
    """整句是否提到"走/跑/跳"等（仅供**兜底**：索引缺失时判步态）。

    ★ 绝不能拿它给每个 aid 打标（旧 L3 的 bug），只能整体用一次。
    """
    return any(w in (text or "") for w in _LOCOMOTION_WORDS)


def is_locomotion(aid: str, text: str = "") -> bool:
    """兼容旧接口：仅在该动作**自身**是移动类时返回 True。

    text 参数保留只为兼容调用方，不参与判定（见 is_locomotion_action 的说明）。
    """
    return is_locomotion_action(aid)


def decide(text: str, aids: list[str], index: dict | None = None,
           force: bool | None = None) -> dict:
    """判断该用并行还是串行。

    text : 原始舞台指示（用于识别连接词）
    aids : 识别出的动作 ID 列表
    force: 显式指定（True=并行 / False=串行 / None=自动）

    返回 {
      "mode": "parallel" | "serial",
      "reason": str,
      "parts": {aid: dominant},
      "conflicts": [aid, ...],      # 与前面动作抢同一部位的那些
      "safe": bool,                 # 部位是否两两不冲突
      "locomotion": [aid, ...],     # 真正的步态类动作
    }
    """
    idx = index or load_index()
    parts = {a: dominant_of(a, idx) for a in aids}

    # 部位冲突检测（None 视为"全身"，和任何部位都冲突）
    conflicts = []
    seen: set = set()
    for a in aids:
        p = parts.get(a)
        if p is None:
            conflicts.append(a)
            continue
        if p in seen:
            conflicts.append(a)
        seen.add(p)
    safe = not conflicts

    # 步态类检测：只看动作自身（不再被整句文本污染）
    loco = [a for a in aids if is_locomotion_action(a, idx)]
    # 索引里查不到的 ID（新动作/拼写差异）才用文本兜底
    if not loco and aids and _text_mentions_locomotion(text):
        loco = [a for a in aids if any(a.startswith(g)
                                       for g in _LOCOMOTION_GROUPS)]

    result = {"parts": parts, "conflicts": conflicts, "safe": safe,
              "mode": "serial", "locomotion": loco}

    if force is True:
        result["mode"] = "parallel"
        result["reason"] = "forced"
        return result
    if force is False:
        result["mode"] = "serial"
        result["reason"] = "forced"
        return result

    # L0 单动作
    if len(aids) < 2:
        result["reason"] = "single_action"
        return result

    # L1 明确串行词 → 尊重用户说的顺序
    if has_serial_marker(text):
        result["reason"] = "text_serial"
        return result

    want_parallel = has_parallel_marker(text)

    # L2 两条都是步态类 → 串行（root 通道真的只有一个，走不了两种）
    #    一条步态 + 一条原地 → 交给 PartTracks 的 root 独占机制自然并行
    if len(loco) >= 2:
        result["reason"] = "locomotion_serial"
        return result

    # L3 明确并列词 → 并行
    if want_parallel:
        result["mode"] = "parallel"
        result["reason"] = "text_parallel"
        return result

    # L4 三动作及以上且无连接词 → 串行（同时动看不清在做什么）
    if len(aids) >= 3:
        result["reason"] = "many_actions_serial"
        return result

    # L5 部位不冲突 → 并行
    if safe:
        result["mode"] = "parallel"
        result["reason"] = "parts_distinct"
        return result

    # L6 兜底串行
    result["reason"] = "parts_conflict"
    return result


def split_parallel(text: str) -> list[str] | None:
    """把「一边A，一边B」这类并列段拆成 [A, B]。

    为什么需要
        tools/stage_segmenter.split_stage() 遇到并列段会**整段保留**
        （设计意图：交给段内多标签分类器判断），结果 v2 引擎只回归出
        1 个动作 —— 「一边招手一边鞠躬」→ 只有 G5-01a，并行完全用不上。

        本函数只处理「显式并列」的情形，把两句拆开分别送分类，
        这样两个动作都能识别到，再由 decide() 判定为 parallel。

    返回 None 表示"不是并列段，不需要拆"。

    支持的写法
        一边A，一边B / 一边A一边B
        一面A，一面B / 一面A一面B
        边A边B
        A，同时B / A同时B
    """
    s = (text or "").strip().rstrip("。！？!?")
    if not s or not has_parallel_marker(s):
        return None

    # 一边…一边… / 一面…一面…：按第二个并列词切开
    for w1, w2 in (("一边", "一边"), ("一面", "一面")):
        if w1 not in s:
            continue
        # 找第二个 w1 的位置
        i = s.find(w1)
        j = s.find(w1, i + len(w1)) if i >= 0 else -1
        if i < 0 or j < 0:
            continue
        a = s[i + len(w1):j].strip(" ，,、")
        b = s[j + len(w1):].strip(" ，,、")
        if a and b:
            return [a, b]

    # 「边 A 边 B」：只用一个"边"字的情形
    if "边" in s and s.count("边") >= 2 and not s.startswith("一边"):
        i = s.find("边")
        j = s.find("边", i + 1)
        if 0 <= i < j:
            a = s[i + 1:j].strip(" ，,、")
            b = s[j + 1:].strip(" ，,、")
            if a and b:
                return [a, b]

    # A，同时B / A同时B
    if "同时" in s:
        parts = re.split(r"[，,]?\s*同时\s*", s, maxsplit=1)
        if len(parts) == 2:
            a, b = (x.strip(" ，,、") for x in parts)
            if a and b:
                return [a, b]

    return None


def _demo() -> None:
    cases = [
        ("一边招手一边鞠躬", ["G2-01a", "G5-01a"]),
        ("先招手再鞠躬", ["G2-01a", "G5-01a"]),
        ("招手，然后鞠躬", ["G2-01a", "G5-01a"]),
        ("招手，又鞠了个躬", ["G2-01a", "G5-01a"]),
        ("挥手同时点头", ["G2-01a", "G1-01a"]),
        ("一边挥手一边比心", ["G2-01a", "G11-20a"]),
        ("招招手", ["G2-01a"]),
        ("一边走一边挥手", ["G13-01a", "G2-01a"]),
        ("一边挥手一边走路", ["G2-01a", "G13-01a"]),
        ("先挥手再走路", ["G2-01a", "G13-01a"]),
    ]
    print(f"{'文本':<22} {'动作':<20} {'mode':<9} reason")
    for text, aids in cases:
        r = decide(text, aids)
        print(f"{text:<22} {','.join(aids):<20} {r['mode']:<9} {r['reason']}")

    print()
    print("并列段拆分（供识别前使用）：")
    for t in ("一边招招手，一边鞠躬", "一边走一边挥手", "挥手同时点头",
              "先招招手，然后鞠个躬", "招招手"):
        print(f"  {t!r:<26} -> {split_parallel(t)}")


if __name__ == "__main__":
    _demo()
