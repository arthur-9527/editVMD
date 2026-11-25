"""后端服务配置。

所有路径均相对项目根目录（text2motion/），不依赖外部服务。
"""
from __future__ import annotations

import os
from pathlib import Path

# ---- 必须最先设置：限制 BLAS / tokenizers 线程数 ----
# 本机 48 核，torch 默认会把 OMP_NUM_THREADS 设为核数，
# 加载 bge-small-zh 时瞬间打满 CPU，导致 VS Code 卡顿/无响应。
# 这些变量必须在 import torch / sentence_transformers 之前生效。
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "4")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# 模型已缓存在本地，禁止每次启动联网检查（无网/慢网时会挂很久）
os.environ.setdefault("HF_HUB_OFFLINE", "1")

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
DATA = ROOT / "data"
MOTION = ROOT / "motion"

OUTPUT_DIR = Path(os.environ.get("T2M_OUTPUT_DIR", str(ROOT / "output"))).resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 服务
HOST = os.environ.get("T2M_HOST", "0.0.0.0")
PORT = int(os.environ.get("T2M_PORT", "8001"))
API_PREFIX = "/api"
OUTPUT_MOUNT = "/outputs"

# CORS
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]

# 前端默认模型（public/models/ 下）
DEFAULT_MODEL = os.environ.get("T2M_MODEL", "/models/youla/youla.pmx")

# 四元数 / 手性约定（重要）
#
# three-stdlib 的 mmdparser 在解析 PMX / VPD / VMD 时，会统一做「左手系 -> 右手系」
# 转换（mmdparser.js: leftToRightVector3 / leftToRightQuaternion）：
#     位置： Z 取负        v[2] = -v[2]
#     旋转： X、Y 取负     q[0]=-q[0], q[1]=-q[1]
#
# 所以 three.js 的 bone.quaternion / bone.position 期望的是「右手系」数据。
#
# 这里的源数据（dense Motion.rot / pos）是 VMD 原文，即「左手系」。
# 前端 StreamMMDHelper.applyFrame() 会完整模拟 leftToRightVpd()：
#     四元数 [-x, -y, z, w]   位置 [x, y, -z]
#
# 因此后端必须输出「左手系原文」，让前端翻一次就得到右手系。
# 若后端也翻一次，就会变成「翻两次 = 抵消」，导致手性错误
# （症状：手臂前后颠倒、低头变仰头）。
#
# 默认 False（不翻）。仅当前端不做转换时才设 T2M_VPD_QUAT_FLIP=1。
VPD_QUAT_FLIP = os.environ.get("T2M_VPD_QUAT_FLIP", "0") in ("1", "true", "True")

# 流式帧率
STREAM_FPS = int(os.environ.get("T2M_STREAM_FPS", "30"))
STREAM_BATCH = int(os.environ.get("T2M_STREAM_BATCH", "5"))

# 智能过渡：打断插入 / 队尾追加时在接缝处插入的过渡帧数（默认 5 帧 ≈ 0.17s）
SPLICE_TRANSITION_FRAMES = int(os.environ.get("T2M_SPLICE_FRAMES", "5"))
# 队首插入时，在变速后队列的「第 N 帧」处取姿态做匹配（默认 5）
SPLICE_LOOKAHEAD_FRAMES = int(os.environ.get("T2M_SPLICE_LOOKAHEAD", "5"))

# ---- 动作裁剪（M10）：去掉首尾"站立缓冲" ----
# 全库 345 段实测：frac=0.30 / pad=2 / risk=12° → 134 帧降到中位 103 帧
# （4.47s → 3.43s，平均裁掉 23.6%），残留风险 0 段。
# 回滚：T2M_CROP=0
CROP_ENABLE = os.environ.get("T2M_CROP", "1") in ("1", "true", "True")
# 峰值能量阈值比例：越大裁得越狠（0.15 保守 / 0.30 默认 / 0.40 收益饱和）
CROP_FRAC = float(os.environ.get("T2M_CROP_FRAC", "0.30"))
# 裁剪区间前后各留多少帧缓冲
CROP_PAD = int(os.environ.get("T2M_CROP_PAD", "2"))
# 安全阀：接缝处**单骨最大偏移**上限（度）。不是 7 骨累加！
CROP_RISK_DEG = float(os.environ.get("T2M_CROP_RISK_DEG", "12.0"))
# 单侧最多裁掉原长的比例（兜底，防把整段吃光）
CROP_MAX_RATIO = float(os.environ.get("T2M_CROP_MAX_RATIO", "0.40"))

