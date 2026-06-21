#!/bin/zsh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="$ROOT/vendor/app.asar.bak"
ASAR="$ROOT/vendor/Codex.app/Contents/Resources/app.asar"
PLIST="$ROOT/vendor/Codex.app/Contents/Info.plist"
PLIST_BAK="$ROOT/vendor/Codex.app/Contents/Info.plist.bak"

if [[ ! -f "$BACKUP" ]]; then
  echo "No backup found at $BACKUP"
  exit 1
fi

echo "Restoring $ASAR from backup..."
cp -f "$BACKUP" "$ASAR"

if [[ -f "$PLIST_BAK" ]]; then
  echo "Restoring Info.plist..."
  cp -f "$PLIST_BAK" "$PLIST"
fi

echo "Done. vendor/Codex.app is back to original state."

# Re-sign ad-hoc so the clean bundle is runnable under hardened runtime
xattr -cr "$ROOT/vendor/Codex.app" 2>/dev/null || true
codesign --force --deep -s - "$ROOT/vendor/Codex.app" 2>/dev/null || true
echo "Re-signed ad-hoc for local execution."
