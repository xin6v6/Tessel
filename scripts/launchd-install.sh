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

  # 确认 bun 路径（cmd_install 已检查过存在性，这里再次确认路径）
  local bun_path; bun_path="$(command -v bun 2>/dev/null)"
  if [[ -z "$bun_path" ]]; then
    err "找不到 bun 可执行文件，无法生成 plist"
    exit 1
  fi
  local bun_dir; bun_dir="$(dirname "$bun_path")"

  # 替换模板占位符为当前机器的实际路径
  sed \
    -e "s|__BUN__|${bun_path}|g" \
    -e "s|__BUN_DIR__|${bun_dir}|g" \
    -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    "$PLIST_SRC" > "$plist_tmp" || { err "plist 模板替换失败"; rm -f "$plist_tmp"; exit 1; }

  if [[ ! -f "$env_file" ]]; then
    warn ".env 文件不存在，跳过环境变量注入"
    mv "$plist_tmp" "$PLIST_DST"
    chmod 600 "$PLIST_DST"
    return
  fi

  # Python 直接读取 .env 和 plist，不经过 Bash 变量传参
  # 彻底避免 $(...) / 反引号等 Shell 解析风险
  if ! python3 - "$plist_tmp" "$env_file" <<'PYEOF'
import sys
import re
import plistlib

plist_path, env_path = sys.argv[1], sys.argv[2]

# 解析 .env：跳过注释/空行，去掉首尾引号
env_vars = {}
with open(env_path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n')
        if not line or line.lstrip().startswith('#'):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        # 去掉首尾成对的单引号或双引号
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        env_vars[key] = val

if not env_vars:
    print("警告：.env 中未找到有效变量", file=sys.stderr)
    sys.exit(0)

with open(plist_path, 'rb') as f:
    data = plistlib.load(f)

if 'EnvironmentVariables' not in data:
    data['EnvironmentVariables'] = {}

data['EnvironmentVariables'].update(env_vars)

with open(plist_path, 'wb') as f:
    plistlib.dump(data, f)

print(f"已注入 {len(env_vars)} 个环境变量")
PYEOF
  then
    rm -f "$plist_tmp"
    err ".env 注入失败，终止安装"
    exit 1
  fi

  mv "$plist_tmp" "$PLIST_DST"

  # 权限设为 600：只有当前用户可读，防止明文 token 泄露
  chmod 600 "$PLIST_DST"

  log "已将 .env 变量注入 plist（权限 600）"
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
  if ! command -v python3 &>/dev/null; then
    err "python3 未安装，无法注入环境变量"
    exit 1
  fi

  # 创建日志目录
  mkdir -p "$LOG_DIR" || { err "无法创建日志目录：$LOG_DIR"; exit 1; }

  # 如果已加载，先卸载
  if launchctl list "$PLIST_NAME" &>/dev/null 2>&1; then
    warn "服务已存在，先卸载旧版本..."
    launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || \
    launchctl unload "$PLIST_DST" 2>/dev/null || true
  fi

  # 将 plist 复制并注入 .env
  inject_env_into_plist

  # 加载服务（macOS 13+ 用 bootstrap，兼容旧版用 load）
  local loaded=0
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
    ok "服务已通过 bootstrap 加载"
    loaded=1
  elif launchctl load -w "$PLIST_DST" 2>/dev/null; then
    ok "服务已通过 load 加载"
    loaded=1
  fi

  if [[ $loaded -eq 0 ]]; then
    err "服务加载失败，请检查 plist 配置"
    exit 1
  fi

  # 等待并验证服务真正启动
  sleep 2
  if ! _service_running; then
    warn "服务已加载但进程未启动，请检查日志："
    warn "  tail -20 $LOG_DIR/synod.error.log"
  fi

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

# 检查服务是否有正在运行的 PID（兼容各 macOS 版本）
_service_running() {
  launchctl list "$PLIST_NAME" 2>/dev/null | python3 -c "
import sys, re
output = sys.stdin.read()
# macOS launchctl list 输出格式：'\"PID\" = 12345;' 或 JSON '\"pid\": 12345'
m = re.search(r'[\"\'Pp][Ii][Dd][\"\']\s*[=:]\s*(\d+)', output)
sys.exit(0 if m else 1)
" 2>/dev/null
}

_get_pid() {
  launchctl list "$PLIST_NAME" 2>/dev/null | python3 -c "
import sys, re
output = sys.stdin.read()
m = re.search(r'[\"\'Pp][Ii][Dd][\"\']\s*[=:]\s*(\d+)', output)
print(m.group(1) if m else '')
" 2>/dev/null
}

cmd_status() {
  echo ""
  echo -e "${BOLD}── Synod 服务状态 ──${RESET}"

  if ! launchctl list "$PLIST_NAME" &>/dev/null 2>&1; then
    warn "服务未加载（未安装）"
  elif _service_running; then
    local pid
    pid=$(_get_pid)
    ok "服务正在运行 (PID: ${pid:-未知})"
  else
    local last_exit
    last_exit=$(launchctl list "$PLIST_NAME" 2>/dev/null | python3 -c "
import sys, re
m = re.search(r'LastExitStatus[\"\']*\s*[=:]\s*(\d+)', sys.stdin.read())
print(m.group(1) if m else '未知')
" 2>/dev/null || echo "未知")
    warn "服务已加载但未运行 (上次退出码: $last_exit)"
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
  if launchctl kickstart -k "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null; then
    ok "重启完成"
  else
    warn "kickstart 失败，执行完整重装..."
    cmd_uninstall
    cmd_install
    return
  fi
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
