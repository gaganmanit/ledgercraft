#!/bin/bash
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$MAC_DIR")"
DESTINATION="${1:-$PROJECT_DIR/dist/Ledgercraft.app}"
STAGING="$MAC_DIR/.build"
APP="$STAGING/Ledgercraft.app"
EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$MAC_DIR/Info.plist")"
RESOURCE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :FinancerBookResources' "$MAC_DIR/Info.plist")"
BOOKS="$APP/Contents/Resources/$RESOURCE_NAME"
ARCH="$(uname -m)"
NODE_BINARY="${LEDGERCRAFT_NODE:-${FINANCER_NODE:-$(command -v node || true)}}"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "The native app requires macOS 13 or later and Xcode Command Line Tools." >&2
  exit 1
fi
if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  echo "The candidate destination already exists. Choose a new .app path." >&2
  exit 1
fi
if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
  echo "Install Node.js 24 or later, or set LEDGERCRAFT_NODE to its executable." >&2
  exit 1
fi
if ! "$NODE_BINARY" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "The bundled runtime must be Node.js 24 or later." >&2
  exit 1
fi
/usr/bin/xcrun --find swiftc >/dev/null
NODE_DEPENDENCIES="$(/usr/bin/otool -L "$NODE_BINARY" | /usr/bin/awk '/^\t/ && $1 !~ /^\/(usr\/lib|System\/Library)\// { print $1 }')"
if [[ -n "$NODE_DEPENDENCIES" ]]; then
  echo "Choose a standalone Node.js distribution that uses only macOS system libraries (LEDGERCRAFT_NODE)." >&2
  exit 1
fi
python3 "$PROJECT_DIR/tools/prepare-resources.py" --check

if [[ -e "$STAGING" ]]; then
  echo "Build staging exists. Remove mac/.build only after confirming no build is active." >&2
  exit 1
fi
mkdir -p "$APP/Contents/MacOS" "$BOOKS" "$APP/Contents/Resources/runtime"
cleanup() {
  /bin/rm -rf "$STAGING"
}
trap cleanup EXIT

/usr/bin/xcrun swiftc -O -swift-version 5 -target "$ARCH-apple-macos13.0" \
  -framework AppKit -framework WebKit "$MAC_DIR/Financer.swift" \
  -o "$APP/Contents/MacOS/$EXECUTABLE"
/bin/cp "$MAC_DIR/Info.plist" "$APP/Contents/Info.plist"
NODE_ARCHES="$(/usr/bin/lipo -archs "$NODE_BINARY")"
if [[ "$NODE_ARCHES" == "$ARCH" ]]; then
  /bin/cp "$NODE_BINARY" "$APP/Contents/Resources/runtime/node"
elif [[ " $NODE_ARCHES " == *" $ARCH "* ]]; then
  /usr/bin/lipo "$NODE_BINARY" -thin "$ARCH" -output "$APP/Contents/Resources/runtime/node"
else
  echo "The selected Node executable has no $ARCH architecture." >&2
  exit 1
fi
/bin/chmod +x "$APP/Contents/Resources/runtime/node"
/bin/cp "$PROJECT_DIR/server.js" "$PROJECT_DIR/package.json" "$BOOKS/"
/bin/cp -R "$PROJECT_DIR/lib" "$PROJECT_DIR/public" "$BOOKS/"
mkdir -p "$BOOKS/data/companies"
/bin/cp -R "$PROJECT_DIR/data/companies/specimen-8fe3bf" "$BOOKS/data/companies/"
/bin/cp "$MAC_DIR/Node-LICENSE.txt" "$APP/Contents/Resources/runtime/LICENSE"

# Convert the supplied favicon artwork into the native app icon.
mkdir -p "$STAGING/thumbnail" "$STAGING/Ledgercraft.iconset"
/usr/bin/qlmanage -t -s 1024 -o "$STAGING/thumbnail" "$PROJECT_DIR/public/favicon.svg" >/dev/null 2>&1
ICON_SOURCE="$STAGING/thumbnail/favicon.svg.png"
for SIZE in 16 32 128 256 512; do
  /usr/bin/sips -z "$SIZE" "$SIZE" "$ICON_SOURCE" --out "$STAGING/Ledgercraft.iconset/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE=$((SIZE * 2))
  /usr/bin/sips -z "$DOUBLE" "$DOUBLE" "$ICON_SOURCE" --out "$STAGING/Ledgercraft.iconset/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$STAGING/Ledgercraft.iconset" -o "$APP/Contents/Resources/Ledgercraft.icns"
/usr/bin/codesign --force --sign - "$APP/Contents/Resources/runtime/node"
/usr/bin/codesign --force --deep --sign - "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
mkdir -p "$(dirname "$DESTINATION")"
/bin/mv "$APP" "$DESTINATION"
/usr/bin/touch "$DESTINATION"
echo "Built $DESTINATION ($ARCH)"
