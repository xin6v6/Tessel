#!/usr/bin/env bash
# ================================================================
# Synod launchd 安装/卸载脚本（Docker Compose 版本）
#
# 用法：
#   ./scripts/launchd-install.sh install    # 构建镜像、启动容器、注册开机自启
#   ./scripts/launchd-install.sh uninstall  # 停止容器、卸载 launchd 服务
#   ./scripts/launchd-install.sh status     # 查看 launchd 和容器状态
#   ./scripts/launchd-install.sh restart    # 重启容器
#
# 说明：
#   launchd 负责开机时执行 docker compose up -d（通过包装脚本）。
#   容器生命周期（崩溃重启、Slack 重连）由 Docker 的
#   restart: unless-stopped 策略管理，不再依赖 launchd KeepAlive。
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLIST_NAME="io.synod.app"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
WRAPPER="$SCRIPT_DIR/launchd-docker-start.sh"
LOG_DIR="$PROJECT_DIR/logs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }

# ── 前置检查 ──────────────────────────────────────────────────────

check_deps() {
  if ! command -v docker &>/dev/null; then
    err "docker 未安装或不在 PATH 中"
    err "请安装 Docker Desktop: https://docs.docker.com/desktop/mac/"
    exit 1
  fi

  if ! docker compose version &>/dev/null 2>&1; then
    err "docker compose (v2) 插件未找到"
    err "请升级 Docker Desktop 至 3.4.0+（内置 Compose V2）"
    exit 1
  fi

  if [[ ! -f "$PROJECT_DIR/.env" ]]; then
    err ".env 文件不存在：$PROJECT_DIR/.env"
    err "请复制 .env.example 并填入真实密钥"
    exit 1
  fi

  if [[ ! -f "$PROJECT_DIR/docker-compose.yml" ]]; then
    err "docker-compose.yml 不存在：$PROJECT_DIR/docker-compose.yml"
    exit 1
  fi
}

# ── 生成 launchd plist ────────────────────────────────────────────
# launchd 只负责登录时触发一次 wrapper 脚本（docker compose up -d）。
# KeepAlive=false，因为 compose up -d 立即返回（detached）。

write_plist() {
  local docker_path
  docker_path="$(command -v docker)"

  mkdir -p "$(dirname "$PLIST_DST")"

  cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${WRAPPER}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$docker_path")</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>

    <!-- 登录时自动执行一次 docker compose up -d -->
    <key>RunAtLoad</key>
    <true/>

    <!-- 脚本执行后立即退出属正常，不需要 KeepAlive -->
    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/launchd-synod.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/launchd-synod.error.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

  # plist 仅当前用户可读（路径中无明文密钥，但保持与旧版一致的安全习惯）
  chmod 600 "$PLIST_DST"
  log "已写入 plist: $PLIST_DST"
}

# ── install ───────────────────────────────────────────────────────

cmd_install() {
  log "安装 Synod（Docker Compose + launchd 开机自启）..."

  check_deps
  mkdir -p "$LOG_DIR"

  # 若包装脚本不存在（首次安装），报错提示
  if [[ ! -f "$WRAPPER" ]]; then
    err "包装脚本不存在：$WRAPPER"
    err "请确保已将 scripts/launchd-docker-start.sh 纳入版本控制"
    exit 1
  fi
  chmod +x "$WRAPPER"

  # 如果 launchd 服务已注册，先卸载
  if launchctl list "$PLIST_NAME" &>/dev/null 2>&1; then
    warn "检测到旧 launchd 服务，先卸载..."
    launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || \
    launchctl unload "$PLIST_DST" 2>/dev/null || true
  fi

  # 写入 plist
  write_plist

  # 首次构建镜像
  log "构建 Docker 镜像（首次较慢，后续利用缓存）..."
  cd "$PROJECT_DIR"
  docker compose build

  # 启动容器（不通过 launchd，直接启动）
  log "启动 Synod 容器..."
  docker compose up -d

  # 注册 launchd 服务（仅用于开机自启，不立即执行）
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
    ok "launchd 开机自启已注册（bootstrap）"
  elif launchctl load -w "$PLIST_DST" 2>/dev/null; then
    ok "launchd 开机自启已注册（load，兼容模式）"
  else
    warn "launchd 注册失败，容器已启动但不会开机自启"
    warn "可手动执行：launchctl bootstrap gui/$(id -u) $PLIST_DST"
  fi

  echo ""
  cmd_status
  echo ""
  echo -e "  跟踪日志：${BOLD}docker compose logs -f synod${RESET}"
  echo -e "  停止服务：${BOLD}$0 uninstall${RESET}"
  echo -e "  重启容器：${BOLD}$0 restart${RESET}"
}

# ── uninstall ─────────────────────────────────────────────────────

cmd_uninstall() {
  log "卸载 Synod Docker Compose 服务..."

  # 卸载 launchd 开机自启
  if [[ -f "$PLIST_DST" ]]; then
    if launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
      ok "launchd 服务已卸载（bootout）"
    elif launchctl unload -w "$PLIST_DST" 2>/dev/null; then
      ok "launchd 服务已卸载（unload）"
    else
      warn "launchd 服务未在运行或已卸载"
    fi
    rm "$PLIST_DST"
    ok "已删除 plist 文件"
  else
    warn "plist 文件不存在，跳过 launchd 卸载"
  fi

  # 停止并移除容器（保留镜像和绑定挂载的日志）
  if [[ -f "$PROJECT_DIR/docker-compose.yml" ]]; then
    cd "$PROJECT_DIR"
    if docker compose ps -q synod 2>/dev/null | grep -q .; then
      docker compose down
      ok "Synod 容器已停止并移除"
    else
      warn "Synod 容器未在运行，跳过 docker compose down"
    fi
  fi

  log "卸载完成。日志文件保留于 $LOG_DIR/"
}

# ── status ────────────────────────────────────────────────────────

cmd_status() {
  echo ""
  echo -e "${BOLD}── Synod 服务状态 ──${RESET}"

  # launchd 开机自启状态
  if launchctl list "$PLIST_NAME" &>/dev/null 2>&1; then
    ok "launchd 开机自启：已注册"
  else
    warn "launchd 开机自启：未注册（重启后不会自动启动）"
  fi

  echo ""
  echo -e "${BOLD}Docker 容器：${RESET}"
  if [[ -f "$PROJECT_DIR/docker-compose.yml" ]]; then
    cd "$PROJECT_DIR"
    docker compose ps 2>/dev/null || warn "无法获取 docker compose 状态（Docker 未运行？）"
  fi

  echo ""
  echo -e "${BOLD}最近日志（最后 10 行）：${RESET}"
  docker compose logs --tail=10 synod 2>/dev/null || true

  echo ""
}

# ── restart ───────────────────────────────────────────────────────

cmd_restart() {
  log "重启 Synod 容器..."
  cd "$PROJECT_DIR"
  docker compose restart synod
  sleep 3
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
    echo "  $0 install    构建镜像、启动容器、注册开机自启"
    echo "  $0 uninstall  停止容器、卸载 launchd 开机自启"
    echo "  $0 status     查看 launchd 和容器状态"
    echo "  $0 restart    重启容器"
    ;;
esac
