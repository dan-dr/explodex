#!/bin/zsh
# Sync SDK, injector, and plugins into Explodex.app bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/Explodex.app/Contents/Resources"

mkdir -p "$RES/plugins"

cp "$ROOT/sdk/explodex-sdk.js" "$RES/explodex-sdk.js"
cp "$ROOT/scripts/cdp-inject.py" "$RES/cdp-inject.py"
chmod +x "$RES/cdp-inject.py"
cp "$ROOT/scripts/relaunch-explodex.sh" "$RES/relaunch-explodex.sh"
chmod +x "$RES/relaunch-explodex.sh"
cp -R "$ROOT/plugins/"* "$RES/plugins/" 2>/dev/null || true
echo "$ROOT" > "$RES/explodex-project-root"
chmod +x "$ROOT/Explodex.app/Contents/MacOS/Explodex"

echo "Synced wrapper bundle:"
echo "  SDK      -> $RES/explodex-sdk.js"
echo "  Injector -> $RES/cdp-inject.py"
echo "  Plugins  -> $RES/plugins/"
