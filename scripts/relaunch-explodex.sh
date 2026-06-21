#!/bin/zsh
# Wait for Codex to quit, then relaunch via Explodex.app wrapper.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPLODEX_APP="$PROJECT_DIR/Explodex.app"

if [[ ! -d "$EXPLODEX_APP" ]]; then
  # Fallback: try sibling of project or Applications
  if [[ -d "/Applications/Explodex.app" ]]; then
    EXPLODEX_APP="/Applications/Explodex.app"
  else
    echo "Explodex: relaunch script could not find Explodex.app" >&2
    exit 1
  fi
fi

for _ in {1..60}; do
  if ! pgrep -f "Codex.app/Contents/MacOS/Codex" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

open "$EXPLODEX_APP"