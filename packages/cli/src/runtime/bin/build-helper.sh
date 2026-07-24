#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
source_file="$script_dir/explodex-runtime-helper.c"
output_file="$script_dir/explodex-runtime-helper"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/explodex-runtime-helper.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

xcrun clang -arch arm64 -mmacosx-version-min=13.0 -Os "$source_file" -o "$build_dir/helper-arm64"
xcrun clang -arch x86_64 -mmacosx-version-min=13.0 -Os "$source_file" -o "$build_dir/helper-x86_64"
lipo -create "$build_dir/helper-arm64" "$build_dir/helper-x86_64" -output "$build_dir/helper-universal"
chmod 0755 "$build_dir/helper-universal"
mv "$build_dir/helper-universal" "$output_file"
