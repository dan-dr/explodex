#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_BIN=""
for candidate in \
  "$HOME/.local/share/mise/installs/node/22.21.0/bin/node" \
  "$HOME/.local/share/mise/shims/node" \
  "$(command -v node 2>/dev/null || true)"
do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found; install via mise or set PATH" >&2
  exit 1
fi

python3 - <<'PY'
from pathlib import Path

for path in [Path("scripts/asar.py"), Path("scripts/cdp-inject.py"), Path("scripts/patch.py")]:
    compile(path.read_text(encoding="utf-8"), str(path), "exec")
PY

for script in scripts/*.sh; do
  output="$(zsh -n "$script" 2>&1)" || {
    print -r -- "$output" >&2
    exit 1
  }
  if [[ -n "$output" ]]; then
    print -r -- "$output" | sed '/nice(5) failed: operation not permitted/d'
  fi
done

for file in sdk/explodex-sdk.js plugins/*/index.js poc/loader.js; do
  "$NODE_BIN" --check "$file"
done

python3 -m json.tool package.json >/dev/null
python3 -m json.tool .mcp.json >/dev/null
for manifest in plugins/*/plugin.json; do
  python3 -m json.tool "$manifest" >/dev/null
done

echo "validate ok"
