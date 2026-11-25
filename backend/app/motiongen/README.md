# motiongen — 进程内动作生成引擎

把**一句中文**变成**一整段 MMD 动作（VMD）**，纯 CPU，无 GPU、无外网、无第二个服务。

## 是什么

本目录内嵌了 `~/raspi_mmd/text2motion` 项目的**运行期最小集**：

| 直接放进来（本项目内） | 用途 |
|---|---|
| `server/bridge.py` `server/config.py` | Engine 单例（意图解析 → 稠密动作 → VMD） |
| `tools/*.py`（22 个） | 稠密算子、ONNX 推理、部件混合、表情生成、VMD 读写 |
| `data/`（343 MB） | int8 bge-large ONNX + v6 分类头 + 347 段动作库 + 索引 |

来源项目是独立仓库；这里**只拷运行期闭包**，不含训练脚本、前端、corpus、keyframes、output。

原代码 `ROOT = Path(__file__).resolve().parent.parent`，放进本目录后 `ROOT` 自动指向 `motiongen/`，
`data/` 正好在其下 —— **原文件一行未改**。

## 怎么用

```python
from app.motiongen import generate, warmup

warmup()                       # 可选：启动时后台预热（app/main.py 已自动做）

r = generate("先挥挥手，再鞠个躬")
if r["ok"]:
    open("out.vmd", "wb").write(r["vmd_bytes"])
else:
    print("无法生成：", r["reason"])
```

返回：

```python
{"ok": True,  "vmd_bytes": b"...", "frames": 85, "actions": [...], "operation": "command"}
{"ok": False, "reason": "非动作指令: unsupported", "operation": "unsupported"}
```

## 性能（本机实测）

| 项 | 数值 |
|---|---|
| 首次加载（含 ONNX 会话 + 动作库） | **1.8 ~ 2.1 s** |
| 热调用生成 | **23 ~ 50 ms** |
| 常驻内存 | **~66 MB** |
| 「先挥挥手，再鞠个躬」 | 85 帧 / 4505 条骨骼记录 / 4 条表情记录 |
| VMD 体积 | ~500 KB |

## 依赖

`onnxruntime==1.32.0` + `tokenizers==0.23.3`（+ flatbuffers / huggingface_hub / sympy / mpmath）。
**不需要 torch / transformers / sentence-transformers。**

若 `pip` 不通，可从 source 项目的 venv 直接复制（同 Python 3.12、ABI 一致）：

```bash
SRC=~/raspi_mmd/text2motion/.venv/lib/python3.12/site-packages
DST=backend/.venv/lib/python3.12/site-packages
for p in onnxruntime tokenizers flatbuffers huggingface_hub sympy mpmath; do
  cp -a "$SRC/$p" "$DST/"
done
cp -a "$SRC"/{onnxruntime,tokenizers,flatbuffers,huggingface_hub,sympy,mpmath}-*.dist-info "$DST/"
```

## 数据文件清单（343 MB）

```
data/clean/library_clean.npz            27 MB  347 段动作（rot/pos 稠密数组）
data/clean/meta.json                    31 KB  骨骼表（自包含，不依赖 keyframes）
data/model/onnx/bge-large-zh-v1.5/
    model_int8.onnx                    325 MB 语义向量（int8 量化）
    tokenizer.json / tokenizer_config.json / onnx_meta.json
data/model/distill/bge_large_v6/
    head_numpy.npz                     3.9 MB 多标签分类头（纯 numpy 权重）
    labels.json / meta.json
    head.pt                            3.9 MB 仅用于「文件存在性检查」（ONNX 路径不加载）
data/actions.json  action_aliases.json  action_phrases.json
data/part_index.json  data/skeleton_map.json
```

> `head.pt` 不是可选项：`distill_engine_v2.py` 在构造时无条件检查它存在，
> 缺失会抛 `FileNotFoundError`（即使后端是 onnx 也如此）。

## 升级模型

从 text2motion 重新拷贝对应文件即可，无需改代码：

| 升级内容 | 需替换 |
|---|---|
| 动作库（新增/重整动作） | `data/clean/*` + `data/part_index.json` + `data/actions.json` + `data/action_*.json` |
| 语义分类头（识别更准） | `data/model/distill/<新版本>/{head_numpy.npz,labels.json,meta.json,head.pt}`，并让 `server/config.py` 的 `DISTILL_V2_DIR` 指向它 |
| 语义向量模型 | `data/model/onnx/bge-large-zh-v1.5/*` |

## 开关

```bash
EDITVMD_T2M_ENABLED=0     # 完全关闭（工具会返回「不可用」）
EDITVMD_T2M_WARMUP=0      # 关闭启动预热（首个请求多等约 2s）
EDITVMD_T2M_ONNX_THREADS=2  # 小机器降低推理线程数
```

## 注意

* `data/` 已在 `.gitignore` 中排除（343 MB 二进制不入库）。
* 引擎是**进程级单例**，多线程调用安全（`threading.Lock` 保护加载）。
* 生成是同步 CPU 计算，调用方应放到线程池（`asyncio.to_thread`），
  避免阻塞 FastAPI 事件循环 —— `tools/server.py` 已这样做。
