#!/usr/bin/env bash
# Headless only. Binaries, state files and JSON receipts remain in a new temp folder.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compiler="${CXX:-clang++}"
mode="${1:-}"
if [[ "$mode" == fixture && $# == 1 ]]; then
    test_dir="$(mktemp -d "${TMPDIR:-/tmp}/mdlr-jp8000-host.XXXXXX")"
    "$compiler" -std=c++20 -O2 -g -UNDEBUG -fsanitize=address,undefined \
        -DJP8000_HOST_TEST_IO_DELAY_MS=500 \
        -I "$repo_dir/Native/JP8000/include" \
        "$repo_dir/Tests/JP8000HostFixtureTests.cpp" -o "$test_dir/fixture"
    "$test_dir/fixture" "$test_dir/state" > "$test_dir/result.json"
elif [[ "$mode" == core && $# == 4 ]]; then
    archive="$2"; rom="$3"; baseline_ram="$4"
    for input in "$archive" "$rom" "$baseline_ram"; do
        [[ -f "$input" ]] || { printf 'Missing input: %s\n' "$input" >&2; exit 1; }
    done
    test_dir="$(mktemp -d "${TMPDIR:-/tmp}/mdlr-jp8000-host.XXXXXX")"
    "$compiler" -std=c++20 -O3 -DNDEBUG -DJP8000_HOST_TEST_IO_DELAY_MS=500 \
        -I "$repo_dir/Native/JP8000/include" \
        "$repo_dir/Tests/JP8000HostConcurrentTests.cpp" "$archive" -o "$test_dir/core"
    "$test_dir/core" "$rom" "$baseline_ram" "$test_dir/state" > "$test_dir/result.json"
else
    printf 'Usage: %s fixture\n       %s core ARCHIVE ROM BASELINE_RAM\n' "$0" "$0" >&2
    exit 64
fi
printf '%s\n' "$test_dir/result.json"
