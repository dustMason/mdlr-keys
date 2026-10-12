#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
case "${PLATFORM_NAME:-macosx}" in
    iphoneos) RUST_TARGET=aarch64-apple-ios ;;
    iphonesimulator) RUST_TARGET=aarch64-apple-ios-sim ;;
    macosx) RUST_TARGET=aarch64-apple-darwin ;;
    *) echo "Unsupported platform: ${PLATFORM_NAME}" >&2; exit 1 ;;
esac
export CARGO_TARGET_DIR="${DERIVED_FILE_DIR:-$PROJECT_ROOT/Build}/rust-target"
export IPHONEOS_DEPLOYMENT_TARGET=16.0
export MACOSX_DEPLOYMENT_TARGET=13.0
cargo build --locked --release --target "$RUST_TARGET" --manifest-path "$PROJECT_ROOT/Rust/Cargo.toml"
mkdir -p "${BUILT_PRODUCTS_DIR:-$PROJECT_ROOT/Build}"
cp "$CARGO_TARGET_DIR/$RUST_TARGET/release/libmdlr_ipad_dsp.a" "${BUILT_PRODUCTS_DIR:-$PROJECT_ROOT/Build}/libmdlr_ipad_dsp.a"
