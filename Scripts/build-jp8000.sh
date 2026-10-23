#!/bin/sh
set -eu
if [ "${MDLR_JP8000_RUST_ONLY:-0}" = 1 ]; then
    # Only generated app resources are removed when switching an existing build.
    # Private inputs and the vendored emulator tree are never touched.
    if [ -n "${TARGET_BUILD_DIR:-}" ] && [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
        JP_OUTPUT="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/JP8000"
        rm -f "$JP_OUTPUT/jp8000_v1.05.bin" "$JP_OUTPUT/ram_dump.bin"
    fi
    echo "JP-8000: Rust-only build; firmware compilation and resource copy disabled"
    exit 0
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec python3 "$ROOT/Native/JP8000/tools/build.py"
