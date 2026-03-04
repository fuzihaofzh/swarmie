#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$SCRIPT_DIR/icon.svg"
ICONSET="$SCRIPT_DIR/AppIcon.iconset"
ICNS="$SCRIPT_DIR/AppIcon.icns"

# Check for rsvg-convert or use sips with a temp PNG
if command -v rsvg-convert &>/dev/null; then
  CONVERT="rsvg-convert"
elif command -v qlmanage &>/dev/null; then
  CONVERT="qlmanage"
else
  echo "Need rsvg-convert (brew install librsvg) or qlmanage"
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Generate a high-res PNG first
MASTER="$SCRIPT_DIR/_master.png"
if [ "$CONVERT" = "rsvg-convert" ]; then
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$MASTER"
else
  # Use qlmanage as fallback
  qlmanage -t -s 1024 -o "$SCRIPT_DIR" "$SVG" 2>/dev/null
  mv "$SCRIPT_DIR/icon.svg.png" "$MASTER" 2>/dev/null || true
fi

if [ ! -f "$MASTER" ]; then
  echo "Failed to render SVG. Install librsvg: brew install librsvg"
  exit 1
fi

# Generate all required sizes
for size in 16 32 64 128 256 512; do
  sips -z $size $size "$MASTER" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$MASTER" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

# Generate iconutil
iconutil -c icns "$ICONSET" -o "$ICNS"

# Cleanup
rm -rf "$ICONSET" "$MASTER"

echo "Created: $ICNS"
