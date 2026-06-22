#!/bin/zsh
# Bundled relaunch helper for plugin-manager restart flow.
# Waits for Codex to quit, then reopens this Explodex.app bundle.
set -euo pipefail

RESOURCES="$(cd "$(dirname "$0")" && pwd)"
CONTENTS="$(cd "$RESOURCES/.." && pwd)"
EXPLODEX_APP="$(cd "$CONTENTS/.." && pwd)"

for _ in {1..60}; do
  if ! pgrep -f "Codex.app/Contents/MacOS/Codex" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

open "$EXPLODEX_APP"