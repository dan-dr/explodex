#!/usr/bin/env python3
"""
Minimal ASAR unpack/pack utilities for Explodex local POC patching.
Only for use against vendor/Codex.app copy. Not for production.
"""
import json
import os
import stat
import struct
from pathlib import Path
from typing import Any, Dict, Tuple

MAGIC = b"ASAR"


def _read_header(asar_path: Path) -> Tuple[Dict[str, Any], int, int]:
    """Return (header_dict, json_size, data_offset).
    Strictly prefers the size fields from the 16-byte prefix and validates
    that the computed data base actually yields sensible file content.
    """
    with open(asar_path, "rb") as f:
        prefix = f.read(16)
        if len(prefix) != 16:
            raise ValueError("Invalid ASAR (too small)")
        u0, u1, u2, u3 = struct.unpack("<IIII", prefix)
        # Prefer the values observed in real bundles (u3 is usually the exact json len)
        candidates = [u3, u2, u1]

        def looks_like_asar_header(h: dict) -> bool:
            if not isinstance(h, dict):
                return False
            # asar headers have a "files" object at top (or the whole thing is the files tree)
            root = h.get("files", h)
            if not isinstance(root, dict):
                return False
            # Must have some of the known top level entries from this app
            for key in ("package.json", "webview", ".vite", "node_modules"):
                if key in root:
                    return True
            return bool(root)

        def try_jsz(jsz: int):
            if jsz <= 0:
                return None
            f.seek(16)
            raw = f.read(jsz).rstrip(b"\x00")
            try:
                h = json.loads(raw)
            except Exception:
                return None
            if not looks_like_asar_header(h):
                return None
            return h, jsz

        header = None
        jsz = None
        for c in candidates + [u3 + 4, u3 - 4]:
            res = try_jsz(c)
            if res:
                header, jsz = res
                break

        if header is None:
            # Last resort: scan forward from the prefix values a small window
            for c in range(max(8, u3 - 64), u3 + 128, 4):
                res = try_jsz(c)
                if res:
                    header, jsz = res
                    break

        if header is None or jsz is None:
            raise ValueError("Could not locate valid asar header JSON")

        data_offset = 16 + jsz

        # Validate the base by sampling the top level package.json (or another small text file)
        # If it doesn't look like reasonable content, nudge the base.
        root = header.get("files", header)
        pkg_entry = None
        if "package.json" in root:
            pkg_entry = root["package.json"]
        elif "files" in root and "package.json" in root["files"]:
            pkg_entry = root["files"]["package.json"]

        if pkg_entry:
            off = int(pkg_entry.get("offset", 0))
            sz = int(pkg_entry.get("size", 0))
            f.seek(data_offset + off)
            sample = f.read(min(200, sz))
            # It should look like JSON starting with { or have the real package name
            if not (sample.strip().startswith(b"{") or b"openai-codex-electron" in sample or b"tslib" in sample):
                # Try the known good delta we observed (16 + jsz gave correct in probes)
                # Most common correct is exactly 16 + jsz
                for delta in (0, 4, -4):
                    f.seek(16 + jsz + delta + off)
                    sample2 = f.read(min(200, sz))
                    if sample2.strip().startswith(b"{") or b"openai-codex-electron" in sample2:
                        data_offset = 16 + jsz + delta
                        break

        return header, jsz, data_offset


