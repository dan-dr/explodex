#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found; install from https://bun.sh" >&2
  exit 1
fi

for script in scripts/*.sh; do
  output="$(zsh -n "$script" 2>&1)" || {
    print -r -- "$output" >&2
    exit 1
  }
  if [[ -n "$output" ]]; then
    print -r -- "$output" | sed '/nice(5) failed: operation not permitted/d'
  fi
done

for ts in scripts/cdp-inject.ts scripts/dev.ts scripts/package-app.ts; do
  bun -e "import './${ts}'"
done

for file in sdk/explodex-sdk.js plugins/*/index.js; do
  bun build "$file" --outfile="/tmp/explodex-validate-$(basename "$file")"
done

for json in package.json .mcp.json plugins/*/plugin.json; do
  bun -e "JSON.parse(await Bun.file('$json').text())"
done

bunx --bun tsc -p sdk/tsconfig.json

echo "validate ok"