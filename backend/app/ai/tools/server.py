"""In-process MCP server：把 32 个编辑器工具暴露给 AI。

★ 关键设计：工具是**薄转发**。
    后端不知道 clip 结构，也不碰 reze-engine；每个工具只是把 (tool, args)
    交给 `ToolBridge`，由浏览器那一侧真正执行，再把结果转成 MCP content。

因此这里只有两张表：
    TOOL_SPECS   工具名 → (描述, 输入 schema)
    forward()    统一转发 + 结果/错误/图片包装

新增工具 = 这张表加一条 + 前端 tools.ts 加一个分派分支。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from . import bone_ref, mmd_ref
from .bridge import ToolBridge

log = logging.getLogger("editvmd.ai.tools.server")

# ---------------------------------------------------------------- 工具规格
#
# schema 用"参数名 → Python 类型"的简写，SDK 会转成 JSON Schema
# （dict→object、list→array、str/int/float/bool 直接映射）。

TOOL_SPECS: list[tuple[str, str, dict[str, Any]]] = [
    # ============================================================ 感知（只读）
    (
        "get_editor_state",
        "读取编辑器当前状态：模型 / 当前片段 / 当前帧 / 选中对象 / 上一步操作。回答前一般先调它。",
        {},
    ),
    (
        "get_model_info",
        "读取当前已加载模型的信息：名字、骨骼数、表情数、材质数、资源 id。",
        {},
    ),
    (
        "list_bones",
        "列出当前模型**全部**骨骼：日文名 / 英文名 / 分组 / 说明 / 父骨索引。做动作前先看它能动哪些骨。",
        {},
    ),
    (
        "list_morphs",
        "列出当前模型的全部表情（Morph）名，如 まばたき / あ / にっこり。",
        {},
    ),
    (
        "get_pose_at_frame",
        "读取某一帧的全身骨骼姿态（世界坐标）。只要给 frame 即可；用于理解当前摆的是什么姿势。",
        {"frame": int},
    ),
    (
        "get_bone_track",
        "读取某根骨骼在当前片段里的全部关键帧（帧号 / 旋转四元数 / 位移 / 插值）。",
        {"bone": str},
    ),
    (
        "get_clip_summary",
        "当前片段概览：总帧数、有哪些骨骼 / 表情轨道、各轨帧数。",
        {},
    ),
    (
        "list_library_clips",
        "列出左侧『动作片段库』里的所有片段：id / 名字 / 帧数 / 是否已存盘。",
        {},
    ),
    (
        "list_arrangement",
        "列出编排视图（时间轴 arrange）里的全部轨道与动作块：轨道 id/名字，"
        "以及每块的 placementId / clipId / 片段名 / 编排区间[start,end) / "
        "clip 内可见区间 in..out / 权重 / 淡入淡出。"
        "用户用 @ 引用了某个编排块时，用它拿到该块所在的轨道与精确区间。",
        {},
    ),
    (
        "list_storage_vmd",
        "列出系统存储里的 VMD 资源：id / 名字 / 帧数 / 来源（uploaded/generated）。",
        {},
    ),

    (
        "get_mmd_knowledge",
        "取 MMD 领域知识（Markdown）。做动作前不确定就查它。"
        "topic 可选："
        "bones（82 根标准骨表：日文/英文/父骨/推荐轴/幅度）、"
        "semistandard（准标准骨：腕捩/手捩/肩P/C/足D/足IK親/腰キャンセル 等）、"
        "xyz（★ 调 X/Y/Z 会得到什么效果 + 意图→joints 配方）、"
        "vmd（VMD 二进制格式）、pmx（PMX 格式）、"
        "rotation（四元数/YXZ/镜像/插值）、morphs（表情名/情绪映射）、"
        "motion（动作 Cookbook：节奏/避雷）、retarget（Mixamo→MMD 重定向）、"
        "app（本软件界面与操作说明）、tools（该调哪个工具）、pitfalls（常见坑）。",
        {"topic": str},
    ),
    # ============================================================ 看图
    (
        "capture_pose_image",
        "把某一帧的骨架渲染成一张棍状图（PNG）发给模型，用于直观判断姿势。"
        "view 可选 front（正视）/ side（侧视）/ top（俯视）。",
        {"view": str, "frame": int},
    ),
    (
        "capture_motion_sheet",
        "把 from..to 这一帧区间抽 count 张骨架图拼成网格（PNG），用于判断动作连贯性。",
        {"from": int, "to": int, "count": int, "view": str},
    ),
    # ============================================================ 原子写（当前片段）
    (
        "set_bone_rotation",
        "设置某根骨在某一帧的旋转（欧拉角，**度**，YXZ 顺序）。会自动插入 / 覆盖该帧关键帧。",
        {"bone": str, "frame": int, "x": float, "y": float, "z": float},
    ),
    (
        "set_bone_translation",
        "设置某根骨在某一帧的位移（VMD 相对坐标）。会自动插入 / 覆盖该帧关键帧。",
        {"bone": str, "frame": int, "x": float, "y": float, "z": float},
    ),
    (
        "set_bone_transform",
        "同时设置某根骨某一帧的旋转与位移。rot / trans 各是 {x,y,z}（旋转为度）。",
        {"bone": str, "frame": int, "rot": dict, "trans": dict},
    ),
    (
        "insert_bone_key",
        "在某根骨的某一帧插入关键帧（姿态取该帧当前采样值，不改变画面）。",
        {"bone": str, "frame": int},
    ),
    (
        "delete_bone_key",
        "删除某根骨某一帧的关键帧。",
        {"bone": str, "frame": int},
    ),
    (
        "move_bone_keys",
        "把某根骨在 frames 里的所有关键帧整体平移 delta 帧。",
        {"bone": str, "frames": list, "delta": int},
    ),
    (
        "set_bone_interpolation",
        "设置某根骨某一帧某通道的 Bézier 控制点。channel ∈ rotation/translationX/Y/Z；cp 是 [{x,y},{x,y}]（0..127）。",
        {"bone": str, "frame": int, "channel": str, "cp": list},
    ),
    (
        "apply_interpolation_preset",
        "给某根骨某一帧套用插值预设：linear / easeIn / easeOut / easeInOut / step。",
        {"bone": str, "frame": int, "preset": str},
    ),
    (
        "set_morph_weight",
        "设置某表情在某一帧的权重（0..1）。会自动插入 / 覆盖关键帧。",
        {"morph": str, "frame": int, "weight": float},
    ),
    (
        "set_ik_enabled",
        "设置某个 IK 在某一帧的开关（步进：保持到下一条）。",
        {"ik": str, "frame": int, "enabled": bool},
    ),
    (
        "set_visibility",
        "设置某一帧的显示 / 隐藏标志。",
        {"frame": int, "visible": bool},
    ),
    (
        "set_frame_count",
        "把当前片段的总长度设为至少 n 帧（只增不减）。",
        {"n": int},
    ),
    # ============================================================ 聚合（生成）
    (
        "apply_pose_preset",
        "把某个标准姿势套到某一帧（一次设置多根骨）。"
        "preset 例：stand/tpose/apose/sit/bow/raise_hand/akimbo。frame 省略时用当前帧。",
        {"preset": str, "frame": int},
    ),
    (
        "pose_body",
        "一次设置多根骨在某一帧的欧拉角。joints 形如 {\"左腕\":{\"x\":..,\"y\":..,\"z\":..}, ...}（度）。",
        {"joints": dict, "frame": int},
    ),
    (
        "generate_action",
        "【动作生成 · 仅骨骼】把一句中文动作描述变成一整段动作，放进左侧『动作片段库』（默认工具 · 快）。"
        "内部三级：①本地动作模型(毫秒级)；②本地识别不出时【自动】改走『文本→视频→动捕』(慢，1~5分钟)；"
        "③都失败才返回『无法生成：原因』(chat/release/空文本不降级)。"
        "适用【原地动作】：挥手/鞠躬/点头/鼓掌/比心/叉腰/耸肩/伸懒腰/原地转圈/原地走跳蹲。"
        "★ 本工具**只生成骨骼、不生成任何表情**。纯面部表情改用 generate_emotion；"
        "要「动作 + 表情」的最终 VMD 改用 generate_vmd。"
        "★ 本地库没有位移：动作含真实位移(向前走两步/后退/冲过去/转身后向前走)，或用户要『精细/高精度/要动捕』，"
        "**直接改用** generate_action_from_text，不要先试它。判据=站立位置是否真的平移(只转圈、脚不挪窝仍算原地)。"
        "做不了会返回『无法生成：原因』——如实转告用户，不要用 generate_motion/pose_body 偷偷拼凑。",
        {"text": str, "name": str, "duration": float},
    ),
    (
        "generate_motion_model",
        "【仅本地动作模型 · 仅骨骼】把一句中文变成整段动作（进动作片段库），不做视频兜底。"
        "★ 普通场景优先用 generate_action（它会自动兜底走视频管线）；本工具仅供显式调用。"
        "示例：挥挥手/鞠个躬/点点头/叉腰/伸懒腰/转个圈/先挥挥手再鞠个躬/一边招手一边鞠躬。"
        "★ 只生成骨骼、不生成表情；纯表情用 generate_emotion，动作+表情用 generate_vmd。"
        "做不了返回『无法生成：原因』，如实告知，不要用其它工具拼凑。",
        {"text": str, "name": str, "duration": float},
    ),
    (
        "generate_motion",
        "给定关键姿势序列，自动补间生成一整段动作并放入动作片段库。"
        "keyposes 形如 [{frame:0,joints:{...}},{frame:30,joints:{...}}]；opts 可含 fps/easing/name。",
        {"keyposes": list, "opts": dict},
    ),
    (
        "generate_walk_cycle",
        "参数化生成一段走路循环（覆盖腿 + 手臂 + 躯干轻微起伏）并放入动作片段库。",
        {"opts": dict},
    ),
    (
        "generate_idle_breath",
        "参数化生成一段待机呼吸循环（胸腔起伏 + 轻微重心偏移）并放入动作片段库。",
        {"opts": dict},
    ),
    (
        "mirror_pose",
        "把指定骨骼（默认全部）在指定帧（默认当前帧）做左右镜像。",
        {"bones": list, "frames": list},
    ),
    (
        "generate_action_from_text",
        "【精细 / 位移专用】文本→动作视频→动捕→MMD 动作（进动作片段库）。"
        "★ 两种情形**直接用它**（不必先试 generate_action）："
        "①含明确位移（站立位置真正平移：向前走/后退/冲过去/转身后向前走；单纯转身/转圈不算）；"
        "②用户要精细/高精度/要动捕。"
        "以固定首帧 pose.png（站立全身照）为起点，首帧不可换、不指定结束帧；耗时约 1~5 分钟，"
        "调用后请告知用户稍候，不要重复调用。失败返回『无法生成：原因』，如实转告，不要改用其它工具拼凑。"
        "★ 本工具**只生成骨骼**；纯面部表情改用 generate_emotion，动作+表情的最终 VMD 用 generate_vmd。",
        {
            "text": str,
            "name": str,
            "duration": int,
            "resolution": str,
            "ratio": str,
        },
    ),
    (
        "generate_action_from_video",
        "【视频再编辑】以一段**已生成的视频**为参考，按修改要求重新生成动作并动捕（进动作片段库）。"
        "★ 用户要调整上一段动作时（幅度大一点/慢一点/换左手/身体再转过去一点）**用它**，不要凭空重新生成。"
        "reference 传上次结果的 video_path（形如 ai_videos/xxx.mp4）或 video_asset_id；"
        "text 只写要改的部分，不复述整段。默认 768P / 4 秒；用户明确要求才传 duration。"
        "参考视频必须是**本会话目录内**的（越权路径会被拒）。"
        "★ 只生成骨骼；纯表情用 generate_emotion，动作+表情用 generate_vmd。",
        {
            "text": str,
            "reference": str,
            "name": str,
            "duration": int,
            "resolution": str,
            "ratio": str,
        },
    ),
    (
        "add_action_to_library",
        "把一份 clip（JSON）直接加入左侧动作片段库，不打断当前编辑。",
        {"name": str, "clip": dict},
    ),
    (
        "generate_emotion",
        "【情绪生成 · 只动脸】用后端**表情小模型**把一句情绪/神情描述变成一整套面部表情（morph），"
        "放进动作片段库（可与骨骼动作片段在编排里叠加）。★ 只有「表情/神情/情绪」类需求才用它。"
        "\n▍输入是**自然口语**（不需要写 morph 名）：开心/生气/难过/惊讶/害羞/无语/疑惑/骄傲/"
        "翻白眼/瞪大眼睛/苦笑/嘟嘴/咧嘴笑/眯着眼笑…… 也支持组合与节奏（「缓缓闭上眼，又猛地睁开」）。"
        "\n▍返回 morph_count / 写入的表情轨；模型里没有的表情会被丢弃并如实回报 dropped。"
        "\n★ 参数：text（情绪/神情描述）；frames（默认 90 ≈ 3 秒；要与某段动作对齐就传动作帧数）；"
        "duration（秒，frames 缺省时用）；blink（默认 true，叠加自主眨眼）；seed；name（片段名）。"
        "\n⚠ 不要用它做身体动作；纯表情也**不要**用 generate_action（那会生成肢体动作）。",
        {
            "text": str,
            "frames": int,
            "duration": float,
            "blink": bool,
            "seed": int,
            "name": str,
        },
    ),
    (
        "generate_vmd",
        "【最终 VMD · 动作 + 表情合并】把一句描述变成**一份完整的 VMD（骨骼 + 表情同文件）**放进动作片段库。"
        "★ 需要「带表情的动作」或用户要「最终 VMD」时用它。"
        "\n▍内部两级路由："
        "① 【正常】本地动作模型生成动作 VMD + 表情小模型生成情绪 VMD → 合并；"
        "② 本地动作模型做不了（有位移 / 精细 / 识别不出）时【自动】改走『文本→视频→动捕』得到动作 VMD，再与情绪 VMD 合并。"
        "\n▍参数：text（身体动作；若同时给了 expression，则 text 只写身体动作）；"
        "expression（情绪/神情，可省略——省略时会自动从 text 里识别情绪）；"
        "name；duration（动作时长秒）；frames（表情帧数，默认 = 动作帧数）；blink（默认 true）；seed。"
        "\n▍耗时：正常毫秒级~秒级；走视频兜底时约 1~5 分钟，调用后请先跟用户说一句稍候。"
        "\n做不了才返回『无法生成：原因』，如实转告，不要改用其它工具拼凑。",
        {
            "text": str,
            "expression": str,
            "name": str,
            "duration": float,
            "frames": int,
            "blink": bool,
            "seed": int,
        },
    ),
    # ============================================================ 存储 / 导入导出
    (
        "save_vmd_to_storage",
        "把当前片段保存到系统存储（origin=generated）。mode 可选 all/motion/morphs。",
        {"name": str, "mode": str},
    ),
    (
        "import_vmd_from_storage",
        "从系统存储按 assetId 导入一份 VMD 到动作片段库。",
        {"asset_id": str},
    ),
    (
        "export_vmd",
        "把当前片段导出为 VMD（all/motion/morphs）并返回 base64，供下载或落盘。",
        {"mode": str},
    ),
    # ============================================================ 精简 / 抖动分析
    (
        "analyze_clip_motion",
        "【只读·先做这步】分析骨骼运动质量：每根骨的峰值角速度 / 抖动 RMS / "
        "尖刺帧数 / 是否属于非人为抖动（verdict = clean|suspect|dirty），"
        "并给出建议去抖的 suspectFrames 区间与骨骼轨密度（密度接近 100% 说明是伪逐帧密集轨，"
        "精简收益大）。★ 判断「要不要去抖」时用它，不要靠肉眼猜。"
        "★ 目标选择：用户在输入框用 `@` 引用了片段时，`editor_context` 里会带 "
        "`id=`（动作库）或 `clipId=` + `in=` + `out=`（编排块）——"
        "把 id/clipId 原样传成 clip_id；若要只处理块内可见区间，把 in/out 传成 clip_in/clip_out。"
        "不传 clip_id = 当前正在编辑的片段。",
        {"clip_id": str, "clip_in": int, "clip_out": int},
    ),
    (
        "simplify_clip",
        "【精简关键帧 · 减帧但保持轨迹】用 RDP 把逐帧密集关键帧抽稀压回稀疏拐点，"
        "并用逐帧采样校验：每骨旋转误差 ≤ max_rotation_deg（默认 1.5°）、位移误差 ≤ max_translation"
        "（默认 0.05）才通过（超预算会自动收紧阈值重跑，仍不达标则退化为保守保留）。"
        "表情 / 相机 / IK / 显示标志原样不动。"
        "★ 推荐流程：先 analyze_clip_motion 看 verdict；若判定为非人为抖动（suspect/dirty）"
        "再传 smooth_sigma 做**局部**去抖（去抖超预算会自动跳过并如实上报），否则只做抽稀。"
        "★ 目标选择：`@动作库:xxx` → clip_id 用 detail 里的 id（整条片段）；"
        "`@编排:轨·xxx[区间]` → clip_id 用 clipId，clip_in/clip_out 用 in/out（**只处理该区间**，"
        "区间外关键帧原样保留）；不传 clip_id = 当前编辑片段。"
        "★ 就地覆盖：不新建条目、不写盘，frameCount 不变（轨道块位置/长度不动），整轮一步可撤销。",
        {
            "clip_id": str,
            "clip_in": int,
            "clip_out": int,
            "rotation_deg": float,
            "translation": float,
            "max_rotation_deg": float,
            "max_translation": float,
            "smooth_sigma": float,
            "smooth_bones": list,
            "smooth_from": int,
            "smooth_to": int,
        },
    ),
]

# 需要把返回体里的 base64 图片转成 MCP image content 的工具
_IMAGE_TOOLS = {"capture_pose_image", "capture_motion_sheet"}


# ---------------------------------------------------------------- 结果包装


def _ok(content: list[dict[str, Any]]) -> dict[str, Any]:
    return {"content": content}


def _err(msg: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": msg}], "is_error": True}


def _to_content(tool: str, data: Any) -> dict[str, Any]:
    """把前端回的数据转成 MCP content。"""
    if isinstance(data, dict) and isinstance(data.get("image_base64"), str):
        text = str(data.get("note") or "已生成骨架图")
        if data.get("path"):
            text += f"（同时落盘：{data['path']}）"
        return _ok(
            [
                {"type": "image", "data": data["image_base64"], "mimeType": "image/png"},
                {"type": "text", "text": text},
            ]
        )
    # 普通结果：序列化成文本（模型可读 JSON）
    try:
        text = json.dumps(data, ensure_ascii=False, indent=2, default=str)
    except (TypeError, ValueError):
        text = str(data)
    # 结果过长时截断，避免把上下文撑爆（图片工具不受影响）
    if len(text) > 20000:
        text = text[:20000] + "\n…（结果过长已截断，可缩小查询范围）"
    return _ok([{"type": "text", "text": text}])


# ---------------------------------------------------------------- 统一转发


# ---------------------------------------------------------------- 后端本地工具
#
# 绝大多数工具是「薄转发」到浏览器执行；但动作生成模型跑在后端进程内
# （纯 CPU 推理，见 app/motiongen/），不依赖浏览器。这里把这类工具单独
# 执行，并把生成的 VMD 自动导入前端『动作片段库』。
_BACKEND_TOOLS = {
    "generate_action",
    "generate_motion_model",
    "generate_action_from_text",
    "generate_action_from_video",
    # ★ 情绪生成 + 最终 VMD 合并（后端本地表情引擎 app/expressiongen/）
    "generate_emotion",
    "generate_vmd",
    # ★ 领域知识库：纯本地读取，不经浏览器
    "get_mmd_knowledge",
}

# 本地动作模型「没有结果」时，哪些 operation 值得再用视频管线试一次：
#   unsupported  有动作意图但本地库做不了（跳舞 / 后空翻…）
#   unavailable  本地模型未安装 / 被禁用
# chat（闲聊）/ release（停下）/ 参数错误 一律不降级，避免白白等待 1~5 分钟。
_FALLBACK_OPERATIONS = {"unsupported", "unavailable"}

# 能力1（文本→动作）内部链路最长约 5 分钟，工具桥默认 30s 超时不够，
# 这里直接在后端进程内跑，不受 ToolBridge 超时约束。


async def _import_vmd_bytes(
    bridge: ToolBridge,
    name: str,
    data: bytes,
    *,
    tool: str = "import_vmd_bytes",
    extra: dict[str, Any] | None = None,
) -> tuple[bool, str, dict[str, Any]]:
    """把生成物的**字节**交给浏览器动作库（L2）。

    ★ 生成物只进动作库：不写 storage/vmd、不建 VmdAsset。这里把字节 base64
      通过桥接工具交给前端 parseVmd → 动作库（显示「未存盘」）。
    ★ 表情已由后端生成并合并进字节（见 generate_emotion / generate_vmd），
      前端只负责解析入库；`generate_emotion` 走 import_emotion_vmd_bytes
      以过滤掉当前模型不存在的 morph。

    返回 (是否成功, 备注, 前端附加数据)。
    """
    args: dict[str, Any] = {
        "name": name,
        "data_base64": base64.b64encode(data).decode("ascii"),
    }
    if extra:
        args.update(extra)
    try:
        resp = await bridge.call(tool, args)
        if resp.get("ok"):
            data_out = resp.get("data") or {}
            return True, "", (data_out if isinstance(data_out, dict) else {})
        return False, f"（未能自动加入动作片段库：{resp.get('error')}）", {}
    except Exception as exc:  # noqa: BLE001
        return False, f"（加入动作库失败：{exc}）", {}


async def _video_action_bytes(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """text → 视频管线（i2v → 动捕 → glb2vmd）→ 动作 VMD 字节，**不入库**。

    供 `generate_action_from_text` 与 `generate_vmd`（视频兜底）复用。
    抛出 MediaError（管线失败）/ RuntimeError（配置 / 会话问题）/ ValueError（缺参）。
    """
    text = str(args.get("text") or "").strip()
    if not text:
        raise ValueError("缺少 text（要生成的动作描述）")

    name = str(args.get("name") or "").strip() or text[:24]
    duration = args.get("duration")
    resolution = args.get("resolution")
    ratio = args.get("ratio")

    from ...config import settings
    from ...db import SessionLocal
    from ...media import pipeline

    if not settings.media_enabled:
        raise RuntimeError("媒体功能未启用（EDITVMD_MEDIA_ENABLED=false）")

    session_id = bridge.session_id
    if not session_id:
        raise RuntimeError("会话尚未建立，无法定位本会话的存储目录")

    def _work():
        session = SessionLocal()
        try:
            result, video = pipeline.text_to_vmd(
                session, text, name,
                session_id=session_id,
                duration=int(duration) if duration not in (None, "", 0) else None,
                resolution=str(resolution) if resolution else None,
                ratio=str(ratio) if ratio else None,
            )
            return {
                "name": result["name"],
                "frames": result["frame_count"],
                "bone_count": result["bone_count"],
                "morph_count": result["morph_count"],
                "vmd_bytes": result["vmd_bytes"],
                "video_asset_id": video.id,
                "video_path": video.rel_path.split(f"ai_workspace/{session_id}/", 1)[-1],
            }
        finally:
            session.close()

    return await asyncio.to_thread(_work)


async def _run_action_from_text(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """能力1：text → i2v(pose.png 固定首帧) → 动捕 → glb2vmd → VMD（只进动作库）。"""
    from ...media import MediaError

    text = str(args.get("text") or "").strip()
    try:
        result = await _video_action_bytes(args, bridge)
    except MediaError as exc:
        log.warning("[tool.action_from_text] 无法生成 %r: %s", text, exc)
        return _err(f"无法生成：{exc}")
    except (ValueError, RuntimeError) as exc:
        return _err(f"无法生成：{exc}")
    except Exception as exc:  # noqa: BLE001
        log.exception("[tool.action_from_text] 生成异常")
        return _err(f"动作生成失败：{exc}")

    # 交给浏览器把这**字节**导入『动作片段库』（生成物只进 L2）
    imported, import_note, _extra = await _import_vmd_bytes(
        bridge, result["name"], result["vmd_bytes"],
    )

    payload = {
        "name": result["name"],
        "frames": result["frames"],
        "bone_count": result["bone_count"],
        "morph_count": result["morph_count"],
        # ★ 视频已保存在本会话目录里：下次「再编辑」把它作为 reference 传回来
        "video_asset_id": result.get("video_asset_id"),
        "video_path": result.get("video_path"),
        "已加入动作片段库": imported,
        "note": import_note.strip(),
    }
    return _to_content("generate_action_from_text", payload)


async def _run_action_from_video(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """能力3：参考视频（本会话产出）→ ref2v → 动捕 → VMD → 入库。

    ★ reference 由模型从上一轮工具结果的 video_path / video_asset_id 里传回来；
      本函数的 session_id 来自 bridge（模型不需要、也不允许传）。
    """
    ref = str(args.get("reference") or args.get("video") or "").strip()
    if not ref:
        return _err("缺少 reference（参考视频的 video_path 或 video_asset_id）")

    change = str(args.get("text") or "").strip()
    name = str(args.get("name") or "").strip() or (change[:24] or "视频调整")
    duration = args.get("duration")
    resolution = args.get("resolution")
    ratio = args.get("ratio")

    from ...config import settings
    from ...db import SessionLocal
    from ...media import MediaError
    from ...media import pipeline

    if not settings.media_enabled:
        return _err("无法生成：媒体功能未启用（EDITVMD_MEDIA_ENABLED=false）")

    session_id = bridge.session_id
    if not session_id:
        return _err("无法生成：会话尚未建立，无法定位本会话的存储目录")

    def _work():
        session = SessionLocal()
        try:
            result, video = pipeline.reference_to_vmd(
                session, session_id, ref, change, name,
                duration=int(duration) if duration not in (None, "", 0) else None,
                resolution=str(resolution) if resolution else None,
                ratio=str(ratio) if ratio else None,
            )
            return {
                "name": result["name"],
                "frames": result["frame_count"],
                "bone_count": result["bone_count"],
                "morph_count": result["morph_count"],
                "vmd_bytes": result["vmd_bytes"],
                "video_asset_id": video.id,
                "video_path": video.rel_path.split(f"ai_workspace/{session_id}/", 1)[-1],
                "parent_video_id": video.parent_video_id,
            }
        finally:
            session.close()

    try:
        result = await asyncio.to_thread(_work)
    except MediaError as exc:
        log.warning("[tool.action_from_video] 无法生成 ref=%r: %s", ref, exc)
        return _err(f"无法生成：{exc}")
    except Exception as exc:  # noqa: BLE001
        log.exception("[tool.action_from_video] 生成异常")
        return _err(f"视频再编辑失败：{exc}")

    # 生成物只进 L2：把字节交给浏览器入库（不写 storage/vmd）
    imported, import_note, _extra = await _import_vmd_bytes(
        bridge, result["name"], result["vmd_bytes"],
    )

    payload = {
        "name": result["name"],
        "frames": result["frames"],
        "bone_count": result["bone_count"],
        "morph_count": result["morph_count"],
        "video_asset_id": result.get("video_asset_id"),
        "video_path": result.get("video_path"),
        "parent_video_id": result.get("parent_video_id"),
        "已加入动作片段库": imported,
        "note": import_note.strip(),
    }
    return _to_content("generate_action_from_video", payload)


async def _gen_local(args: dict[str, Any]) -> dict[str, Any]:
    """跑本地动作模型（后端进程内 CPU 推理），返回 motion_model 结果。

    成功：{ok: True, asset_id, name, frames, ...}
    失败：{ok: False, reason, operation, ...}
    """
    text = str(args.get("text") or "").strip()
    if not text:
        return {"ok": False, "reason": "没有提供动作描述", "operation": "empty"}

    name = args.get("name")
    duration = args.get("duration")
    try:
        duration_f = float(duration) if duration not in (None, "", 0) else None
    except (TypeError, ValueError):
        duration_f = None

    from . import motion_model

    def _work() -> dict[str, Any]:
        # ★ 生成物只进 L2：motion_model.generate 只返回字节（不落盘、不入库）
        return motion_model.generate(
            text,
            name=str(name) if name else None,
            duration=duration_f,
        )

    # 阻塞式 CPU 计算，放线程池避免卡事件循环
    return await asyncio.to_thread(_work)


async def _finish_local(
    result: dict[str, Any],
    bridge: ToolBridge,
    *,
    tool: str,
    source: str,
) -> dict[str, Any]:
    """本地模型成功后的收尾：把 VMD **字节**交给动作库（L2）并组装返回体。

    ★ 动作 VMD 只含骨骼；表情由 `generate_emotion` 单独生成、`generate_vmd` 合并。
    """
    # ★ 生成物只进 L2：把字节交给浏览器 parseVmd → 动作库（不写 storage/vmd）
    imported, import_note, _extra = await _import_vmd_bytes(
        bridge, result["name"], result["vmd_bytes"],
    )

    payload = {
        "来源": source,
        "name": result["name"],
        "frames": result["frames"],
        "bone_count": result["bone_count"],
        "morph_count": result["morph_count"],
        "actions": [
            {
                "id": a.get("id"),
                "side": a.get("side"),
                "speed": a.get("speed"),
                "strength": a.get("strength"),
                "confidence": a.get("confidence"),
            }
            for a in (result.get("actions") or [])
        ],
        "elapsed_ms": result.get("elapsed_ms"),
        "已加入动作片段库": imported,
        "note": import_note.strip(),
    }
    # 走视频管线时把参考信息带回，便于后续「视频再编辑」
    if result.get("video_path"):
        payload["video_asset_id"] = result.get("video_asset_id")
        payload["video_path"] = result.get("video_path")
    return _to_content(tool, payload)


def _human_reason(result: dict[str, Any]) -> str:
    """把本地模型的失败原因转成面向用户的中文（不暴露内部术语）。"""
    reason = str(result.get("reason") or "").strip()
    if not reason or "unsupported" in reason or "非动作指令" in reason:
        return "没识别出可以做的动作（可能是舞蹈、杂技这类不支持的动作）"
    return reason


async def _resolve_action(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """统一编排：本地动作模型 → （可降级时）文本→视频→动作。

    成功：{ok: True, source, name, frames, bone_count, morph_count,
           vmd_bytes, actions?, video_asset_id?, video_path?}
    失败：{ok: False, reason}
    """
    # ① 本地动作模型
    try:
        local = await _gen_local(args)
    except Exception as exc:  # noqa: BLE001 - 本地异常也尝试走视频管线
        log.exception("[tool.resolve_action] 本地模型异常")
        local = {"ok": False, "reason": str(exc), "operation": "unavailable"}

    if local.get("ok"):
        return {"ok": True, "source": "本地模型", **local}

    # ② 本地无结果 → 判断是否值得降级到视频管线
    operation = local.get("operation")
    if operation in _FALLBACK_OPERATIONS:
        from ...config import settings

        if settings.media_enabled:
            log.info(
                "[tool.resolve_action] 本地无结果(operation=%s)，降级到视频管线",
                operation,
            )
            try:
                video = await _video_action_bytes(args, bridge)
            except Exception as exc:  # noqa: BLE001
                log.warning("[tool.resolve_action] 视频管线失败: %s", exc)
                return {"ok": False, "reason": str(exc) or "视频生成失败"}
            return {"ok": True, "source": "视频管线", **video}
        return {
            "ok": False,
            "reason": f"{_human_reason(local)}（媒体管线未启用，无法改用视频生成）",
        }

    # ③ chat / release / 空文本：不降级，如实告知
    return {"ok": False, "reason": _human_reason(local)}


async def _run_generate_action(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """★ 动作生成（仅骨骼）：本地动作模型 → 文本→视频→动作 → 仍失败才如实告知。"""
    r = await _resolve_action(args, bridge)
    if not r.get("ok"):
        return _err(f"无法生成：{r.get('reason')}")
    return await _finish_local(
        r, bridge, tool="generate_action", source=str(r.get("source") or ""),
    )


async def _run_generate_emotion(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """★ 情绪生成（仅 morph）：后端表情小模型 -> morph-only VMD -> 动作库。"""
    from . import expression_model

    text = str(args.get("text") or "").strip()
    if not text:
        return _err("缺少 text（情绪 / 神情描述）")

    frames = args.get("frames")
    duration = args.get("duration")
    seed = args.get("seed")
    try:
        result = await asyncio.to_thread(
            expression_model.generate, text,
            name=(str(args.get("name")) if args.get("name") else None),
            frames=(int(frames) if frames else None),
            duration=(float(duration) if duration else None),
            blink=bool(args.get("blink", True)),
            seed=(int(seed) if seed is not None else None),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("[tool.generate_emotion] 生成异常")
        return _err(f"表情生成失败：{exc}")

    if not result.get("ok"):
        return _err(f"无法生成：{result.get('reason')}")

    # 表情 VMD 走专用导入：前端按当前模型的真实 morph 名过滤（缺失如实回报）
    imported, import_note, extra = await _import_vmd_bytes(
        bridge, result["name"], result["vmd_bytes"],
        tool="import_emotion_vmd_bytes",
    )

    payload = {
        "name": result["name"],
        "frames": result["frames"],
        "morph_count": result["morph_count"],
        "backend": result.get("backend"),
        "timeline_source": result.get("timeline_source"),
        "states": result.get("states"),
        "dropped": result.get("dropped"),
        "warnings": result.get("warnings"),
        "已加入动作片段库": imported,
        "note": import_note.strip(),
    }
    if isinstance(extra, dict) and extra.get("dropped"):
        payload["模型缺失的表情"] = extra["dropped"]
    return _to_content("generate_emotion", payload)


async def _run_generate_vmd(args: dict[str, Any], bridge: ToolBridge) -> dict[str, Any]:
    """★ 最终 VMD：文本 →（动作 VMD + 情绪 VMD）→ 合并成一份 VMD → 动作库。

    两级路由：
      ① 本地动作模型成功 → 动作 VMD；表情小模型 → 情绪 VMD；合并；
      ② 本地动作模型做不了（unsupported/unavailable）且媒体可用 →
         文本→视频→动捕得到动作 VMD，再与情绪 VMD 合并。
    表情不可用时自动降级为纯动作 VMD。
    """
    from . import expression_model
    from ...expressiongen.combined import merge_vmd

    text = str(args.get("text") or "").strip()
    if not text:
        return _err("缺少 text（要生成的动作描述）")

    name = str(args.get("name") or "").strip()
    expression = str(args.get("expression") or "").strip()
    blink = bool(args.get("blink", True))
    try:
        seed = int(args["seed"]) if args.get("seed") is not None else None
    except (TypeError, ValueError):
        seed = None
    try:
        frames_raw = int(args["frames"]) if args.get("frames") else 0
    except (TypeError, ValueError):
        frames_raw = 0

    # 动作文本 / 情绪文本拆分：
    #   给了 expression → text 只写身体动作；
    #   没给 → 从 text 里剥掉情绪副词做动作，情绪仍用原文解析。
    action_args: dict[str, Any] = {
        "text": text,
        "name": name or None,
        "duration": args.get("duration"),
    }
    if not expression:
        try:
            from ... import motiongen  # noqa: F401 - 确保 motiongen/tools 在 sys.path

            import emotion_parser

            stripped = emotion_parser.strip_emotion(text)
            if stripped:
                action_args["text"] = stripped
        except Exception:  # noqa: BLE001 - 拆分失败就用原文
            pass

    # ① 动作（本地模型优先，必要时自动走视频管线）
    r = await _resolve_action(action_args, bridge)
    if not r.get("ok"):
        return _err(f"无法生成：{r.get('reason')}")

    action_bytes: bytes = r["vmd_bytes"]
    action_frames = int(r.get("frames") or 0)
    expr_text = expression or text
    want_frames = int(frames_raw) if frames_raw else max(1, action_frames or 90)

    # ② 情绪（表情小模型）→ 与动作 VMD 合并
    merged = action_bytes
    expr_info: dict[str, Any] = {"enabled": False, "reason": "表情生成模型不可用"}
    if expression_model.available():
        try:
            er = await asyncio.to_thread(
                expression_model.render_records, expr_text, want_frames,
                blink=blink, seed=seed,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("[tool.generate_vmd] 表情生成异常")
            er = {"ok": False, "reason": str(exc)}

        if er.get("ok"):
            try:
                merged, minfo = await asyncio.to_thread(
                    merge_vmd, action_bytes, er["records"],
                )
                expr_info = {
                    "enabled": True,
                    "backend": er.get("backend"),
                    "timeline_source": er.get("timeline_source"),
                    "states": er.get("states"),
                    "dropped": er.get("dropped"),
                    "warnings": er.get("warnings"),
                    "merge": minfo,
                }
            except Exception as exc:  # noqa: BLE001
                log.exception("[tool.generate_vmd] 合并失败")
                expr_info = {"enabled": False, "reason": f"合并失败：{exc}"}
        else:
            expr_info = {"enabled": False, "reason": er.get("reason")}

    # ③ 入库
    clip_name = name or str(r.get("name") or "") or text[:24]
    imported, import_note, _extra = await _import_vmd_bytes(
        bridge, clip_name, merged,
    )

    payload: dict[str, Any] = {
        "name": clip_name,
        "frames": action_frames,
        "骨骼来源": r.get("source"),
        "表情": expr_info,
        "已加入动作片段库": imported,
        "note": import_note.strip(),
    }
    if r.get("video_path"):
        payload["video_asset_id"] = r.get("video_asset_id")
        payload["video_path"] = r.get("video_path")
    return _to_content("generate_vmd", payload)



async def _run_backend_tool(
    tool: str, args: dict[str, Any], bridge: ToolBridge
) -> dict[str, Any]:
    # ★ 领域知识：直接读 mmd_ref（不依赖浏览器 / 数据库）
    if tool == "get_mmd_knowledge":
        name = str(args.get("topic") or "").strip() or "bones"
        return _to_content(tool, {"topic": name, "content": mmd_ref.topic(name), "topics": mmd_ref.topic_names()})
    # ★ 统一编排：本地模型 → 视频管线 → 失败告知
    if tool == "generate_action":
        return await _run_generate_action(args, bridge)
    # ★ 能力1（显式调用）：直接走文本 → 动作视频 → 动捕 → VMD
    if tool == "generate_action_from_text":
        return await _run_action_from_text(args, bridge)
    # ★ 能力3：以本会话既有视频为参考再生成
    if tool == "generate_action_from_video":
        return await _run_action_from_video(args, bridge)
    # ★ 仅本地动作模型（显式调用，不做降级）
    if tool == "generate_motion_model":
        result = await _gen_local(args)
        if not result.get("ok"):
            return _err(f"无法生成：{_human_reason(result)}")
        return await _finish_local(
            result, bridge, tool=tool, source="本地模型",
        )
    # ★ 情绪生成（后端表情小模型，仅 morph）
    if tool == "generate_emotion":
        return await _run_generate_emotion(args, bridge)
    # ★ 最终 VMD：动作 VMD + 情绪 VMD 合并
    if tool == "generate_vmd":
        return await _run_generate_vmd(args, bridge)

    return _err(f"未知的后端工具：{tool}")


def make_forward(bridge: ToolBridge):
    """生成一个「转发器」：把工具名 + 参数送给前端并包装结果。"""

    async def forward(tool: str, args: dict[str, Any]) -> dict[str, Any]:
        # ★ 后端本地工具：进程内执行，不转发浏览器
        if tool in _BACKEND_TOOLS:
            return await _run_backend_tool(tool, args, bridge)

        result = await bridge.call(tool, args)
        if not result.get("ok"):
            return _err(f"工具 {tool} 执行失败：{result.get('error', '未知原因')}")
        return _to_content(tool, result.get("data"))

    return forward


def build_server(bridge: ToolBridge):
    """构造该会话专用的 in-process MCP server。

    ★ 每个会话一个实例：闭包捕获它自己的 bridge，工具因此只会把请求
      发给"这个会话所属的那些浏览器标签"。
    """
    from claude_agent_sdk import create_sdk_mcp_server, tool

    forward = make_forward(bridge)

    tools = []
    for name, description, schema in TOOL_SPECS:
        # 闭包捕获 name（默认参数避免 late-binding 陷阱）
        def _make(tool_name: str):
            async def _handler(args: dict[str, Any]) -> dict[str, Any]:
                return await forward(tool_name, args or {})

            return _handler

        tools.append(tool(name, description, schema)(_make(name)))

    log.info("[tool.server] 注册 %d 个工具", len(tools))
    return create_sdk_mcp_server("editvmd", version="1.0.0", tools=tools)


# MCP 工具在 CLI 里的全名是 `mcp__<server>__<tool>`。
MCP_SERVER_NAME = "editvmd"


def mcp_tool_names() -> list[str]:
    """全部编辑器工具的 CLI 全名（喂给 allowed_tools）。"""
    return [f"mcp__{MCP_SERVER_NAME}__{name}" for name, _, _ in TOOL_SPECS]


__all__ = ["build_server", "TOOL_SPECS", "mcp_tool_names", "MCP_SERVER_NAME", "bone_ref", "mmd_ref"]
