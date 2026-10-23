#!/usr/bin/env bash
# No audio device, simulator launch, firmware library, ROM or SRAM inputs.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"
compiler="${CXX:-clang++}"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/mdlr-jp8000-rust-host.XXXXXX")"
source_file="$repo_dir/Tests/JP8000RustHostFixtureTests.cpp"
flags=(-std=c++20 -O2 -g -UNDEBUG -fsanitize=address,undefined)
case "$mode" in
  fixture) [[ $# == 1 ]] || exit 64 ;;
  core|scoped|recovery|benchmark)
    [[ $# == 2 && -f "$2" ]] || { echo "Supply the native Rust static archive." >&2; exit 64; }
    source_file="$repo_dir/Tests/JP8000RustHostCoreTests.cpp"
    if [[ "$mode" == scoped ]]; then source_file="$repo_dir/Tests/JP8000RustHostScopedTests.cpp"; fi
    if [[ "$mode" == recovery ]]; then source_file="$repo_dir/Tests/JP8000RustHostRecoveryTests.cpp"; fi
    archive="$2";archive_sha="$(shasum -a 256 "$archive" | cut -d ' ' -f1)"
    if [[ "$mode" == benchmark ]]; then flags=(-std=c++20 -Os -UNDEBUG);fi
    ;;
  *) echo "Usage: $0 fixture | core RUST_ARCHIVE | scoped RUST_ARCHIVE | recovery RUST_ARCHIVE | benchmark RUST_ARCHIVE" >&2; exit 64 ;;
esac
source_files=("$source_file" "$repo_dir/App/JP8000RustHost.hpp" "$repo_dir/App/JP8000RustABI.h" "$repo_dir/App/JP8000Backend.hpp" "$repo_dir/App/JP8000Host.hpp" "$repo_dir/Tests/run-jp8000-rust-host-tests.sh")
shasum -a 256 "${source_files[@]}" > "$test_dir/source.sha256"
"$compiler" --version > "$test_dir/compiler.txt"
if [[ "$mode" == fixture ]]; then
  "$compiler" "${flags[@]}" -I "$repo_dir/App" -I "$repo_dir/Native/JP8000/include" "$source_file" -o "$test_dir/test"
else
  "$compiler" "${flags[@]}" -I "$repo_dir/App" -I "$repo_dir/Native/JP8000/include" "$source_file" "$archive" -framework CoreFoundation -framework Security -o "$test_dir/test"
fi
if [[ "$mode" == benchmark ]]; then
  "$test_dir/test" --benchmark > "$test_dir/result.json"
else
  "$test_dir/test" > "$test_dir/result.json"
fi
if [[ "$mode" != fixture ]]; then
  [[ "$(shasum -a 256 "$archive" | cut -d ' ' -f1)" == "$archive_sha" ]] || { echo "Archive changed during validation." >&2; exit 1; }
  printf '%s\n' "$archive_sha" > "$test_dir/archive.sha256"
fi
shasum -a 256 "${source_files[@]}" > "$test_dir/source-after.sha256"
cmp "$test_dir/source.sha256" "$test_dir/source-after.sha256"
printf '%s\n' "$test_dir/result.json"
