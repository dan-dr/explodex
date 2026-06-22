#!/bin/zsh
# Deprecated alias — packages dist/Explodex.app from source.
set -euo pipefail
exec bun "$(cd "$(dirname "$0")" && pwd)/package-app.ts" "$@"