#!/bin/bash
# Tests use only the bundle's runtime and assets. Installation is a separate command.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:?Pass the absolute path to Ledgercraft.app}"
app="$(cd "$app" && pwd)"
out="${2:?Pass an output directory for evidence}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
key="$(/usr/libexec/PlistBuddy -c 'Print :FinancerBookResources' "$app/Contents/Info.plist")"
resources="$app/Contents/Resources/$key"
runtime_key="$(/usr/libexec/PlistBuddy -c 'Print :FinancerRuntimeResources' "$app/Contents/Info.plist" 2>/dev/null || echo runtime)"
runtime="$app/Contents/Resources/$runtime_key/node"
python="${LEDGERCRAFT_PYTHON:-python3}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/ledgercraft-packaged-tests-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
for file in server.js package.json lib public data; do
  ln -s "$resources/$file" "$scratch/$file"
done
cp -R "$repo/test" "$scratch/test"
mkdir "$scratch/tools"
cp "$repo/tools/verify-tally-public-examples.mjs" "$scratch/tools/"
/usr/bin/codesign --verify --deep --strict "$app"
"$python" "$repo/tools/verified-mac-install.py" fingerprint "$app" > "$scratch/before-tests.json"
cd "$scratch"
"$runtime" --test --test-reporter=spec > "$out/packaged-tests.txt" 2>&1
"$runtime" tools/verify-tally-public-examples.mjs > "$out/tally-public-examples.json"
"$python" "$repo/tools/verify-native-launch.py" "$app" > "$out/native-launch.json"
"$python" "$repo/tools/verified-mac-install.py" fingerprint "$app" > "$scratch/after-tests.json"
cmp "$scratch/before-tests.json" "$scratch/after-tests.json"
cp "$scratch/after-tests.json" "$out/tested-build.json"
