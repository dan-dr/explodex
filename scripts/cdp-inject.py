#!/usr/bin/env python3
"""
Runtime-only injector for Explodex using Chrome DevTools Protocol.

This lets you inject the SDK into a running Codex instance WITHOUT
modifying the asar or breaking signatures. Perfect for POC/dev.

Usage:
  1. Launch Codex with remote debugging:
     CODEX_ELECTRON_USER_DATA_PATH="$PWD/.explodex-user-data" \
       ./vendor/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9333

  2. In another terminal:
     python3 scripts/cdp-inject.py

  The script will:
  - Wait for the debugger port
  - Find the main renderer page
  - Use Page.addScriptToEvaluateOnNewDocument to inject the entire SDK
  - The SDK will run on current page and any future navigations/reloads

No asar patching required. The base Codex remains untouched.
"""

import json
import re
import socket
import time
import urllib.request
import os
import sys
from pathlib import Path

PORT = int(os.environ.get("EXPLODEX_DEBUG_PORT") or os.environ.get("BETTERCODEX_DEBUG_PORT", "9333"))
HOST = "127.0.0.1"

def _find_sdk_path():
    """Find the SDK in several possible locations (dev, bundle, etc)."""
    candidates = [
        Path(__file__).parent.parent / "sdk" / "explodex-sdk.js",      # canonical SDK
        Path(__file__).parent.parent / "sdk" / "bettercodex-sdk.js",   # legacy dev layout
        Path(__file__).parent / "explodex-sdk.js",                     # wrapper Resources
        Path(__file__).parent / "bettercodex-sdk.js",                  # legacy wrapper Resources
        Path.cwd() / "sdk" / "explodex-sdk.js",
        Path.cwd() / "sdk" / "bettercodex-sdk.js",
        Path(os.environ.get("EXPLODEX_SDK_PATH") or os.environ.get("BETTERCODEX_SDK_PATH", "")),
    ]
    for cand in candidates:
        if cand and cand.exists() and cand.is_file():
            return cand.resolve()
    return None

SDK_PATH = _find_sdk_path()

def _find_plugins_dir():
    """Resolve plugins directory for dev tree or Explodex.app bundle."""
    here = Path(__file__).resolve()
    env_dir = (os.environ.get("EXPLODEX_PLUGINS_DIR") or os.environ.get("BETTERCODEX_PLUGINS_DIR", "")).strip()
    candidates = [
        Path(env_dir) if env_dir else None,
        here.parent / "plugins",                 # bundled: Contents/Resources/plugins
        here.parents[3] / "plugins",             # project: Explodex.app/../plugins
        here.parents[1] / "plugins",             # scripts/../plugins
    ]
    for cand in candidates:
        if cand and cand.exists() and cand.is_dir():
            return cand.resolve()
    return None

PLUGINS_DIR = _find_plugins_dir()

def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"WARN: could not read {path}: {exc}")
        return {}


def _plugin_entry_from_file(path: Path) -> dict | None:
    if not path.exists() or not path.is_file():
        return None
    source = path.read_text(encoding="utf-8")
    entry = _parse_plugin_manifest(source, path.name)
    entry["source"] = source
    entry["path"] = str(path)
    return entry


def _plugin_entry_from_dir(path: Path) -> dict | None:
    manifest_path = path / "plugin.json"
    manifest = _read_json(manifest_path) if manifest_path.exists() else {}
    entry_name = manifest.get("entry", "index.js")
    entry_path = path / entry_name
    if not entry_path.exists() or not entry_path.is_file():
      print(f"WARN: plugin {path.name} has no entry file at {entry_path}")
      return None

    source = entry_path.read_text(encoding="utf-8")
    parsed = _parse_plugin_manifest(source, entry_path.name)
    entry = {**parsed, **manifest}
    entry["id"] = entry.get("id") or path.name
    entry["name"] = entry.get("name") or entry["id"]
    entry["version"] = entry.get("version") or "0.0.0"
    entry["source"] = source
    entry["path"] = str(entry_path)
    return entry


