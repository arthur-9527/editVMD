#!/usr/bin/env bash
# editVMD 一键启动 / 停止
#
#   bash scripts/dev.sh start     启动数据库 + 前后端（自动回收被占用的端口）
#   bash scripts/dev.sh stop      停止前后端（数据库默认保留）
#   bash scripts/dev.sh restart   重启
#   bash scripts/dev.sh status    查看状态
#   bash scripts/dev.sh db-up     只启动 PostgreSQL 容器
#   bash scripts/dev.sh db-down   停止 PostgreSQL 容器（数据保留）
#   bash scripts/dev.sh db-reset  ⚠ 删除数据库容器与数据卷
#   bash scripts/dev.sh           等同 start
#
# 端口：数据库 55432 / 后端 8200 / 前端 5173
#
# ★ 数据库端口用 55432：宿主机 5432 常被其它项目容器占用（本机实测就有）。
#   容器内仍是标准 5432，只有宿主机映射端口变了，改这里与
#   EDITVMD_DATABASE_URL 即可。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PORT="55432"
DB_CONTAINER="editvmd-db"
BACKEND_HOST="0.0.0.0"
BACKEND_PORT="8200"
FRONTEND_HOST="0.0.0.0"
FRONTEND_PORT="5173"
STATE_DIR="$ROOT/.run"
BACKEND_PID_FILE="$STATE_DIR/backend.pid"
FRONTEND_PID_FILE="$STATE_DIR/frontend.pid"

# ---------------------------------------------------------------- 日志
info() { echo "[dev] $*"; }
err()  { echo "[dev] $*" >&2; }

# ---------------------------------------------------------------- 端口工具
port_pids() {
  lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true
}

port_busy() {
  [[ -n "$(port_pids "$1")" ]]
}

wait_port_free() {
  local port="$1" tries="${2:-50}"
  for _ in $(seq 1 "$tries"); do
    port_busy "$port" || return 0
    sleep 0.1
  done
  return 1
}

# 杀进程组（setsid 启动的服务，PGID == 领头 PID），兜底单杀
kill_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

# 回收端口：先 TERM（按进程组），再等待，最后 KILL
free_port() {
  local port="$1" quiet="${2:-0}"
  local pids pid
  pids="$(port_pids "$port")"
  [[ -z "$pids" ]] && return 0

  [[ "$quiet" == "0" ]] && info "端口 $port 被占用（PID: $(echo "$pids" | tr '\n' ' ')），正在回收…"

  for pid in $pids; do
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    kill_tree "$pid"
  done

  if wait_port_free "$port" 50; then
    [[ "$quiet" == "0" ]] && info "端口 $port 已释放"
    return 0
  fi

  for pid in $(port_pids "$port"); do
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    kill -KILL "$pid" 2>/dev/null || true
  done
  if wait_port_free "$port" 20; then
    [[ "$quiet" == "0" ]] && info "端口 $port 已强制释放"
    return 0
  fi

  err "无法释放端口 $port，请手动处理：sudo lsof -i :$port"
  return 1
}

