#!/bin/zsh
# Remove generated artifacts, logs, and local scratch from the repo (and optionally user state).
#
# Usage:
#   ./scripts/clean.sh              # repo artifacts + stray logs (default)
#   ./scripts/clean.sh --user       # also clear ~/.explodex logs + Codex user data (keeps plugins)
#   ./scripts/clean.sh --deep       # also remove vendor/, extracted/, node_modules/, etc.
#   ./scripts/clean.sh --dry-run    # print what would be removed
#
# Safe by default: never deletes ~/.explodex/plugins or /Applications installs.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
CLEAN_USER=0
CLEAN_DEEP=0

usage() {
  cat <<'EOF'
Usage: clean.sh [options]

Options:
  --user      Also remove ~/.explodex logs and Codex user data (keeps plugins/)
  --deep      Also remove vendor/, extracted/, tmp_extracted/, node_modules/, coverage/
  --dry-run   Show paths that would be removed without deleting
  -h, --help  Show this help

Default removes:
  - dist/ (entire directory)
  - .explodex-user-data/, .perf-traces/
  - repo-root *.app bundles, *.log, *.tmp, *.bak, .DS_Store
  - assets/icon/Explodex.iconset (icon build scratch)
  - /tmp/explodex-validate-* (validate.sh temp bundles)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) CLEAN_USER=1; shift ;;
    --deep) CLEAN_DEEP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

removed=0
skipped=0

remove_path() {
  local path="$1"
  [[ -e "$path" || -L "$path" ]] || return 0

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would remove: $path"
    removed=$((removed + 1))
    return 0
  fi

  rm -rf "$path"
  echo "removed: $path"
  removed=$((removed + 1))
}

remove_glob() {
  setopt local_options null_glob
  local pattern="$1"
  local match
  for match in $~pattern; do
    remove_path "$match"
  done
}

echo "Explodex clean (root: $ROOT)"

# ── Repo artifacts ────────────────────────────────────────────────────────────

remove_path "$ROOT/dist"

for dir in .explodex-user-data .perf-traces .explodex; do
  remove_path "$ROOT/$dir"
done

remove_glob "$ROOT/*.app"
remove_glob "$ROOT/*.asar"
remove_path "$ROOT/assets/icon/Explodex.iconset"
remove_glob "/tmp/explodex-validate-*"

while IFS= read -r -d '' path; do
  remove_path "$path"
done < <(find "$ROOT" \
  \( -path "$ROOT/.git/*" -o -path "$ROOT/vendor/*" -o -path "$ROOT/extracted/*" \
     -o -path "$ROOT/tmp_extracted/*" -o -path "$ROOT/node_modules/*" \) -prune \
  -o \( -name '*.log' -o -name '*.tmp' -o -name '*.bak' -o -name '.DS_Store' \) -print0 2>/dev/null)

# ── User state (~/.explodex) ──────────────────────────────────────────────────

if [[ "$CLEAN_USER" -eq 1 ]]; then
  user_home="${EXPLODEX_USER_DATA:-$HOME/.explodex}"
  echo ""
  echo "User state: $user_home (plugins/ preserved)"

  for name in launcher.log codex.log; do
    remove_path "$user_home/$name"
  done

  if [[ -d "$user_home" ]]; then
    for entry in "$user_home"/*(N); do
      [[ "$(basename "$entry")" == "plugins" ]] && {
        skipped=$((skipped + 1))
        echo "kept: $entry"
        continue
      }
      remove_path "$entry"
    done
  fi
fi

# ── Deep local RE / deps ──────────────────────────────────────────────────────

if [[ "$CLEAN_DEEP" -eq 1 ]]; then
  echo ""
  echo "Deep clean"
  for dir in vendor extracted tmp_extracted node_modules coverage; do
    remove_path "$ROOT/$dir"
  done
fi

echo ""
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run: $removed path(s) would be removed."
else
  echo "Done: $removed removed, $skipped preserved."
fi