def _discover_plugins():
    """Collect Explodex DOM plugins for the runtime catalog."""
    env = (os.environ.get("EXPLODEX_PLUGINS") or os.environ.get("BETTERCODEX_PLUGINS", "")).strip()
    if env:
        paths = [Path(p).expanduser() for p in env.split(os.pathsep) if p.strip()]
        entries = []
        for path in paths:
            resolved = path.resolve()
            entry = _plugin_entry_from_dir(resolved) if resolved.is_dir() else _plugin_entry_from_file(resolved)
            if entry:
                entries.append(entry)
        return entries
    if not PLUGINS_DIR:
        return []

    entries = []
    seen_ids = set()
    for child in sorted(PLUGINS_DIR.iterdir()):
        entry = None
        if child.is_dir():
            entry = _plugin_entry_from_dir(child)
        elif child.suffix == ".js":
            entry = _plugin_entry_from_file(child)
        if not entry:
            continue
        if entry["id"] in seen_ids:
            print(f"WARN: skipping duplicate plugin id {entry['id']} at {entry.get('path')}")
            continue
        seen_ids.add(entry["id"])
        entries.append(entry)
    return entries


def _parse_plugin_manifest(source: str, filename: str) -> dict:
    """Best-effort manifest extraction from BC.plugins.register({ ... })."""
    manifest = {
        "id": Path(filename).stem,
        "name": Path(filename).stem,
        "version": "0.0.0",
        "dynamicLoadable": True,
        "dynamicUnloadable": True,
    }
    block = re.search(
        r"BC\.plugins\.register\s*\(\s*\{([\s\S]*?)\}\s*,",
        source,
    )
    if not block:
        return manifest

    body = block.group(1)

    def pick(key: str, fallback=None):
        match = re.search(rf"{key}\s*:\s*['\"]([^'\"]+)['\"]", body)
        return match.group(1) if match else fallback

    def pick_bool(key: str, fallback: bool) -> bool:
        match = re.search(rf"{key}\s*:\s*(true|false)", body)
        return match.group(1) == "true" if match else fallback

    manifest["id"] = pick("id", manifest["id"])
    manifest["name"] = pick("name", manifest["name"])
    manifest["version"] = pick("version", manifest["version"])
    manifest["dynamicLoadable"] = pick_bool("dynamicLoadable", True)
    manifest["dynamicUnloadable"] = pick_bool("dynamicUnloadable", True)
    return manifest


def _find_relaunch_script():
    here = Path(__file__).resolve()
    candidates = [
        here.parent / "relaunch-explodex.sh",
        here.parents[1] / "scripts" / "relaunch-explodex.sh",
    ]
    for cand in candidates:
        if cand.exists() and cand.is_file():
            return cand.resolve()
    return None


def _build_catalog_bootstrap(plugin_entries: list[dict]) -> str:
    catalog = []
    for entry in plugin_entries:
        catalog.append({k: v for k, v in entry.items() if k != "path"})

    relaunch = _find_relaunch_script()
    paths_meta = {}
    if relaunch:
        paths_meta["relaunchScript"] = f"file://{relaunch}"

    return (
        f"window.__EXPLODEX_PLUGIN_CATALOG__ = {json.dumps(catalog)};\n"
        f"window.__EXPLODEX_PATHS__ = {json.dumps(paths_meta)};\n"
        "if (window.Explodex?.plugins?.initFromCatalog) {\n"
        "  window.Explodex.plugins.initFromCatalog();\n"
        "}\n"
    )

def wait_for_port(host, port, timeout=30):
    print(f"Waiting for debugger on {host}:{port}...")
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection((host, port), timeout=1):
                print("Debugger port is up.")
                return True
        except OSError:
            time.sleep(0.5)
    print("Timed out waiting for debugger port.")
    return False

def get_targets():
    url = f"http://{HOST}:{PORT}/json/list"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            data = resp.read().decode("utf-8")
            return json.loads(data)
    except Exception as e:
        return []

def find_main_page(targets):
    # Prefer the main renderer page (usually has the Codex URL or is the largest one)
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        return None

    # Heuristic: the one that looks like the main app (not devtools itself)
    for p in pages:
        url = p.get("url", "")
        title = p.get("title", "")
        if "codex" in url.lower() or "codex" in title.lower() or "localhost" not in url:
            if "devtools" not in url.lower():
                return p

    # Fallback to first page
    return pages[0]

