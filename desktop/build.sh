#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Swarmie"
APP_DIR="$PROJECT_DIR/dist/${APP_NAME}.app"
RESOURCES="$APP_DIR/Contents/Resources"
PROJECT_BUNDLE="$RESOURCES/project"

echo "Building ${APP_NAME}.app (self-contained)..."

# Clean
rm -rf "$APP_DIR"

# Create .app bundle structure
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$RESOURCES"

# Compile Swift
swiftc -O \
  -o "$APP_DIR/Contents/MacOS/Swarmie" \
  "$SCRIPT_DIR/SwarmieApp.swift" \
  -framework Cocoa \
  -framework WebKit

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Swarmie</string>
    <key>CFBundleDisplayName</key>
    <string>Swarmie</string>
    <key>CFBundleIdentifier</key>
    <string>com.swarmie.app</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleExecutable</key>
    <string>Swarmie</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

# Copy icon
if [ -f "$SCRIPT_DIR/AppIcon.icns" ]; then
  cp "$SCRIPT_DIR/AppIcon.icns" "$RESOURCES/AppIcon.icns"
fi

# --- Bundle project files ---
echo "  Bundling project files..."
mkdir -p "$PROJECT_BUNDLE"

# Copy compiled JS output
mkdir -p "$PROJECT_BUNDLE/dist"
cp -R "$PROJECT_DIR/dist/bin" "$PROJECT_BUNDLE/dist/bin"
cp -R "$PROJECT_DIR/dist/src" "$PROJECT_BUNDLE/dist/src"
cp -R "$PROJECT_DIR/dist/web" "$PROJECT_BUNDLE/dist/web"

# Copy package.json (needed for module resolution)
cp "$PROJECT_DIR/package.json" "$PROJECT_BUNDLE/package.json"

# Copy production node_modules
echo "  Bundling node_modules (production only)..."
cd "$PROJECT_DIR"
# Install production deps into a temp dir to avoid polluting the source
TEMP_MODULES=$(mktemp -d)
cp "$PROJECT_DIR/package.json" "$TEMP_MODULES/package.json"
cp "$PROJECT_DIR/package-lock.json" "$TEMP_MODULES/package-lock.json" 2>/dev/null || true
cd "$TEMP_MODULES"
npm install --omit=dev --ignore-scripts 2>/dev/null
# node-pty needs native build artifacts — copy them from the source project
cp -R "$PROJECT_DIR/node_modules/node-pty/build" "$TEMP_MODULES/node_modules/node-pty/build" 2>/dev/null || true
cp -R "$PROJECT_DIR/node_modules/node-pty/prebuilds" "$TEMP_MODULES/node_modules/node-pty/prebuilds" 2>/dev/null || true
cp -R "$TEMP_MODULES/node_modules" "$PROJECT_BUNDLE/node_modules"
rm -rf "$TEMP_MODULES"
cd "$PROJECT_DIR"

# --- Bundle Node.js ---
echo "  Bundling Node.js runtime..."
NODE_PATH=$(which node)
NODE_VERSION=$(node -v)
NODE_DIR=$(dirname $(dirname "$NODE_PATH"))
mkdir -p "$PROJECT_BUNDLE/node/bin"
cp "$NODE_PATH" "$PROJECT_BUNDLE/node/bin/node"

# Also copy npm's node_modules that node might need (ICU data etc.)
# Minimal: just the binary is usually enough

echo "  Node.js $NODE_VERSION bundled from $NODE_PATH"

# --- Done ---
APP_SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo ""
echo "Built: $APP_DIR ($APP_SIZE)"
echo ""
echo "To run:  open $APP_DIR"
echo "To install: cp -r $APP_DIR /Applications/"
