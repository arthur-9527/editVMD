# expressiongen — 进程内情绪生成引擎

把**一句中文情绪/神情**变成**一整段面部表情（仅 morph 段的 VMD）**，纯 CPU，
无 GPU、无外网、无第二个服务。与 `app/motiongen/`（动作）**各自独立、不共用文件**。

## 是什么

本目录内嵌了 `~/raspi_mmd/text2motion` 的**表情子系统运行期最小集**：

| 直接放进来（本项目内） | 用途 |
|---|---|
| `tools/expression_engine.py` | 推理：短语路由 → 小模型 → 规则兜底；morph 生命周期（到点归零） |
| `tools/expression_schema.py` | 6 槽 / 35 原子 / 情绪配方 / 中文词表（唯一真源） |
| `tools/expression_head_numpy.py` | 分类头 numpy 前向（不需要 torch） |
| `tools/onnx_embedder.py` | bge-large ONNX 编码（只依赖 onnxruntime + tokenizers） |
| `tools/expression_dsl*.py` / `expression_planner*.py` | 可选 DSL / 多头 planner |
| `tools/stage_*.py` `vmd_*.py` | 分段 / 舞台指示 / VMD 读写 |
| `data/` | 词表 + 表情分类头 + **独立的 bge ONNX 编码器副本** |

> 与 motiongen 的区别：**不共用任何模型文件**。两个项目/引擎互相独立，升级或替换互不影响；
> 代价是磁盘上多一份约 326MB 的 int8 编码器。

## 怎么用

```python
from app.expressiongen import generate_expression, render_morph_records

# 1) 情绪 -> 仅 morph 的 VMD 字节（骨骼段为空）
r = generate_expression("开心地挥挥手", frames=90)
open("expression.vmd", "wb").write(r["vmd_bytes"])

# 2) 只要 morph 关键帧（供与动作 VMD 合并）
records, info = render_morph_records("生气地骂骂咧咧", frames=85, blink=True)
# records == [("怒り", 0, 0.0), ("怒り", 6, 1.0), ("怒り", 36, 1.0), ("怒り", 46, 0.0)]
```

表情时长与动作时长**解耦**：每个 morph 的 `attack/hold/release` 来自
`tools/expression_schema.py` 的 `MORPH_TIMING`（眨眼 9 帧 / 笑 46 帧 / 嘟嘴 37 帧…），
到点立即归零；`frames` 只决定时间轴长度，不会把表情拉到动作末尾。

动作 + 情绪合并：

```python
from app.expressiongen import render_morph_records
from app.expressiongen.combined import merge_vmd

records, _ = render_morph_records("开心", frames=85)
final, info = merge_vmd(action_vmd_bytes, records)   # 骨骼原样保留 + 追加 morph
```

返回（`generate_expression`）：

```python
{"ok": True, "vmd_bytes": b"...", "frames": 91, "morph_count": 16,
 "backend": "onnx", "timeline_source": "text", "states": [...],
 "tracks": {morph: [[frame, weight], ...]}, "dropped": [...], "warnings": [...]}
{"ok": False, "reason": "没有识别出可用的表情"}
```

## 数据文件（约 326MB，均在 `data/` 下）

```
data/expression_phrases.json        短语级确定性路由
data/expression_atoms.json          标签空间快照（文档/调试）
data/skeleton_map.json              骨骼中英日映射（与 motiongen 同名模块共用时的兜底数据）
data/model/expression/bge_expr_v1/  head_numpy.npz + labels.json + meta.json（默认 legacy）
data/model/expression/bge_expr_dsl_v3/  可选：DSL 多头（expr_planner=head）
data/model/onnx/bge-large-zh-v1.5/  model_int8.onnx + tokenizer*.json + onnx_meta.json
```

> `data/` 已在 `.gitignore` 排除（二进制不入库）。从 source 项目复制：
>
> ```bash
> SRC=~/raspi_mmd/text2motion
> DST=backend/app/expressiongen
> mkdir -p "$DST/tools" "$DST/data/model/expression" "$DST/data/model/onnx/bge-large-zh-v1.5"
> cp -f "$SRC"/tools/expression_*.py "$SRC"/tools/onnx_embedder.py \
>       "$SRC"/tools/convert_head_numpy.py "$SRC"/tools/stage_*.py \
>       "$SRC"/tools/vmd_*.py "$DST/tools/"
> cp -f "$SRC"/data/expression_phrases.json "$SRC"/data/expression_atoms.json "$DST/data/"
> cp -f "$SRC"/data/skeleton_map.json "$DST/data/"
> for v in bge_expr_v1 bge_expr_dsl_v3; do
>   mkdir -p "$DST/data/model/expression/$v"
>   cp -f "$SRC/data/model/expression/$v"/{head_numpy.npz,labels.json,meta.json} \
>         "$DST/data/model/expression/$v/"
> done
> cp -f "$SRC"/data/model/onnx/bge-large-zh-v1.5/{model_int8.onnx,tokenizer.json,tokenizer_config.json,onnx_meta.json} \
>       "$DST/data/model/onnx/bge-large-zh-v1.5/"
> ```

## 开关（`backend/.env` 或环境变量）

```bash
EDITVMD_EXPR_ENABLED=1        # 完全关闭（工具返回「不可用」）
EDITVMD_EXPR_WARMUP=1         # 启动时后台预热
EDITVMD_EXPR_BACKEND=auto     # auto / onnx / torch / rules
EDITVMD_EXPR_PLANNER=legacy   # legacy（默认，与 text2motion /api/generate_vmd 一致）/ dsl / head
EDITVMD_EXPR_MODEL_DIR=       # 空 = 按 planner 自动选
EDITVMD_EXPR_DEFAULT_FRAMES=90
EDITVMD_EXPR_NEUTRAL_BIAS=1.05
```

## 依赖

`onnxruntime` + `tokenizers` + `numpy`（与 motiongen 相同），**不需要 torch**。

## 注意

* morph 名使用 Tda/式系标准命名；目标模型没有该 morph 时前端会**过滤并回报 `dropped`**。
* 引擎是**进程级单例**，多线程调用安全；CPU 推理应放线程池（`tools/server.py` 已这样做）。
* 与动作引擎同进程加载时，个别同名辅助模块（`onnx_embedder` / `vmd_export` 等）可能被复用；
  这些模块无 ROOT 相对数据依赖，行为一致。表情专属模块名（`expression_*`）唯一。
