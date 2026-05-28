#!/usr/bin/env bash
# ----------------------------------------------------------------
# Migrate a host running Synod (old name) to Tessel (new name).
#
# What this script does:
#   1. Stop the old launchd service `io.synod.app` if installed
#   2. Re-install the new launchd plist `io.tessel.app`
#   3. Rebuild and restart docker compose under the new project name `tessel`
#
# What it does NOT touch:
#   - Docker volume `synod_synod-data` — kept intact via the `name:` lock in
#     docker-compose.yml. Logs and contacts survive the rename.
#   - .env / .git / source code — those are managed by the deploy workflow.
#
# Run this ONCE on the mac mini after the rename PR is merged and the new
# code is pulled. Subsequent deploys go back to the normal workflow.
# ----------------------------------------------------------------

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_DIR"

echo "── Tessel migration — running from: $REPO_DIR"

# ── 1. Uninstall old launchd service ────────────────────────────
OLD_LABEL="io.synod.app"
OLD_PLIST="$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"

if [ -f "$OLD_PLIST" ]; then
  echo "── unloading old launchd service: $OLD_LABEL"
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
  rm -f "$OLD_PLIST"
  echo "   ✓ removed $OLD_PLIST"
else
  echo "── no old launchd service found at $OLD_PLIST (skipping)"
fi

# ── 2. Install new launchd service (if launchd plist exists in repo) ─
NEW_PLIST_SRC="$REPO_DIR/scripts/io.tessel.app.plist"
if [ -f "$NEW_PLIST_SRC" ] && [ -x "$REPO_DIR/scripts/launchd-install.sh" ]; then
  echo "── installing new launchd service: io.tessel.app"
  bash "$REPO_DIR/scripts/launchd-install.sh" install
else
  echo "── no launchd plist or installer found in repo (skipping)"
fi

# ── 3. Rebuild/restart docker compose under new project name ────
echo "── stopping old compose project (synod) if running"
(cd "$REPO_DIR" && COMPOSE_PROJECT_NAME=synod docker compose down --remove-orphans 2>/dev/null) || true

echo "── building and starting compose project (tessel)"
(cd "$REPO_DIR" && docker compose up -d --build)

echo ""
echo "── done. quick verification:"
docker compose ps
echo ""
echo "If contacts.db / logs are missing, check that volume 'synod_synod-data' still exists:"
echo "  docker volume inspect synod_synod-data"
