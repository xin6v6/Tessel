#!/usr/bin/env bash
# ================================================================
# Synod 后台启动脚本
#
# 用法：
#   ./scripts/start.sh          # 前台运行（带自动重试）
#   ./scripts/start.sh --daemon # 后台运行（nohup）
#   ./scripts/start.sh --stop   # 停止后台进程
#   ./scripts/start.sh --status # 查看运行状态
#   ./scripts/start.sh --logs   # 实时查看日志
# ================================================================

set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_NAME="synod"
PID_FILE="$PROJECT_DIR/.synod.pid"
DAEMON_LOG="$PROJECT_DIR/data/logs/daemon.log"   # daemon 自身的 stdout（启动/重试消息）
LOG_DIR="$PROJECT_DIR/data/logs"

MAX_RETRIES=5          # 连续失败超过此次数后停止重试
RETRY_DELAY=5          # 初始重试等待（秒）
MAX_RETRY_DELAY=60     # 最大等待上限（秒，指数退避）
MIN_UPTIME=10          # 进程存活超过此秒数才重置重试计数

# ── 颜色 ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${RESET} $*"; }
ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠${RESET} $*"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ✗${RESET} $*" >&2; }

# ── 工具函数 ────────────────────────────────────────────────────

check_deps() {
  if ! command -v bun &>/dev/null; then
    err "bun 未安装。请先安装：curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi
}

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

get_pid() {
  [[ -f "$PID_FILE" ]] && cat "$PID_FILE" || echo ""
}

# ── 子命令：状态 ────────────────────────────────────────────────

cmd_status() {
  if is_running; then
    local pid; pid=$(get_pid)
    ok "$APP_NAME 正在运行 (PID: $pid)"
    echo -e "  daemon 日志: $DAEMON_LOG"
    echo -e "  应用日志:   $LOG_DIR/$(date +%Y-%m-%d).log"
    if command -v ps &>/dev/null; then
      echo -e "  $(ps -p "$pid" -o pid=,etime=,rss= 2>/dev/null | awk '{printf "运行时长: %s  内存: %sMB", $2, int($3/1024)}')"
    fi
  else
    warn "$APP_NAME 未运行"
    [[ -f "$PID_FILE" ]] && { warn "残留 PID 文件，已清理"; rm -f "$PID_FILE"; }
  fi
}

# ── 子命令：停止 ────────────────────────────────────────────────

cmd_stop() {
  if ! is_running; then
    warn "$APP_NAME 未在运行"
    return 0
  fi
  local pid; pid=$(get_pid)
  log "停止 $APP_NAME (PID: $pid)..."
  kill -TERM "$pid" 2>/dev/null || true

  # 等待最多 10 秒优雅退出
  local i=0
  while kill -0 "$pid" 2>/dev/null && [[ $i -lt 10 ]]; do
    sleep 1; ((i++))
  done

  # 仍未退出则强杀
  if kill -0 "$pid" 2>/dev/null; then
    warn "优雅退出超时，强制终止..."
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  ok "已停止"
}

# ── 子命令：查看日志 ────────────────────────────────────────────

cmd_logs() {
  # 运行时动态取当天日期，确保跨天后追踪的是最新日志文件
  local today_log="$LOG_DIR/$(date +%Y-%m-%d).log"
  if [[ ! -f "$today_log" ]]; then
    warn "今日日志文件不存在：$today_log"
    warn "请先启动服务，或用 bun run logs 查看实时日志"
    return 0
  fi
  log "实时查看日志（Ctrl+C 退出）..."
  if command -v jq &>/dev/null; then
    tail -f "$today_log" | jq -r '[.timestamp, (.level | ascii_upcase | .[0:5]), .logger, (.sessionId // ""), .message] | @tsv'
  else
    tail -f "$today_log"
  fi
}

# ── 核心：带重试的运行循环 ──────────────────────────────────────

