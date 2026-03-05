#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ELECTRON_DIR="$SCRIPT_DIR/electron"
APP_NAME="Swarmie"
OUT_DIR="$PROJECT_DIR/dist/electron"

echo "Building ${APP_NAME}.app (Electron)..."

# ---------------------------------------------------------------------------
# 1. Install Electron dependencies
# ---------------------------------------------------------------------------
echo "  Installing Electron dependencies..."
cd "$ELECTRON_DIR"
npm install

# ---------------------------------------------------------------------------
# 2. Prepare resources to bundle
# ---------------------------------------------------------------------------
RESOURCES_DIR="$ELECTRON_DIR/_resources"
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR/project"

# Copy compiled JS output
mkdir -p "$RESOURCES_DIR/project/dist"
cp -R "$PROJECT_DIR/dist/bin" "$RESOURCES_DIR/project/dist/bin"
cp -R "$PROJECT_DIR/dist/src" "$RESOURCES_DIR/project/dist/src"
cp -R "$PROJECT_DIR/dist/web" "$RESOURCES_DIR/project/dist/web"

# Copy package.json (needed for module resolution)
cp "$PROJECT_DIR/package.json" "$RESOURCES_DIR/project/package.json"

# Production node_modules
echo "  Bundling node_modules (production only)..."
TEMP_MODULES=$(mktemp -d)
cp "$PROJECT_DIR/package.json" "$TEMP_MODULES/package.json"
cp "$PROJECT_DIR/package-lock.json" "$TEMP_MODULES/package-lock.json" 2>/dev/null || true
cd "$TEMP_MODULES"
npm install --omit=dev --ignore-scripts 2>/dev/null
# node-pty needs native build artifacts
cp -R "$PROJECT_DIR/node_modules/node-pty/build" "$TEMP_MODULES/node_modules/node-pty/build" 2>/dev/null || true
cp -R "$PROJECT_DIR/node_modules/node-pty/prebuilds" "$TEMP_MODULES/node_modules/node-pty/prebuilds" 2>/dev/null || true
cp -R "$TEMP_MODULES/node_modules" "$RESOURCES_DIR/project/node_modules"
rm -rf "$TEMP_MODULES"

# Bundle Node.js
echo "  Bundling Node.js runtime..."
NODE_PATH=$(which node)
NODE_VERSION=$(node -v)
mkdir -p "$RESOURCES_DIR/project/node/bin"
cp "$NODE_PATH" "$RESOURCES_DIR/project/node/bin/node"
echo "  Node.js $NODE_VERSION bundled from $NODE_PATH"

cd "$ELECTRON_DIR"

# ---------------------------------------------------------------------------
# 3. Package with electron-packager
# ---------------------------------------------------------------------------
echo "  Running electron-packager..."
rm -rf "$OUT_DIR"

ICON_FLAG=""
if [ -f "$SCRIPT_DIR/AppIcon.icns" ]; then
  ICON_FLAG="--icon=$SCRIPT_DIR/AppIcon.icns"
fi

npx electron-packager . "$APP_NAME" \
  --platform=darwin \
  --arch=$(uname -m) \
  --out="$OUT_DIR" \
  --overwrite \
  --extra-resource="$RESOURCES_DIR/project" \
  $ICON_FLAG \
  --app-bundle-id=com.swarmie.app \
  --ignore="_resources"

# ---------------------------------------------------------------------------
# 4. Move .app to project root dist/
# ---------------------------------------------------------------------------
PACKED_APP=$(find "$OUT_DIR" -name "*.app" -maxdepth 2 | head -1)

if [ -z "$PACKED_APP" ]; then
  echo "ERROR: electron-packager did not produce an .app bundle"
  exit 1
fi

# Cleanup resources staging
rm -rf "$RESOURCES_DIR"

APP_SIZE=$(du -sh "$PACKED_APP" | cut -f1)
echo ""
echo "Built: $PACKED_APP ($APP_SIZE)"
echo ""
echo "To run:  open \"$PACKED_APP\""
echo "To install: cp -r \"$PACKED_APP\" /Applications/"
