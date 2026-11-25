"""editVMD 后端入口：装配 app、启动建表、挂载路由。

结构
----
    config.py     配置（环境变量 / .env）
    db.py         SQLAlchemy 引擎 / 会话 / 建表 / 等待就绪
    models.py     ORM：模型资源 / VMD 资源 / 单份工作区 / 撤销快照
    schemas.py    API 形状
    storage.py    storage/ 落盘与路径越权校验
    vmd_meta.py   VMD 元信息轻量解析
    routers/
        assets.py      模型与 VMD 的上传 / 保存 / 列表 / 读取
        workspace.py   单份工作区 + 撤销栈的断点继续

启动时先阻塞等待 Postgres 就绪（Docker 里刚起来要几秒），再建表，
避免 `dev.sh` 在 db 未 ready 时把后端判成启动失败。
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import _REPO_ROOT, settings
from .db import init_db, wait_for_db
from .routers import assets, media, workspace
from .ai import router as ai_router

APP_NAME = "editVMD"
VERSION = "0.1.0"

# ★ uvicorn 只配置自己的 logger，不配 root —— 我们的 `editvmd.*` 日志会静默。
#   这里显式配置 root（幂等；已配置过则 basicConfig 无副作用）。
#   ★ 推理线程数必须在 import onnxruntime 之前设置，否则会按核数占满 CPU。
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_OFFLINE", "1")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动：等库 → 建表 → 确保存储目录；关闭：无需收尾。"""
    settings.ensure_dirs()
    wait_for_db()
    init_db()

    # ★ 动作生成模型预热（后台线程，不阻塞启动）。
    #   失败只记日志，首次生成会重试；不影响其它功能。
    if settings.t2m_enabled and settings.t2m_warmup:
        try:
            from .motiongen import warmup as _t2m_warmup

            _t2m_warmup()
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger("editvmd.main").warning(
                "[motiongen] 预热启动失败（忽略）: %s", exc
            )

    # ★ 表情生成模型预热（独立引擎；失败只记日志，首次生成会重试）。
    if getattr(settings, "expr_enabled", True) and getattr(
        settings, "expr_warmup", True
    ):
        try:
            from .expressiongen import warmup as _expr_warmup

            _expr_warmup()
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger("editvmd.main").warning(
                "[expressiongen] 预热启动失败（忽略）: %s", exc
            )

    yield
    # 关闭时停掉所有 AI 会话（子进程），避免 uvicorn --reload 留下僵尸 CLI
    try:
        await ai_router.shutdown_manager()
    except Exception:  # noqa: BLE001 - 收尾失败不应阻止退出
        pass


app = FastAPI(title=f"{APP_NAME} API", version=VERSION, lifespan=lifespan)

# 开发期前端跑在 :5173，后端在 :8200，属于跨域。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(assets.router)
app.include_router(workspace.router)
# 参考视频 → 动作：/api/media/videos/*（上传 / 列表 / 预览 / 生成 / 删除）
app.include_router(media.router)
# 侧边栏 AI：REST /api/ai/* + WS /api/ai/ws（SDK 不可用时自动降级，不影响其它接口）
app.include_router(ai_router.router)


@app.get("/api/health")
def health() -> dict:
    """存活探针，一键启动脚本用它判断后端是否就绪。"""
    from .ai.options import sdk_available

    return {
        "status": "ok",
        "app": APP_NAME,
        "version": VERSION,
        # 生成模型的资产包是否就位（源码部署未下载时为 missing，生成功能不可用）
        "assets": "ok" if settings.assets_present else "missing",
        # 侧边栏 AI 是否可用（需要装 claude-agent-sdk 且启用）
        "ai": bool(settings.ai_enabled and sdk_available()),
    }


@app.get("/api/hello")
def hello() -> dict:
    """HelloWorld 接口：前端页面拿它来验证前后端已连通。"""
    return {
        "message": "Hello from FastAPI 👋",
        "service": APP_NAME,
        "server_time": datetime.now().isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------- 前端静态资源
# ★ 本地部署（Docker / 单进程）由后端直接托管前端构建产物 dist：
#   页面与 /api 同源，WebSocket（/api/ai/ws）无需反向代理。
#   dist 不存在时（纯后端开发 / 未构建前端）跳过挂载，不影响 API。
_DIST_DIR = _REPO_ROOT / "frontend" / "dist"
if _DIST_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    # mount("/") 必须在所有 API 路由注册之后：Starlette 按注册顺序匹配。
    app.mount("/", StaticFiles(directory=str(_DIST_DIR), html=True), name="web")
