#!/bin/zsh
# Shell entry point for CDP injection.
# Dev: runs TypeScript via Bun. Bundled app: runs compiled binary in Resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -x "$SCRIPT_DIR/cdp-inject-bin" ]]; then
  exec "$SCRIPT_DIR/cdp-inject-bin"
fi

if command -v bun >/dev/null 2>&1; then
  exec bun "$SCRIPT_DIR/cdp-inject.ts"
fi

echo "cdp-inject: need bun or a compiled cdp-inject-bin next to this script" >&2
exit 1