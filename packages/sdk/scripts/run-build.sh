#!/usr/bin/env bash
# Prefer the official Bun install over incomplete node_modules/.bin/bun shadows
# that npm injects at the front of PATH during pack/prepack.
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
if [[ -x "${HOME}/.bun/bin/bun" ]]; then
  exec "${HOME}/.bun/bin/bun" "${SCRIPT_DIR}/build.ts" "$@"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun "${SCRIPT_DIR}/build.ts" "$@"
fi
echo "error: bun is required to build packages/sdk" >&2
exit 1
