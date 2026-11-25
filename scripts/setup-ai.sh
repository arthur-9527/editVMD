#!/usr/bin/env bash
# 安装侧边栏 AI 的 Python 依赖到 backend/.venv
#
# 为什么单独建 venv：
#   系统 Python 受 PEP 668 管理（pip 直接装会报 externally-managed-environment），
#   而 fastapi / uvicorn / websockets / pydantic-settings 系统里已经有了。
#   所以用 --system-site-packages 复用它们，只额外装 claude-agent-sdk 与 python-dotenv。
#
# ★ 固定 claude-agent-sdk==0.2.93：
#   - 0.2.93 自带 bundled CLI（_bundled/claude = 2.1.167），无需本机 claude；
#     且该 CLI 尚未引入官方模型白名单。
#   - 0.2.187+ 的 CLI 会对「疑似官方端点」做模型名校验，
#     deepseek-* 等非 claude 模型会报 claude-code:unrecognized_model。
#
# 用法：
#   bash scripts/setup-ai.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/backend/.venv"
PY="$VENV/bin/python"

info() { echo "[setup-ai] $*"; }
err()  { echo "[setup-ai] $*" >&2; }

command -v python3 >/dev/null || { err "缺少 python3"; exit 1; }

if [[ ! -x "$PY" ]]; then
  info "创建 venv（复用系统 site-packages）：$VENV"
  python3 -m venv --system-site-packages "$VENV" || { err "创建 venv 失败"; exit 1; }
fi

# ★ 只补「系统里没有的」包，且用 --no-deps 防止动到系统包。
#
# 为什么不能直接 pip install -r requirements.txt：
#   venv 是 --system-site-packages 建的，pip 会试图重装 uvicorn[standard] /
#   fastapi，与系统已装的 uvicorn==0.27.0 冲突（ResolutionImpossible），
#   且默认行为会把 uvicorn 升级到 0.54，破坏 fastapi 0.109 的兼容性。
#
# SDK 的依赖（anyio / jsonschema / mcp / sniffio / typing-extensions）
# 若系统里缺，下面的 check 会提示，再逐个补装即可。
info "安装 AI 依赖：claude-agent-sdk==0.2.93 / python-dotenv（--no-deps，不动系统包）"
"$PY" -m pip install --no-warn-script-location --no-deps --force-reinstall \
  "claude-agent-sdk==0.2.93" "python-dotenv>=1.0.0" \
  || { err "pip install 失败"; exit 1; }

info "检查 claude-agent-sdk 的运行期依赖（缺失才补装）"
for dep in "anyio>=4.0.0" "jsonschema>=4.20.0" "mcp>=1.23.0,<3.0.0" "sniffio>=1.0.0"; do
  mod="${dep%%[<>!]*}"
  if ! "$PY" -c "import $mod" >/dev/null 2>&1; then
    info "  补装缺失依赖：$dep"
    "$PY" -m pip install --no-warn-script-location "$dep" || err "  依赖 $dep 安装失败"
  fi
done

info "校验："
"$PY" - <<'PYEOF'
import sys
print("  python:", sys.version.split()[0])
for mod in ("fastapi", "uvicorn", "sqlalchemy", "pydantic_settings", "dotenv"):
    try:
        __import__(mod)
        print(f"  {mod}: ok")
    except Exception as exc:
        print(f"  {mod}: MISSING ({exc})")
try:
    import claude_agent_sdk
    print("  claude_agent_sdk:", getattr(claude_agent_sdk, "__version__", "ok"))
except Exception as exc:
    print("  claude_agent_sdk: MISSING", exc)
PYEOF

# 0.2.93 自带 bundled CLI，优先用它；只有 bundled 缺失时才需要外部 claude。
BUNDLED="$VENV/lib/python3.12/site-packages/claude_agent_sdk/_bundled/claude"
if [[ -x "$BUNDLED" ]]; then
  info "使用 SDK 自带的 bundled CLI：$("$BUNDLED" --version 2>/dev/null)"
elif ! command -v claude >/dev/null; then
  err ""
  err "⚠ 既没有 bundled CLI，也没有外部 claude。claude-agent-sdk 需要其中之一："
  err "   npm i -g @anthropic-ai/claude-code"
fi

if [[ ! -f "$ROOT/backend/.env" ]]; then
  info "生成 backend/.env（从 .env.example 复制）"
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  info "记得编辑 backend/.env 填入 EDITVMD_AI_API_KEY（DeepSeek 官方 API Key）"
fi

info "完成。启动：bash scripts/dev.sh"