def ws_handshake(sock, ws_url):
    """Minimal WebSocket handshake for CDP (text frames only)."""
    from urllib.parse import urlparse
    import base64
    import hashlib
    import os

    parsed = urlparse(ws_url)
    host = parsed.hostname or HOST
    port = parsed.port or 9222
    path = parsed.path or "/"

    key = base64.b64encode(os.urandom(16)).decode()
    headers = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    ).encode()

    sock.connect((host, port))
    sock.sendall(headers)

    # Read response
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("Handshake failed")
        resp += chunk

    if b"101" not in resp and b"Switching Protocols" not in resp:
        raise RuntimeError(f"Bad handshake: {resp[:200]}")

def ws_send_text(sock, payload: str):
    """Send a text WebSocket frame (properly masked as a client should)."""
    import os
    data = payload.encode("utf-8")
    mask_key = os.urandom(4)

    frame = bytearray()
    frame.append(0x81)  # FIN + text
    length = len(data)
    if length < 126:
        frame.append(0x80 | length)  # mask bit + length
    elif length < 65536:
        frame.append(0x80 | 126)
        frame.extend(length.to_bytes(2, "big"))
    else:
        frame.append(0x80 | 127)
        frame.extend(length.to_bytes(8, "big"))

    frame.extend(mask_key)
    # Mask the payload
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
    frame.extend(masked)
    sock.sendall(frame)

def ws_recv(sock, timeout=5):
    """Receive one text frame (very minimal parser)."""
    sock.settimeout(timeout)
    header = sock.recv(2)
    if len(header) < 2:
        return None
    opcode = header[0] & 0x0F
    if opcode != 1:  # not text
        # drain
        return None
    length = header[1] & 0x7F
    if length == 126:
        length = int.from_bytes(sock.recv(2), "big")
    elif length == 127:
        length = int.from_bytes(sock.recv(8), "big")

    mask = (header[1] & 0x80) != 0
    if mask:
        mask_key = sock.recv(4)
    data = sock.recv(length)
    if mask:
        data = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
    return data.decode("utf-8", errors="replace")

RENDERER_READY_EXPR = """(() => {
  const root = document.getElementById("root");
  const rootChildren = root?.childElementCount ?? 0;
  const textLen = document.body?.innerText?.length ?? 0;
  return {
    readyState: document.readyState,
    rootChildren,
    textLen,
    ok: rootChildren > 0 && textLen > 50
  };
})()"""


