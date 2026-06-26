#!/bin/zsh
# Launch Codex with remote debugging and optionally auto-inject Explodex.
#
# Usage:
#   ./scripts/launch.sh                  # launch + inject SDK + plugins
#   ./scripts/launch.sh --no-inject      # debug port only
#   ./scripts/launch.sh --inject-only    # inject into already-running instance
#   ./scripts/launch.sh --plugin path    # extra plugin file or folder (repeatable)
#
# Env:
#   CODEX_PATH                  path to Codex MacOS binary
#   EXPLODEX_SDK_PATH       override SDK file
#   EXPLODEX_PLUGINS_DIR    override plugins directory
#   EXPLODEX_USER_DATA      user data dir (default: ~/.explodex)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=9333
INJECT=1
INJECT_ONLY=0
EXTRA_PLUGINS=()
USER_DATA="${EXPLODEX_USER_DATA:-$HOME/.explodex}"
CODEX_BIN=""

usage() {
    cat <<'EOF'
Usage: launch.sh [options]

Options:
  --inject          Auto-inject SDK + plugins after launch (default)
  --no-inject       Launch with debug port only
  --inject-only     Skip launch; inject into running instance on PORT
  --port PORT       Remote debugging port (default: 9333)
  --plugin PATH     Extra plugin file or folder to inject (repeatable)
  --user-data DIR   CODEX_ELECTRON_USER_DATA_PATH
  --codex PATH      Path to Codex executable
  -h, --help        Show this help

Examples:
  ./scripts/launch.sh
  ./scripts/launch.sh --no-inject
  ./scripts/launch.sh --inject-only
  ./scripts/launch.sh --plugin ./plugins/usage-reset-sidebar
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --inject) INJECT=1; shift ;;
        --no-inject) INJECT=0; shift ;;
        --inject-only) INJECT_ONLY=1; shift ;;
        --port) PORT="$2"; shift 2 ;;
        --plugin) EXTRA_PLUGINS+=("$2"); shift 2 ;;
        --user-data) USER_DATA="$2"; shift 2 ;;
        --codex) CODEX_BIN="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

port_listening() {
    lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

codex_main_running() {
    pgrep -f "Codex.app/Contents/MacOS/Codex" >/dev/null 2>&1
}

debug_port_pids() {
    lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u
}

debug_port_owned_by_codex() {
    local pid args
    for pid in $(debug_port_pids); do
        args=$(ps -p "$pid" -o args= 2>/dev/null) || continue
        if [[ "$args" == *"Codex.app/Contents/MacOS/Codex"* ]]; then
            return 0
        fi
    done
    return 1
}

debug_port_owner_label() {
    local pid comm args
    pid=$(debug_port_pids | head -1)
    [[ -n "$pid" ]] || { echo "unknown"; return 0; }
    comm=$(ps -p "$pid" -o comm= 2>/dev/null | sed 's/^[[:space:]]*//')
    args=$(ps -p "$pid" -o args= 2>/dev/null)
    if [[ "$args" == *"Codex.app"* ]]; then
        echo "Codex"
    else
        echo "${comm:-unknown} (pid $pid)"
    fi
}

local_codex_debug_ready() {
    port_listening && { debug_port_owned_by_codex || codex_main_running; }
}

find_codex() {
    if [[ -n "$CODEX_BIN" && -x "$CODEX_BIN" ]]; then
        echo "$CODEX_BIN"
        return 0
    fi
    if [[ -n "${CODEX_PATH:-}" && -x "$CODEX_PATH" ]]; then
        echo "$CODEX_PATH"
        return 0
    fi
    local candidate="$ROOT/vendor/Codex.app/Contents/MacOS/Codex"
    if [[ -x "$candidate" ]]; then
        echo "$candidate"
        return 0
    fi
    candidate="/Applications/Codex.app/Contents/MacOS/Codex"
    if [[ -x "$candidate" ]]; then
        echo "$candidate"
        return 0
    fi
    return 1
}

run_injector() {
    local plugins_env=""
    if (( ${#EXTRA_PLUGINS[@]} > 0 )); then
        plugins_env="$(IFS=:; echo "${EXTRA_PLUGINS[*]}")"
    fi

    local user_plugins="${EXPLODEX_USER_PLUGINS_DIR:-$HOME/.explodex/plugins}"
    mkdir -p "$user_plugins"

    EXPLODEX_DEBUG_PORT="$PORT" \
        EXPLODEX_SDK_PATH="${EXPLODEX_SDK_PATH:-$ROOT/sdk/explodex-sdk.js}" \
        EXPLODEX_PLUGINS_DIR="${EXPLODEX_PLUGINS_DIR:-$ROOT/plugins}" \
        EXPLODEX_USER_PLUGINS_DIR="$user_plugins" \
        EXPLODEX_PLUGINS="$plugins_env" \
        "$ROOT/scripts/cdp-inject.sh"
}

if [[ "$INJECT_ONLY" -eq 1 ]]; then
    if ! port_listening; then
        echo "No debugger on 127.0.0.1:$PORT. Launch Codex with --remote-debugging-port=$PORT first." >&2
        exit 1
    fi
    run_injector
    exit 0
fi

REAL_CODEX="$(find_codex || true)"
if [[ -z "$REAL_CODEX" ]]; then
    echo "Could not find Codex. Set --codex or CODEX_PATH." >&2
    exit 1
fi

if local_codex_debug_ready; then
    echo "Debug port $PORT already listening (local Codex)."
    if [[ "$INJECT" -eq 1 ]]; then
        run_injector
    fi
    exit 0
fi

if port_listening; then
    owner="$(debug_port_owner_label)"
    echo "Port $PORT is in use by $owner, not local Codex." >&2
    echo "Free the port, set EXPLODEX_DEBUG_PORT, or use --inject-only to inject without launching." >&2
    exit 1
fi

if codex_main_running; then
    echo "Codex is already running without remote debugging." >&2
    echo "Quit Codex (Cmd+Q), then run this script again." >&2
    exit 1
fi

mkdir -p "$USER_DATA"
LOG="$USER_DATA/codex.log"

echo "Launching: $REAL_CODEX"
echo "Debug port: $PORT"
echo "User data:  $USER_DATA"
echo "Log:        $LOG"

CODEX_ELECTRON_USER_DATA_PATH="$USER_DATA" \
    "$REAL_CODEX" --remote-debugging-port="$PORT" >"$LOG" 2>&1 &
CODEX_PID=$!

cleanup() {
    kill "$CODEX_PID" 2>/dev/null || true
}
trap cleanup INT TERM

for _ in {1..60}; do
    if ! kill -0 "$CODEX_PID" 2>/dev/null; then
        if grep -q "Opening in existing browser session" "$LOG" 2>/dev/null; then
            echo "Codex handed off to an existing instance. Quit Codex (Cmd+Q) and retry." >&2
        else
            echo "Codex exited before debug port opened. See $LOG" >&2
        fi
        exit 1
    fi
    if port_listening; then
        break
    fi
    sleep 0.5
done

if ! port_listening; then
    echo "Timed out waiting for port $PORT. See $LOG" >&2
    exit 1
fi

echo "Debug port $PORT is up (PID $CODEX_PID)."

if [[ "$INJECT" -eq 1 ]]; then
    run_injector
    echo "Injection complete."
fi

echo "DevTools: http://127.0.0.1:$PORT/json/list"
echo "Press Ctrl+C to quit Codex."

wait "$CODEX_PID" || true
