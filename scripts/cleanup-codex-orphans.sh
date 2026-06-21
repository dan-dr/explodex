#!/bin/zsh
# Kill orphaned Codex crashpad/helper processes left behind by repeated launches.
# Safe: does not kill a running Codex main process.

set -euo pipefail

if pgrep -x Codex >/dev/null 2>&1; then
    echo "Codex is running — quit it (Cmd+Q) before cleaning orphans."
    exit 1
fi

before=$(pgrep -c crashpad_handler 2>/dev/null || echo 0)
if [[ "$before" -eq 0 ]]; then
    echo "No crashpad_handler orphans found."
    exit 0
fi

echo "Killing $before orphaned crashpad_handler process(es)..."
pkill -x browser_crashpad_handler 2>/dev/null || true
sleep 0.5
after=$(pgrep -c crashpad_handler 2>/dev/null || echo 0)
echo "Remaining crashpad_handler: $after"