def unpack(asar_path: str | Path, out_dir: str | Path) -> Dict[str, Any]:
    """Unpack an asar archive into out_dir. Returns the header."""
    asar_path = Path(asar_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    header, json_size, data_offset = _read_header(asar_path)

    def walk(node: Dict[str, Any], rel: Path):
        if "files" in node:
            for name, child in node["files"].items():
                walk(child, rel / name)
        else:
            # file entry
            offset = int(node.get("offset", 0))
            size = int(node.get("size", 0))
            target = out_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(asar_path, "rb") as f:
                f.seek(data_offset + offset)
                data = f.read(size)
            target.write_bytes(data)
            # preserve executable bit if present in original header
            if node.get("executable"):
                target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    files_root = header.get("files", header)
    for name, child in files_root.items():
        walk(child, Path(name))

    # write header for reference / repack
    (out_dir / ".asar-header.json").write_text(json.dumps(header, indent=2))
    return header


def _build_tree(root_dir: Path) -> Dict[str, Any]:
    """Build the files tree dict expected by ASAR from a directory."""
    tree: Dict[str, Any] = {"files": {}}

    def add_dir(current_tree: Dict[str, Any], dir_path: Path, rel_to_root: Path):
        current_tree.setdefault("files", {})
        for entry in sorted(dir_path.iterdir()):
            if entry.name == ".asar-header.json":
                continue
            rel = rel_to_root / entry.name
            if entry.is_dir():
                sub: Dict[str, Any] = {"files": {}}
                current_tree["files"][entry.name] = sub
                add_dir(sub, entry, rel)
            else:
                size = entry.stat().st_size
                # placeholder offset; will be filled during pack
                is_exec = os.access(entry, os.X_OK)
                current_tree["files"][entry.name] = {
                    "size": size,
                    "offset": "0",  # filled later
                    **({"executable": True} if is_exec else {}),
                }

    # root level
    for entry in sorted(root_dir.iterdir()):
        if entry.name == ".asar-header.json":
            continue
        if entry.is_dir():
            sub: Dict[str, Any] = {"files": {}}
            tree["files"][entry.name] = sub
            add_dir(sub, entry, Path(entry.name))
        else:
            size = entry.stat().st_size
            is_exec = os.access(entry, os.X_OK)
            tree["files"][entry.name] = {
                "size": size,
                "offset": "0",
                **({"executable": True} if is_exec else {}),
            }
    return tree


def pack(in_dir: str | Path, out_asar: str | Path) -> None:
    """Pack a directory tree (produced by unpack or manually prepared) into an asar."""
    in_dir = Path(in_dir)
    out_asar = Path(out_asar)

    # Build skeleton tree
    tree = _build_tree(in_dir)

    # Collect all files in order (depth-first, sorted) and assign offsets
    files_in_order: list[Tuple[Path, int, int]] = []  # (abs_path, size, offset_to_write)
    current_offset = 0

    def collect(node: Dict[str, Any], dir_path: Path):
        nonlocal current_offset
        if "files" in node:
            for name, child in sorted(node["files"].items()):
                collect(child, dir_path / name)
        else:
            # leaf file
            abs_path = in_dir / dir_path
            size = abs_path.stat().st_size
            node["offset"] = str(current_offset)
            files_in_order.append((abs_path, size, current_offset))
            current_offset += size

    # populate offsets
    root_files = tree.get("files", {})
    for name, child in sorted(root_files.items()):
        collect(child, Path(name))

    header_json = json.dumps(tree, separators=(",", ":"))
    header_bytes = header_json.encode("utf-8")

    # Write asar
    # Format: 4 bytes (4), 4 bytes (json_size), 4 bytes (json_size?), 4 bytes (json_size?)
    # then json, then raw file blobs.
    # We replicate what the source used (4, json_size, json_size-4?, json_size-10?).
    # Empirical from the bundle: 4, 771100, 771096, 771090
    # For simplicity and compatibility we use:
    #   [4] [len(header)] [len(header)-4] [len(header)-10] + header + blobs
    # Many extractors only care about the second uint being the json length.
    json_len = len(header_bytes)
    # Make the 4th uint32 (the one _read_header prefers) exactly the json length
    sizes = (4, json_len + 10, json_len + 6, json_len)

    with open(out_asar, "wb") as f:
        f.write(struct.pack("<IIII", *sizes))
        f.write(header_bytes)
        # now append file contents in the order we assigned offsets
        for abs_path, size, _ in files_in_order:
            data = abs_path.read_bytes()
            if len(data) != size:
                # size changed between tree build and write (shouldn't happen)
                pass
            f.write(data)

    print(f"[asar] packed {len(files_in_order)} files -> {out_asar}")


def _ensure_tree_path(tree: dict, virtual_path: str):
    """Ensure the nested 'files' dicts exist for a virtual path like 'webview/explodex/foo.js'."""
    parts = virtual_path.split("/")
    cur = tree
    for i, part in enumerate(parts):
        if "files" not in cur:
            cur["files"] = {}
        if i == len(parts) - 1:
            # leaf will be set by caller
            return cur, part
        if part not in cur["files"]:
            cur["files"][part] = {"files": {}}
        cur = cur["files"][part]
    return cur, parts[-1]


def build_patched_asar(base_asar: str | Path, modifications: dict[str, bytes], out_asar: str | Path):
    """
    Create a patched asar by taking an original asar as base, keeping all its
    original data blobs untouched, appending any new/replacement file contents
    at the end, and rewriting only the header to point at the appended data
    for the modified paths.

    This is the reliable way to patch without risking corruption of the rest of the archive.
    modifications: {"webview/index.html": new_html_bytes, "webview/explodex/explodex-sdk.js": sdk_bytes, ...}
    """
    base_asar = Path(base_asar)
    out_asar = Path(out_asar)

    # Read original
    raw = base_asar.read_bytes()
    prefix = raw[:16]
    u0, u1, u2, orig_jsz = struct.unpack("<IIII", prefix)
    header_json = raw[16:16 + orig_jsz].rstrip(b"\x00")
    header = json.loads(header_json)

    # The original data section starts after the original header
    # We will keep the original data section as prefix of our new data
    # data_base in the original file is 16 + orig_jsz
    orig_data_base = 16 + orig_jsz
    orig_data = raw[orig_data_base:]   # this is the big blob of all original files concatenated
    new_data = bytearray(orig_data)
    append_offset = len(orig_data)     # where we will start appending replacements/new files

    # Work on a copy of the header tree
    # header may be {"files": {...}} or the tree directly
    if "files" in header:
        tree = header  # keep the wrapper
        root = header["files"]
    else:
        tree = {"files": header}
        root = header

    for vpath, content in modifications.items():
        # Ensure path exists in tree
        parent, leaf = _ensure_tree_path(tree, vpath)
        # Append the content
        new_offset = append_offset
        new_data.extend(content)
        append_offset += len(content)

        # Set/replace the leaf entry
        parent["files"][leaf] = {
            "size": len(content),
            "offset": str(new_offset),
        }
        # executable flag not needed for our web files

    # Serialize the (possibly nested under "files") header exactly
    # The tree we mutated already has the shape the original had
    new_header_json = json.dumps(tree, separators=(",", ":")).encode("utf-8")
    new_jsz = len(new_header_json)

    # Write the new asar: prefix + header + (orig_data + appended)
    # Use similar prefix convention as our pack (4th uint32 = json len)
    sizes = (4, new_jsz + 10, new_jsz + 6, new_jsz)

    with open(out_asar, "wb") as f:
        f.write(struct.pack("<IIII", *sizes))
        f.write(new_header_json)
        f.write(new_data)

    print(f"[asar] patched asar written ({len(modifications)} mods, appended at +{len(orig_data)})")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["unpack", "pack"])
    ap.add_argument("src")
    ap.add_argument("dst")
    args = ap.parse_args()
    if args.cmd == "unpack":
        unpack(args.src, args.dst)
    else:
        pack(args.src, args.dst)