run_with_retry() {
  local retries=0
  local delay=$RETRY_DELAY
  local child_pid=""
  local stopping=0

  # Ctrl+C 或 SIGTERM：标记停止，杀掉当前子进程
  _shutdown() {
    stopping=1
    echo ""
    log "收到退出信号，正在停止..."
    [[ -n "$child_pid" ]] && kill -TERM "$child_pid" 2>/dev/null || true
  }
  trap _shutdown INT TERM

  while true; do
    local start_time; start_time=$(date +%s)

    log "启动 $APP_NAME... (尝试 $((retries + 1)))"
    bun run "$PROJECT_DIR/src/main.ts" &
    child_pid=$!

    # 等待子进程结束
    wait "$child_pid" 2>/dev/null || true
    local exit_code=$?
    child_pid=""

    # 用户主动停止
    if [[ $stopping -eq 1 ]]; then
      ok "已停止"
      exit 0
    fi

    local end_time; end_time=$(date +%s)
    local uptime=$(( end_time - start_time ))

    # 正常退出（exit 0）不重试
    if [[ $exit_code -eq 0 ]]; then
      ok "进程正常退出"
      break
    fi

    err "进程异常退出（code: $exit_code，运行了 ${uptime}s）"

    # 运行时间够长说明之前健康，重置重试计数
    if [[ $uptime -ge $MIN_UPTIME ]]; then
      log "进程存活时间足够，重置重试计数"
      retries=0
      delay=$RETRY_DELAY
    else
      ((retries++))
    fi

    # 超过最大重试次数
    if [[ $retries -ge $MAX_RETRIES ]]; then
      err "连续失败 $MAX_RETRIES 次，停止重试"
      err "请检查日志：$DAEMON_LOG"
      exit 1
    fi

    warn "等待 ${delay}s 后重试（第 $retries/$MAX_RETRIES 次，按 Ctrl+C 取消）..."
    # 可中断的 sleep
    sleep "$delay" & wait $! 2>/dev/null || true
    [[ $stopping -eq 1 ]] && { ok "已停止"; exit 0; }

    # 指数退避
    delay=$(( delay * 2 ))
    [[ $delay -gt $MAX_RETRY_DELAY ]] && delay=$MAX_RETRY_DELAY
  done
}

# ── 子命令：后台启动 ────────────────────────────────────────────

cmd_daemon() {
  if is_running; then
    local pid; pid=$(get_pid)
    warn "$APP_NAME 已在运行 (PID: $pid)"
    warn "如需重启，请先运行：$0 --stop"
    exit 1
  fi

  mkdir -p "$LOG_DIR"
  check_deps

  log "以后台模式启动 $APP_NAME..."
  log "daemon 日志：$DAEMON_LOG（启动/重试消息）"
  log "应用日志：$LOG_DIR/YYYY-MM-DD.log（结构化 JSON）"

  # 用 nohup + subshell 运行重试循环
  # daemon 自身的 stdout（启动/重试消息）写到独立的 daemon.log，
  # 与应用按天滚动的结构化日志文件分开
  nohup bash -c "
    source '$SCRIPT_DIR/start.sh'
    run_with_retry
  " >> "$DAEMON_LOG" 2>&1 &

  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待 2 秒确认进程存活
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    ok "$APP_NAME 已在后台启动 (PID: $pid)"
    echo -e "  查看日志：${BOLD}$0 --logs${RESET}"
    echo -e "  停止服务：${BOLD}$0 --stop${RESET}"
  else
    err "启动失败，请检查日志：$DAEMON_LOG"
    rm -f "$PID_FILE"
    exit 1
  fi
}

# ── 子命令：前台启动（默认）────────────────────────────────────

cmd_start() {
  if is_running; then
    local pid; pid=$(get_pid)
    warn "$APP_NAME 已在运行 (PID: $pid)"
    exit 1
  fi

  mkdir -p "$LOG_DIR"
  check_deps

  echo -e "${BOLD}"
  echo "  ███████╗██╗   ██╗███╗   ██╗ ██████╗ ██████╗ "
  echo "  ██╔════╝╚██╗ ██╔╝████╗  ██║██╔═══██╗██╔══██╗"
  echo "  ███████╗ ╚████╔╝ ██╔██╗ ██║██║   ██║██║  ██║"
  echo "  ╚════██║  ╚██╔╝  ██║╚██╗██║██║   ██║██║  ██║"
  echo "  ███████║   ██║   ██║ ╚████║╚██████╔╝██████╔╝"
  echo "  ╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ "
  echo -e "${RESET}"

  log "项目目录：$PROJECT_DIR"
  log "模型：${LLM_MODEL:-未设置}"
  log "Socket Mode：${SLACK_APP_TOKEN:+enabled}${SLACK_APP_TOKEN:-disabled}"
  echo ""

  # 前台运行，Ctrl+C 可正常退出
  run_with_retry
}

# ── 入口 ────────────────────────────────────────────────────────

cd "$PROJECT_DIR"

# 加载 .env（如果存在）
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

case "${1:-}" in
  --daemon|-d) cmd_daemon ;;
  --stop|-s)   cmd_stop ;;
  --status)    cmd_status ;;
  --logs|-l)   cmd_logs ;;
  --help|-h)
    echo "用法："
    echo "  $0             前台运行（带自动重试）"
    echo "  $0 --daemon    后台运行"
    echo "  $0 --stop      停止后台进程"
    echo "  $0 --status    查看运行状态"
    echo "  $0 --logs      实时查看日志"
    ;;
  "")          cmd_start ;;
  *)
    err "未知选项：$1"
    echo "运行 $0 --help 查看帮助"
    exit 1
    ;;
esac
