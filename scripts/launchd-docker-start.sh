#!/usr/bin/env bash
# ================================================================
# launchd-docker-start.sh
#
# 由 launchd 在登录时调用。
# 等待 Docker Desktop 守护进程就绪后，启动 docker compose 服务。
#
# 注意：此脚本由 launchd-install.sh 自动生成 / 更新，不要手动修改。
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

log() { echo "[$(timestamp)] $*"; }

# ── 等待 Docker 守护进程就绪 ──────────────────────────────────────
MAX_WAIT=90
waited=0

log "等待 Docker 守护进程..."
until docker info &>/dev/null 2>&1; do
  if [[ $waited -ge $MAX_WAIT ]]; then
    log "ERROR: Docker 守护进程在 ${MAX_WAIT}s 内未就绪，放弃启动" >&2
    exit 1
  fi
  log "  守护进程未就绪，已等待 ${waited}s..."
  sleep 5
  waited=$((waited + 5))
done

log "Docker 守护进程就绪（等待了 ${waited}s）"

# ── 构建并启动 Tessel ──────────────────────────────────────────────
cd "$PROJECT_DIR"

log "构建镜像（使用缓存，如已构建则瞬间完成）..."
docker compose build --quiet

log "启动 Tessel 容器..."
docker compose up -d

log "Tessel 启动完成"
docker compose ps