# ---- 能量加权时间弯曲（M13）：压掉"前后摇太长" ----
#
# 为什么裁剪不够
#   实测素材末尾**永远有 1.3~2.4 °/帧 的呼吸抖动**，且末帧不是站立姿态
#   （残差 20~45°）。所以"按速度趋零裁尾"和"按回到站立裁尾"都裁不动，
#   裁剪天花板是 24%（4.47s → 3.43s），用户仍觉得"摇太久"。
#
# 解法：不判断哪里是结尾，而是把**低能量段整体加速**。
#   能量 >= body_frac*峰值 的主体段保持 1.0 倍速（完全不改）；
#   起势/收势摇摆段按 edge_speed 快放。
#
# 全库 13 段实测（speed_budget=1.8）：
#   4.47s → 裁剪 3.44s → 弯曲 2.53s（总压缩 43.3%），峰值角速度恰好 1.80x
#
# 回滚：T2M_TIME_WARP=0
TIME_WARP_ENABLE = os.environ.get("T2M_TIME_WARP", "1") in ("1", "true", "True")
# 能量分界点：低于 peak*此值 的帧算"摇摆段"（实测 0.45 是拐点）
TIME_WARP_BODY_FRAC = float(os.environ.get("T2M_WARP_BODY_FRAC", "0.45"))
# 质量约束：允许峰值角速度最多放大到原来的多少倍
#   1.5x → 平均 2.78s（压缩 37.8%，最保守）
#   1.8x → 平均 2.53s（压缩 43.3%，默认）
#   2.2x → 平均 2.31s（压缩 48.4%，激进，快节奏动作可能显抖）
TIME_WARP_SPEED_BUDGET = float(os.environ.get("T2M_WARP_SPEED_BUDGET", "1.8"))
# 裁尾后是否补 6 帧收势（把"半举手"姿态 slerp 回站立）
CROP_SETTLE_FRAMES = int(os.environ.get("T2M_CROP_SETTLE", "6"))
# 尾部收敛判据：从末帧找"末尾连续接近站立段"的单骨偏移上限（度）
CROP_TAIL_ABS_DEG = float(os.environ.get("T2M_CROP_TAIL_ABS", "0.10"))

# ---- 时长预算（duration 参数）----
# 加速上限：超过这个值手臂角速度会 >600°/s，视觉开始"抽搐"
SPEED_MAX = float(os.environ.get("T2M_SPEED_MAX", "2.0"))
# 允许的溢出上限（秒）：加速到 SPEED_MAX 后仍超预算时，最多容忍这么多
OVERFLOW_MAX_SEC = float(os.environ.get("T2M_OVERFLOW_MAX", "2.0"))
# 拼接策略："adaptive" = 按接缝角距算 5~12 帧；传整数则固定帧数
TRANSITION_MODE = os.environ.get("T2M_TRANSITION", "adaptive")

# ---- 组合模式（第 4 步：按部位并行混合）----
#   "auto"      → 按文本连接词 + 部位冲突自动判定（**默认**，最智能）
#   "0"/"false" → 强制串行（回滚用）
#   "1"/"true"  → 强制并行
# 仅影响流式 /ws 端点；HTTP /api/generate 由请求体 compose 字段决定。
COMPOSE_MODE = os.environ.get("T2M_COMPOSE", "auto").strip().lower()
if COMPOSE_MODE in ("1", "true"):
    COMPOSE_MODE = True
elif COMPOSE_MODE in ("0", "false", ""):
    COMPOSE_MODE = False
# 其余情况（"auto" 等）原样保留为字符串

# 保留的 job 数量上限（内存表）
MAX_JOBS = int(os.environ.get("T2M_MAX_JOBS", "200"))


