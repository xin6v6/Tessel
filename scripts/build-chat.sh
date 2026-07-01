#!/usr/bin/env bash
# ============================================================
# 构建 TesselChat.app — macOS 悬浮聊天窗口
#
# 用法: bash scripts/build-chat.sh
# 输出: desktop/build/TesselChat.app
#
# 依赖: swiftc (macOS 自带，无需 Xcode)
# ============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_SRC="$PROJECT_DIR/desktop/TesselChat.swift"
BUILD_DIR="$PROJECT_DIR/desktop/build"
APP_NAME="TesselChat"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"

# ── 检查 swiftc ──────────────────────────────────────────────────────────

if ! command -v swiftc &>/dev/null; then
  echo "[✗] swiftc 未找到。请安装 Xcode 或 Xcode Command Line Tools:" >&2
  echo "    xcode-select --install" >&2
  exit 1
fi

echo "[·] swiftc $(swiftc --version | head -1)"

# ── 清理旧构建 ──────────────────────────────────────────────────────────

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# ── 编译 Swift ───────────────────────────────────────────────────────────

echo "[·] 编译 $SWIFT_SRC ..."
swiftc \
  -O \
  -framework Cocoa \
  -framework WebKit \
  -o "$MACOS_DIR/$APP_NAME" \
  "$SWIFT_SRC"

echo "[✓] 二进制: $MACOS_DIR/$APP_NAME"

# ── 生成 Info.plist ──────────────────────────────────────────────────────

cat > "$APP_BUNDLE/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>TesselChat</string>
    <key>CFBundleExecutable</key>
    <string>TesselChat</string>
    <key>CFBundleIdentifier</key>
    <string>dev.tessel.chat</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
</dict>
</plist>
EOF

echo "[✓] 已生成 Info.plist"

# ── 复制应用图标（如果有） ────────────────────────────────────────────────

ICON_SRC="$PROJECT_DIR/desktop/AppIcon.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$RESOURCES_DIR/"
  echo "[✓] 已复制应用图标"
else
  echo "[!] 未找到 AppIcon.icns，使用默认图标"
fi

# ── 完成 ──────────────────────────────────────────────────────────────────

APP_SIZE=$(du -sh "$APP_BUNDLE" | cut -f1)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[✓] 构建完成: $APP_BUNDLE ($APP_SIZE)"
echo ""
echo "  启动: open $APP_BUNDLE"
echo "  或双击 Finder 中的 TesselChat.app"
echo ""
echo "  通过菜单栏 🟢T 图标或 tessel chat start 控制显隐"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 可选：直接启动 ────────────────────────────────────────────────────────

if [ "${1:-}" = "--launch" ]; then
  echo ""
  echo "[·] 启动 TesselChat..."
  open "$APP_BUNDLE"
fi
