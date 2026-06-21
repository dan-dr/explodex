#!/usr/bin/env python3
"""
Explodex local-only patcher for vendor/Codex.app

Usage:
  python3 scripts/patch.py --apply
  python3 scripts/patch.py --restore
  python3 scripts/patch.py --unpack-only   # for inspection

This operates ONLY on vendor/Codex.app. Never touches /Applications.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR_APP = ROOT / "vendor" / "Codex.app"
ASAR = VENDOR_APP / "Contents" / "Resources" / "app.asar"
INFO_PLIST = VENDOR_APP / "Contents" / "Info.plist"
BACKUP_ASAR = ROOT / "vendor" / "app.asar.bak"
SDK_SRC = ROOT / "sdk" / "explodex-sdk.js"
LOADER_SRC = ROOT / "poc" / "loader.js"
PLUGINS_SRC = ROOT / "plugins"

# Where we place our files inside the extracted webview tree
INJECT_DIR_REL = "webview/explodex"
SDK_DEST_REL = f"{INJECT_DIR_REL}/explodex-sdk.js"
LOADER_DEST_REL = f"{INJECT_DIR_REL}/loader.js"

# Loader pulls in SDK + plugins from webview/explodex/
INJECT_SCRIPT_TAG = '<script src="./explodex/loader.js"></script>'

# We relax the CSP just enough for local POC (unsafe-inline for scripts).
# This is only done on the local vendor copy.
SCRIPT_SRC_RELAX = " 'unsafe-inline'"

def log(*a):
    print("[patch]", *a)


def ensure_vendor_copy():
    if not ASAR.exists():
        print("ERROR: vendor/Codex.app app.asar not found. Copy the app first.", file=sys.stderr)
        sys.exit(1)
    # Safety: refuse to run if we detect we are somehow pointing at /Applications
    if "/Applications/Codex.app" in str(VENDOR_APP.resolve()):
        print("REFUSING to operate on /Applications/Codex.app", file=sys.stderr)
        sys.exit(1)


def backup_asar():
    if not BACKUP_ASAR.exists():
        log("backing up original asar ->", BACKUP_ASAR)
        shutil.copy2(ASAR, BACKUP_ASAR)
    else:
        log("backup already exists")


def restore_asar():
    if BACKUP_ASAR.exists():
        log("restoring from backup")
        shutil.copy2(BACKUP_ASAR, ASAR)
        log("restored")
    else:
        log("no backup found at", BACKUP_ASAR)


def restore_full():
    """Also restore Info.plist if we touched ElectronAsarIntegrity (future)."""
    restore_asar()
    # Future: we could keep a .bak of Info.plist and restore the key.


def unpack_to(temp_dir: Path):
    sys.path.insert(0, str(ROOT / "scripts"))
    from asar import unpack as asar_unpack
    log("unpacking asar...")
    asar_unpack(ASAR, temp_dir)
    log("unpacked to", temp_dir)


def patch_index_html(extracted_root: Path):
    idx = extracted_root / "webview" / "index.html"
    if not idx.exists():
        log("ERROR: webview/index.html not found in extracted tree")
        sys.exit(1)

    html = idx.read_text(encoding="utf-8")

    # 1. Inject the script tag before </body> if not already present
    if INJECT_SCRIPT_TAG in html:
        log("index.html already contains our script tag")
    else:
        if "</body>" in html:
            html = html.replace("</body>", f"  {INJECT_SCRIPT_TAG}\n</body>")
            log("injected script tag before </body>")
        else:
            # fallback
            html = html + "\n" + INJECT_SCRIPT_TAG
            log("appended script tag at end of file")

    # 2. Relax CSP for local development / POC only
    # Target the meta http-equiv Content-Security-Policy line
    csp_pattern = re.compile(
        r'(<meta[^>]+Content-Security-Policy[^>]+content=")([^"]+)(")',
        re.IGNORECASE,
    )

    def relax_csp(m):
        prefix, policy, suffix = m.groups()
        # Only touch script-src section
        if "script-src" not in policy:
            return m.group(0)
        # If we already relaxed it, leave it
        if "unsafe-inline" in policy:
            return m.group(0)
        # Insert 'unsafe-inline' after script-src
        new_policy = policy.replace("script-src ", "script-src " + SCRIPT_SRC_RELAX + " ", 1)
        # Some policies are minified with &#39; etc, but we do a simple textual insert
        return prefix + new_policy + suffix

    new_html, n = csp_pattern.subn(relax_csp, html)
    if n > 0:
        html = new_html
        log("relaxed CSP script-src with 'unsafe-inline' (local POC only)")
    else:
        log("no CSP meta found or already relaxed")

    idx.write_text(html, encoding="utf-8")
    log("wrote patched index.html")


def _resolve_sdk_src() -> Path:
    if SDK_SRC.exists():
        return SDK_SRC
    log("ERROR: sdk/explodex-sdk.js not found")
    sys.exit(1)


def iter_plugin_files():
    if not PLUGINS_SRC.exists():
        return
    for plugin in sorted(PLUGINS_SRC.iterdir()):
        if plugin.is_file() and plugin.suffix == ".js":
            yield plugin, f"{plugin.stem}.js"
            continue
        if not plugin.is_dir():
            continue
        for file in sorted(plugin.rglob("*")):
            if file.is_file():
                yield file, str(Path(plugin.name) / file.relative_to(plugin))


def inject_sdk_and_loader(extracted_root: Path):
    inject_dir = extracted_root / INJECT_DIR_REL
    inject_dir.mkdir(parents=True, exist_ok=True)

    sdk_src = _resolve_sdk_src()
    shutil.copy2(sdk_src, inject_dir / "explodex-sdk.js")
    log("copied SDK ->", inject_dir / "explodex-sdk.js")

    plugins_dest = inject_dir / "plugins"
    plugins_dest.mkdir(parents=True, exist_ok=True)
    if PLUGINS_SRC.exists():
        for source, rel in iter_plugin_files():
            dest = plugins_dest / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
            log("copied plugin ->", dest)
    else:
        log("no plugins/ directory found; skipping plugin copy")

    # Copy or create a tiny loader stub (for future expansion)
    if LOADER_SRC.exists():
        shutil.copy2(LOADER_SRC, inject_dir / "loader.js")
        log("copied loader")
    else:
        # Minimal loader stub that just loads the SDK by relative script (we already inject the SDK directly for POC v1)
        (inject_dir / "loader.js").write_text(
            "// Explodex loader stub\n"
            "// For the initial POC we inject explodex-sdk.js directly.\n"
            "// This file is reserved for future bootstrap logic.\n",
            encoding="utf-8",
        )
        log("wrote loader stub")


def repack(temp_dir: Path):
    sys.path.insert(0, str(ROOT / "scripts"))
    from asar import pack as asar_pack
    log("repacking asar...")
    # Repack in place over the original ASAR (we have backup)
    asar_pack(temp_dir, ASAR)
    log("repacked", ASAR)


def maybe_disable_asar_integrity():
    """
    Optional: remove ElectronAsarIntegrity from the local Info.plist.
    This makes the patched ASAR acceptable to this local copy.
    We keep a backup of the plist.
    """
    import plistlib

    if not INFO_PLIST.exists():
        return

    plist_bak = INFO_PLIST.with_suffix(".plist.bak")
    if not plist_bak.exists():
        shutil.copy2(INFO_PLIST, plist_bak)

    with open(INFO_PLIST, "rb") as f:
        data = plistlib.load(f)

    if "ElectronAsarIntegrity" in data:
        log("removing ElectronAsarIntegrity from local Info.plist (POC)")
        del data["ElectronAsarIntegrity"]
        with open(INFO_PLIST, "wb") as f:
            plistlib.dump(data, f)
    else:
        log("no ElectronAsarIntegrity key present (or already removed)")


def apply_patch():
    ensure_vendor_copy()
    backup_asar()

    # Read the current desired artifacts (from source tree, so editing poc/ and re-patching just works)
    sdk_src = _resolve_sdk_src()
    sdk_bytes = sdk_src.read_bytes()
    plugin_bytes = {}
    if PLUGINS_SRC.exists():
        for plugin, rel in iter_plugin_files():
            plugin_bytes[f"webview/explodex/plugins/{rel}"] = plugin.read_bytes()
    loader_bytes = (LOADER_SRC.read_bytes() if LOADER_SRC.exists()
                    else b"// Explodex loader stub\n")

    # Build the patched index.html in memory (we need a temp clean unpack of *just* the html for editing,
    # or we can keep a small pristine reference. For simplicity we still do a minimal unpack of index only
    # using our smart logic, but the bulk data is never re-extracted.
    # To keep things simple and robust we use the append+header method on a base asar.

    # Extract only the original index.html bytes from the pristine backup using the low-level reader
    # (no risk to other files). Then apply our tag + CSP relax.
    sys.path.insert(0, str(ROOT / "scripts"))
    from asar import _read_header
    h, jsz, data_base = _read_header(BACKUP_ASAR)
    def _find_entry(hh, parts):
        c = hh
        for p in parts:
            if "files" in c: c = c["files"]
            c = c[p]
        return c
    entry = _find_entry(h, ["webview", "index.html"])
    raw = BACKUP_ASAR.read_bytes()
    orig_html_bytes = raw[data_base + int(entry["offset"]) : data_base + int(entry["offset"]) + int(entry["size"])]
    html = orig_html_bytes.decode("utf-8", errors="replace")

    if INJECT_SCRIPT_TAG not in html:
        if "</body>" in html:
            html = html.replace("</body>", f"  {INJECT_SCRIPT_TAG}\n</body>")
        else:
            html += "\n" + INJECT_SCRIPT_TAG
    # relax csp (local only)
    csp_pattern = re.compile(r'(<meta[^>]+Content-Security-Policy[^>]+content=")([^"]+)(")', re.IGNORECASE)
    def relax(m):
        pre, pol, suf = m.groups()
        if "script-src" not in pol or "unsafe-inline" in pol:
            return m.group(0)
        return pre + pol.replace("script-src ", "script-src " + SCRIPT_SRC_RELAX + " ", 1) + suf
    html, _ = csp_pattern.subn(relax, html)
    patched_html = html.encode("utf-8")

    # Now do the reliable patch: base on pristine backup + append our stuff + rewrite header
    modifications = {
        "webview/index.html": patched_html,
        "webview/explodex/explodex-sdk.js": sdk_bytes,
        "webview/explodex/loader.js": loader_bytes,
        **plugin_bytes,
    }

    sys.path.insert(0, str(ROOT / "scripts"))
    from asar import build_patched_asar
    log("building patched asar using append + header rewrite (preserves original data blobs)...")
    build_patched_asar(BACKUP_ASAR, modifications, ASAR)

    maybe_disable_asar_integrity()

    log("PATCH COMPLETE (vendor copy now contains the SDK)")

    # Ad-hoc sign so macOS doesn't SIGKILL the mutated bundle
    log("ad-hoc re-signing the bundle...")
    import subprocess
    subprocess.call(["xattr", "-cr", str(VENDOR_APP)])
    subprocess.call(["codesign", "--force", "--deep", "-s", "-", str(VENDOR_APP)])

    log("Launch the patched copy:")
    print(
        f'CODEX_ELECTRON_USER_DATA_PATH="$PWD/.explodex-user-data" \\\n'
        f'  ./vendor/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9333'
    )
    log("Re-run this patcher any time you edit sdk/explodex-sdk.js to update the injected copy.")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true", help="Apply Explodex injection to vendor copy")
    g.add_argument("--restore", action="store_true", help="Restore original app.asar from backup")
    g.add_argument("--unpack-only", action="store_true", help="Just unpack for inspection into ./extracted")
    args = ap.parse_args()

    if args.apply:
        apply_patch()
    elif args.restore:
        restore_full()
    elif args.unpack_only:
        ensure_vendor_copy()
        out = ROOT / "extracted"
        if out.exists():
            shutil.rmtree(out)
        sys.path.insert(0, str(ROOT / "scripts"))
        from asar import unpack as asar_unpack
        asar_unpack(ASAR, out)
        log("unpacked to ./extracted (read-only inspection)")


if __name__ == "__main__":
    main()