# 是否在服务启动时后台预热语义引擎。
# 默认关闭：预热会 import torch + 加载模型，占满 CPU 数秒；
# 首次请求懒加载即可（实测约 12.7s，仅一次）。
WARMUP = os.environ.get("T2M_WARMUP", "0") in ("1", "true", "True")

# 意图解析引擎选择：
#   "v2"/"distill2" —— 默认：bge-large + 多正标签 BCE + 分段 + 候选集随机
#   "distill"  —— v1：DeepSeek 蒸馏 bge 分类头（单标签 softmax，可回滚）
#   "semantic" —— 旧方案：bge 检索 + 关键词（可回滚）
ENGINE = os.environ.get("T2M_ENGINE", "v2").strip().lower()

# ---- 动作输出历史（防止同一动作被反复选中）----
# 只按单个动作 ID 计数；组合动作（一次输出多个）不记录、不降权。
# 权重 = max(floor, decay ** n)，n = 最近 size 条里该动作出现次数。
# 关闭：T2M_HISTORY_ENABLE=0（评估脚本默认关闭，保证指标与改动前一致）
HISTORY_ENABLE = os.environ.get("T2M_HISTORY_ENABLE", "1") in ("1", "true", "True")
HISTORY_SIZE = int(os.environ.get("T2M_HISTORY_SIZE", "50"))
HISTORY_DECAY = float(os.environ.get("T2M_HISTORY_DECAY", "0.55"))
HISTORY_FLOOR = float(os.environ.get("T2M_HISTORY_FLOOR", "0.10"))

# 回填环境变量：tools/action_history.py 在 import 时直接读 os.environ
# 构建单例，这里保证 config 是唯一配置入口，且不覆盖用户显式设置的值。
os.environ.setdefault("T2M_HISTORY_ENABLE", "1" if HISTORY_ENABLE else "0")
os.environ.setdefault("T2M_HISTORY_SIZE", str(HISTORY_SIZE))
os.environ.setdefault("T2M_HISTORY_DECAY", str(HISTORY_DECAY))
os.environ.setdefault("T2M_HISTORY_FLOOR", str(HISTORY_FLOOR))

# ---- 意图引擎后端 ----
#   "onnx"  → onnxruntime int8 + 纯 numpy 分类头（无需 torch，内存 ~660MB）
#   "torch" → sentence-transformers + torch head（原路径，内存 ~1.7GB）
#   "auto"  → 有 ONNX 产物就用 onnx，否则回退 torch
EMB_BACKEND = os.environ.get("T2M_EMB_BACKEND", "auto").strip().lower()

# ONNX 模型目录（int8 量化后的 bge-large + tokenizer）
ONNX_DIR = Path(os.environ.get(
    "T2M_ONNX_DIR",
    str(DATA / "model" / "onnx" / "bge-large-zh-v1.5"))).resolve()

# ONNX 推理线程数（小机器建议 2，避免线程争抢）
ONNX_THREADS = int(os.environ.get("T2M_ONNX_THREADS", "2"))

# v2 模型目录（bge-large-zh-v1.5 + 多标签头）
#
# 默认 v4（M15 语料扩充重训版，23668 条语料 / 29044 样本）
#   val_F1 0.7731（v3 是 0.6807，+9.2pt）
#   holdout hit@any 91.0%（v3 是 83.8%）
#   短祈使句 / 速度副词 / 并例句 / 负样本 均已覆盖
#
# 可回滚：
#   T2M_DISTILL_V2_DIR=data/model/distill/bge_large_v4   （旧 202 类，2026-11-16）
#   T2M_DISTILL_V2_DIR=data/model/distill/bge_large_v3   （更旧，val_F1 0.68）
#
# ★ 2026-11-20 语义重组后默认切到 v5（347 类 / 新 ID 体系）
#   原因：v4 的 labels 是旧 ID（G0-01a…），而动作库已全部改为新 ID
#   （G01F01A…），不切换会导致 bridge 里 lib.has(aid) 全为 False，
#   表现为「全部动作生成失败」。
DISTILL_V2_DIR = Path(os.environ.get(
    "T2M_DISTILL_V2_DIR",
    str(DATA / "model" / "distill" / "bge_large_v6"))).resolve()
