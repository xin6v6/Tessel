#!/usr/bin/env bash
# ================================================================
# Synod launchd 安装/卸载脚本
#
# 用法：
#   ./scripts/launchd-install.sh install    # 安装并启动服务
#   ./scripts/launchd-install.sh uninstall  # 停止并卸载服务
#   ./scripts/launchd-install.sh status     # 查看服务状态
#   ./scripts/launchd-install.sh restart    # 重启服务
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLIST_NAME="io.synod.app"
PLIST_SRC="$SCRIPT_DIR/${PLIST_NAME}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$PROJECT_DIR/logs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }

# ── 检查 .env 并将变量注入 plist ──────────────────────────────────

inject_env_into_plist() {
  local env_file="$PROJECT_DIR/.env"
  local plist_tmp="$PLIST_DST.tmp"

  if [[ ! -f "$env_file" ]]; then
    warn ".env 文件不存在，跳过环境变量注入"
    cp "$PLIST_SRC" "$PLIST_DST"
    return
  fi

  cp "$PLIST_SRC" "$plist_tmp"

  # 读取 .env，将每个变量追加到 plist 的 EnvironmentVariables 段
  while IFS= read -r line || [[ -n "$line" ]]; do
    # 跳过注释和空行
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      # 去掉首尾引号
      val="${val%\"}"
      val="${val#\"}"
      val="${val%\'}"
      val="${val#\'}"

      # 用 PlistBuddy 注入（macOS 自带）
      /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:${key} ${val}" "$plist_tmp" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:${key} string ${val}" "$plist_tmp" 2>/dev/null \
        || true
    fi
  done < "$env_file"

  mv "$plist_tmp" "$PLIST_DST"
  log "已将 .env 变量注入 plist"
}

# ── install ───────────────────────────────────────────────────────

cmd_install() {
  log "安装 Synod 为 macOS launchd 服务..."

  # 前提检查
  if [[ ! -f "$PLIST_SRC" ]]; then
    err "找不到 plist 模板：$PLIST_SRC"
    exit 1
  fi
  if ! command -v bun &>/dev/null; then
    err "bun 未安装，请先安装：curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi

  # 创建日志目录
  mkdir -p "$LOG_DIR"

  # 如果已加载，先卸载
  if launchctl list "$PLIST_NAME" &>/dev/null 2>&1; then
    warn "服务已存在，先卸载旧版本..."
    launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || \
    launchctl unload "$PLIST_DST" 2>/dev/null || true
  fi

  # 将 plist 复制并注入 .env
  inject_env_into_plist

  # 修正权限
  chmod 644 "$PLIST_DST"

  # 加载服务（macOS 13+ 用 bootstrap，兼容旧版用 load）
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
    ok "服务已通过 bootstrap 加载"
  else
    launchctl load -w "$PLIST_DST"
    ok "服务已通过 load 加载"
  fi

  sleep 2
  cmd_status
  echo ""
  echo -e "  查看日志：${BOLD}tail -f $LOG_DIR/synod.log${RESET}"
  echo -e "  停止服务：${BOLD}$0 uninstall${RESET}"
}

# ── uninstall ─────────────────────────────────────────────────────

cmd_uninstall() {
  log "卸载 Synod launchd 服务..."

  if launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
    ok "服务已通过 bootout 卸载"
  elif launchctl unload -w "$PLIST_DST" 2>/dev/null; then
    ok "服务已通过 unload 卸载"
  else
    warn "服务未在运行或已卸载"
  fi

  if [[ -f "$PLIST_DST" ]]; then
    rm "$PLIST_DST"
    ok "已删除 plist 文件"
  fi
}

# ── status ────────────────────────────────────────────────────────

cmd_status() {
  echo ""
  echo -e "${BOLD}── Synod 服务状态 ──${RESET}"
  if launchctl list "$PLIST_NAME" 2>/dev/null | grep -q PID; then
    local pid
    pid=$(launchctl list "$PLIST_NAME" 2>/dev/null | grep '"PID"' | awk -F'[= ;]' '{print $3}' || echo "")
    ok "服务正在运行 (PID: ${pid:-未知})"
  else
    local last_exit
    last_exit=$(launchctl list "$PLIST_NAME" 2>/dev/null | grep '"LastExitStatus"' | awk -F'[= ;]' '{print $3}' || echo "未知")
    if launchctl list "$PLIST_NAME" &>/dev/null 2>&1; then
      warn "服务已加载但未运行 (上次退出码: $last_exit)"
    else
      warn "服务未加载（未安装）"
    fi
  fi

  if [[ -f "$LOG_DIR/synod.log" ]]; then
    echo ""
    echo -e "${BOLD}最近日志（最后 5 行）：${RESET}"
    tail -5 "$LOG_DIR/synod.log"
  fi
  echo ""
}

# ── restart ───────────────────────────────────────────────────────

cmd_restart() {
  log "重启 Synod 服务..."
  launchctl kickstart -k "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null \
    || { cmd_uninstall; cmd_install; }
  ok "重启完成"
  sleep 2
  cmd_status
}

# ── 入口 ──────────────────────────────────────────────────────────

case "${1:-help}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  restart)   cmd_restart ;;
  *)
    echo "用法："
    echo "  $0 install    安装并启动（开机自启，崩溃自动重启）"
    echo "  $0 uninstall  停止并卸载"
    echo "  $0 status     查看状态"
    echo "  $0 restart    重启服务"
    ;;
esac