# ---------------------------------------------------------------- 数据库
have_compose() {
  [[ -f "$ROOT/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1
}

db_running() {
  [[ -n "$(docker ps -q -f "name=^${DB_CONTAINER}$" 2>/dev/null)" ]]
}

db_ready() {
  db_running && docker exec "$DB_CONTAINER" pg_isready -U editvmd -d editvmd >/dev/null 2>&1
}

start_db() {
  if ! have_compose; then
    err "未找到 docker-compose.yml 或 docker，跳过数据库启动"
    return 1
  fi
  info "启动 PostgreSQL（$DB_CONTAINER，:${DB_PORT}）…"
  ( cd "$ROOT" && docker compose up -d db ) >/dev/null 2>&1 || {
    err "数据库启动失败：docker compose up -d db"
    return 1
  }

  printf '[dev] 等待数据库就绪'
  for _ in $(seq 1 60); do
    if db_ready; then
      echo ' ✓'
      return 0
    fi
    printf '.'; sleep 0.5
  done
  echo ""
  err "数据库 30s 内未就绪"
  return 1
}

stop_db() {
  have_compose || return 0
  if db_running; then
    info "停止 PostgreSQL…"
    ( cd "$ROOT" && docker compose stop db ) >/dev/null 2>&1 || true
  fi
}

reset_db() {
  have_compose || { err "缺少 docker compose"; return 1; }
  info "⚠ 删除数据库容器与数据卷…"
  ( cd "$ROOT" && docker compose down -v ) 2>&1 | tail -5
  info "已删除。下次 start 会重建空库。"
}

read_pid() {
  local f="$1"
  [[ -f "$f" ]] && tr -d ' \n' < "$f" || echo ""
}

# ---------------------------------------------------------------- stop
cmd_stop() {
  local back front
  back="$(read_pid "$BACKEND_PID_FILE")"
  front="$(read_pid "$FRONTEND_PID_FILE")"

  if [[ -z "$back" && -z "$front" ]] && ! port_busy "$BACKEND_PORT" && ! port_busy "$FRONTEND_PORT"; then
    info "服务未在运行。"
    rm -rf "$STATE_DIR"
    return 0
  fi

  info "正在停止服务…"
  kill_tree "$front"
  kill_tree "$back"
  # 双保险：PID 文件丢失或 reload 派生 worker 未收掉时，按端口回收
  free_port "$FRONTEND_PORT" 1
  free_port "$BACKEND_PORT" 1
  rm -rf "$STATE_DIR"
  info "已停止，端口 $BACKEND_PORT / $FRONTEND_PORT 已释放。"
  info "数据库仍在运行（停止它：bash scripts/dev.sh db-down）"
}

# ---------------------------------------------------------------- 前台保活
cleanup_running=0
cleanup() {
  [[ "$cleanup_running" == "1" ]] && return 0
  cleanup_running=1
  trap - EXIT INT TERM
  echo ""
  info "正在停止服务…"
  kill_tree "$(read_pid "$FRONTEND_PID_FILE")"
  kill_tree "$(read_pid "$BACKEND_PID_FILE")"
  free_port "$FRONTEND_PORT" 1
  free_port "$BACKEND_PORT" 1
  rm -rf "$STATE_DIR"
  info "已退出，端口已释放。"
}

# ---------------------------------------------------------------- start
cmd_start() {
  # 环境检查
  command -v python3 >/dev/null || { err "缺少 python3"; return 1; }
  command -v pnpm    >/dev/null || { err "缺少 pnpm，请先 npm i -g pnpm"; return 1; }
  command -v lsof    >/dev/null || { err "缺少 lsof：sudo apt install lsof"; return 1; }

  # ★ 优先用 backend/.venv：侧边栏 AI 的依赖（claude-agent-sdk）装在里边，
  #   它用 --system-site-packages 建的，所以 fastapi / uvicorn 也能直接用。
  local BACKEND_PY="python3"
  if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then
    BACKEND_PY="$ROOT/backend/.venv/bin/python"
  fi
  "$BACKEND_PY" -c "import fastapi, uvicorn" >/dev/null 2>&1 || {
    err "缺少 fastapi / uvicorn，请执行：bash scripts/setup-ai.sh"
    return 1
  }
  "$BACKEND_PY" -c "import claude_agent_sdk" >/dev/null 2>&1 || {
    info "提示：claude_agent_sdk 未安装，侧边栏 AI 将不可用（其它功能正常）"
    info "      需要时执行：bash scripts/setup-ai.sh"
  }

  # ---- 数据库（PostgreSQL / Docker）----
  start_db || return 1

  # 已在运行则先停，保证 start 幂等
  if port_busy "$BACKEND_PORT" || port_busy "$FRONTEND_PORT" || [[ -f "$BACKEND_PID_FILE" ]]; then
    info "检测到已有实例，先停止…"
    cmd_stop
  fi
  mkdir -p "$STATE_DIR"

  trap cleanup EXIT INT TERM

  # ---- 后端 ----
  info "启动后端 → http://127.0.0.1:$BACKEND_PORT"
  cd "$ROOT/backend" || return 1
  setsid "$BACKEND_PY" -m uvicorn app.main:app \
    --host "$BACKEND_HOST" --port "$BACKEND_PORT" --reload &
  echo $! > "$BACKEND_PID_FILE"

  printf '[dev] 等待后端就绪'
  local ready=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
      echo ' ✓'; ready=1; break
    fi
    if ! kill -0 "$(read_pid "$BACKEND_PID_FILE")" 2>/dev/null; then
      echo ""; err "后端启动失败，请查看上方日志。"; return 1
    fi
    printf '.'; sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    echo ""; err "后端 30s 内未就绪。"; return 1
  fi

  # ---- 前端 ----
  cd "$ROOT/frontend" || return 1
  if [[ ! -d node_modules ]]; then
    info "首次运行，安装前端依赖…"
    pnpm install
  fi

  info "启动前端 → http://127.0.0.1:$FRONTEND_PORT"
  setsid ./node_modules/.bin/vite --port "$FRONTEND_PORT" --host "$FRONTEND_HOST" &
  echo $! > "$FRONTEND_PID_FILE"

  # 等前端真的起来再打印地址，避免误导
  for _ in $(seq 1 60); do
    port_busy "$FRONTEND_PORT" && break
    kill -0 "$(read_pid "$FRONTEND_PID_FILE")" 2>/dev/null || { err "前端启动失败。"; return 1; }
    sleep 0.2
  done

  echo ""
  echo "================================================================"
  echo "  前端  http://localhost:$FRONTEND_PORT"
  echo "  接口  http://localhost:$BACKEND_PORT/api/hello"
  echo "  文档  http://localhost:$BACKEND_PORT/docs"
  echo "  数据库 postgresql://editvmd@127.0.0.1:$DB_PORT/editvmd"
  echo "  存储  $ROOT/storage"
  echo ""
  echo "  停止：Ctrl+C  或  bash scripts/dev.sh stop"
  echo "  重启：bash scripts/dev.sh restart"
  echo "================================================================"
  echo ""

  # 前台等待，任一进程退出即收尾（Ctrl+C 时由 trap 清理）
  wait -n "$(read_pid "$BACKEND_PID_FILE")" "$(read_pid "$FRONTEND_PID_FILE")" 2>/dev/null || true
  return 0
}

# ---------------------------------------------------------------- status
cmd_status() {
  local back front
  back="$(read_pid "$BACKEND_PID_FILE")"
  front="$(read_pid "$FRONTEND_PID_FILE")"

  if db_ready; then
    echo "数据库  :$DB_PORT  运行中且就绪 ($DB_CONTAINER)"
  elif db_running; then
    echo "数据库  :$DB_PORT  容器在跑但尚未就绪"
  else
    echo "数据库  :$DB_PORT  未运行"
  fi
  if port_busy "$BACKEND_PORT"; then
    echo "后端  :$BACKEND_PORT  运行中 (PID: $(port_pids "$BACKEND_PORT" | tr '\n' ' '))"
  else
    echo "后端  :$BACKEND_PORT  未运行"
  fi
  if port_busy "$FRONTEND_PORT"; then
    echo "前端  :$FRONTEND_PORT  运行中 (PID: $(port_pids "$FRONTEND_PORT" | tr '\n' ' '))"
  else
    echo "前端  :$FRONTEND_PORT  未运行"
  fi
  [[ -n "$back" ]] && echo "记录的后端 PID: $back"
  [[ -n "$front" ]] && echo "记录的前端 PID: $front"
  return 0
}

# ---------------------------------------------------------------- 入口
ACTION="${1:-start}"
case "$ACTION" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  db-up)   start_db ;;
  db-down) stop_db ;;
  db-reset) reset_db ;;
  status)  cmd_status ;;
  *)
    cat <<EOF
用法: bash scripts/dev.sh [命令]

  start     启动数据库 + 前后端（默认，自动回收被占用的端口）
  stop      停止前后端并释放端口（数据库保留）
  restart   重启前后端
  status    查看运行状态
  db-up     只启动 PostgreSQL 容器
  db-down   停止 PostgreSQL 容器（数据保留）
  db-reset  ⚠ 删除数据库容器与数据卷
EOF
    exit 1
    ;;
esac