def cdp_request(ws_url: str, method: str, params: dict, req_id: int = 1, timeout: float = 5):
    """Send one CDP request over a short-lived WebSocket and return parsed JSON."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        ws_handshake(sock, ws_url)
        ws_send_text(sock, json.dumps({"id": req_id, "method": method, "params": params}))
        raw = ws_recv(sock, timeout=timeout)
        if not raw:
            return None
        return json.loads(raw)
    finally:
        sock.close()


def wait_for_renderer_ready(ws_url: str, timeout: float = 45):
    """Wait until the Codex React shell has mounted (avoids injecting into a blank page)."""
    print("Waiting for renderer UI to mount...")
    start = time.time()
    attempt = 0
    while time.time() - start < timeout:
        try:
            resp = cdp_request(
                ws_url,
                "Runtime.evaluate",
                {"expression": RENDERER_READY_EXPR, "returnByValue": True},
                req_id=9000 + attempt,
                timeout=4,
            )
            value = (
                resp.get("result", {})
                .get("result", {})
                .get("value")
                if resp
                else None
            )
            if isinstance(value, dict) and value.get("ok"):
                print(
                    "Renderer ready "
                    f"(rootChildren={value.get('rootChildren')}, textLen={value.get('textLen')})."
                )
                return True
            if attempt % 5 == 0 and isinstance(value, dict):
                print(
                    "Renderer not ready yet "
                    f"(state={value.get('readyState')}, root={value.get('rootChildren')}, "
                    f"text={value.get('textLen')})..."
                )
        except Exception as exc:
            if attempt % 5 == 0:
                print(f"Renderer readiness check failed: {exc}")
        attempt += 1
        time.sleep(0.5)
    print("Timed out waiting for renderer UI to mount.")
    return False


def _runtime_eval_error(resp):
    if not resp:
        return "no CDP response"
    result = resp.get("result", {}).get("result", {})
    if result.get("subtype") == "error":
        return result.get("description") or result.get("className") or "runtime error"
    if resp.get("error"):
        return resp["error"].get("message", "CDP error")
    return None


def inject_sources_via_cdp(ws_url: str, sources: list[tuple[str, str]]):
    """Connect and send Page.addScriptToEvaluateOnNewDocument for each source."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        ws_handshake(sock, ws_url)
        print("WebSocket connected.")

        for idx, (label, source) in enumerate(sources, start=1):
            cmd = {
                "id": idx,
                "method": "Page.addScriptToEvaluateOnNewDocument",
                "params": {
                    "source": source,
                    "world": "MAIN",
                },
            }
            ws_send_text(sock, json.dumps(cmd))
            print(f"Sent addScriptToEvaluateOnNewDocument for {label}")

            try:
                resp = ws_recv(sock, timeout=3)
                if resp:
                    print(f"  Response ({label}):", resp[:200])
            except socket.timeout:
                pass

            eval_cmd = {
                "id": 1000 + idx,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": source,
                    "returnByValue": False,
                },
            }
            ws_send_text(sock, json.dumps(eval_cmd))
            print(f"Also sent immediate Runtime.evaluate for {label}")
            try:
                eval_resp_raw = ws_recv(sock, timeout=10)
                if eval_resp_raw:
                    eval_resp = json.loads(eval_resp_raw)
                    err = _runtime_eval_error(eval_resp)
                    if err:
                        print(f"  ERROR ({label}): {err[:500]}")
                        raise RuntimeError(f"Injection failed for {label}: {err[:300]}")
                    print(f"  Eval OK ({label})")
            except socket.timeout:
                print(f"  WARN: no eval response for {label} (may still be OK)")

        print("Injection commands sent successfully.")
        print("Explodex SDK + plugins should now be active (and on future loads).")

    finally:
        sock.close()

def main():
    if not wait_for_port(HOST, PORT):
        sys.exit(1)

    if not SDK_PATH or not SDK_PATH.exists():
        print(f"ERROR: Could not find explodex-sdk.js")
        print("Looked in several locations relative to the injector.")
        print("Set EXPLODEX_SDK_PATH env var or place explodex-sdk.js next to the injector script.")
        sys.exit(1)

    sdk_source = SDK_PATH.read_text(encoding="utf-8")
    print(f"Loaded SDK ({len(sdk_source)} bytes) from {SDK_PATH}")

    plugin_entries = _discover_plugins()
    catalog_source = _build_catalog_bootstrap(plugin_entries)
    sources = [
        ("explodex-sdk.js", sdk_source),
        ("explodex-plugin-catalog.js", catalog_source),
    ]
    for plugin in plugin_entries:
        print(f"Cataloged plugin {plugin['id']} ({plugin.get('path', 'unknown path')})")

    if not plugin_entries:
        print("No plugins found (set EXPLODEX_PLUGINS or add plugins/<id>/)")

    # Discover targets
    for attempt in range(20):
        targets = get_targets()
        page = find_main_page(targets)
        if page and page.get("webSocketDebuggerUrl"):
            ws_url = page["webSocketDebuggerUrl"]
            print(f"Found main page: {page.get('url', page.get('title', ''))}")
            print(f"Connecting to {ws_url}")
            if not wait_for_renderer_ready(ws_url):
                print("WARN: injecting anyway — renderer readiness probe timed out")
            inject_sources_via_cdp(ws_url, sources)
            return
        print(f"Waiting for renderer page... ({attempt})")
        time.sleep(0.8)

    print("Could not find a suitable page target.")
    print("Make sure Codex is fully started and try again.")
    sys.exit(1)

if __name__ == "__main__":
    main()
