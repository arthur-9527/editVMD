# editVMD 本地部署镜像
#
# 单容器形态：前端构建产物 dist 由 FastAPI 直接托管（见 app/main.py），
# 页面与 /api 同源，WebSocket（/api/ai/ws）无需反向代理。对外只暴露 8200。
#
#   docker compose up -d --build   →   http://localhost:8200

# ---------------------------------------------------------------- 前端构建
FROM node:22-alpine AS web
# ★ 钉死 pnpm 版本（与 frontend/package.json 的 packageManager 一致）：
#   pnpm 12 改了依赖 build-scripts 白名单的行为，会让 esbuild 的 postinstall
#   被忽略并直接报 ERR_PNPM_IGNORED_BUILDS。
RUN npm i -g pnpm@10.24.0
WORKDIR /web
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm build

# ---------------------------------------------------------------- 后端运行
FROM python:3.12-slim

# onnxruntime 需要 libgomp1（OpenMP）
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 \
    TOKENIZERS_PARALLELISM=false \
    HF_HUB_OFFLINE=1 \
    HOME=/app/backend

WORKDIR /app

# 依赖层：requirements 不变时可复用缓存
COPY backend/requirements.txt /app/backend/
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# ★ 侧边栏 AI（claude-agent-sdk）：不能与主依赖一起解析。
#   SDK → mcp>=1.23 → uvicorn>=0.31.1，而本项目锁 uvicorn==0.27.0，
#   完整解析会 ResolutionImpossible。沿用 scripts/setup-ai.sh 的做法：
#   --no-deps 装 SDK + mcp，再补齐 mcp 的运行期依赖。
#   不升级 uvicorn 是安全的：SDK 只用 in-process MCP server，不启动 HTTP server。
#   ★ 版本必须钉死，且绝不能引入新的 starlette（fastapi 0.109 要求 <0.36）：
#     mcp 2.x 拆出了 mcp_types 子包并抬高 starlette 要求，会连带把 starlette
#     升到 1.x，直接让 APIRouter(on_startup=...) 报 TypeError。这里统一钉回
#     本机验证过的组合（mcp 1.24.0 / sse-starlette 3.0.3 / starlette 0.35.1）。
RUN pip install --no-cache-dir --no-deps \
      "claude-agent-sdk==0.2.93" \
      "mcp==1.24.0" \
 && pip install --no-cache-dir \
      "anyio>=4.5" "httpx>=0.27.1" "httpx-sse>=0.4" "jsonschema>=4.20.0" \
      "pyjwt[crypto]>=2.10.1" "python-multipart>=0.0.9" \
      "sse-starlette==3.0.3" "typing-inspection>=0.4.1" "sniffio>=1.0.0"

# 代码层（含内嵌模型后端 backend/app/motiongen/data、expressiongen/data）
COPY backend /app/backend

# 前端产物（与后端同源托管）
COPY --from=web /web/dist /app/frontend/dist

# ★ CWD 必须在 backend/ 下：uvicorn 的 "app.main:app" 从 CWD 解析
#   （本地 dev.sh 同样是 cd backend 后启动）。
WORKDIR /app/backend

EXPOSE 8200

# ★ 必须单 worker：AI 会话 / WebSocket / 模型单例都在进程内存。
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200", "--proxy-headers"]
