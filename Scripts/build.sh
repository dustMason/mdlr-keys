#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
case "${1:-ipad}" in
    ipad) SDK=iphoneos ;;
    simulator) SDK=iphonesimulator ;;
    mac) SDK=macosx ;;
    *) echo 'Usage: Scripts/build.sh [ipad|simulator|mac]' >&2; exit 1 ;;
esac
bash "$PROJECT_ROOT/Scripts/prepare-assets.sh"
# Target builds can compile against an installed SDK without a simulator runtime.
xcodebuild -project MDLR.xcodeproj -target MDLR -configuration Release -sdk "$SDK" SYMROOT="$PROJECT_ROOT/Build/Products" OBJROOT="$PROJECT_ROOT/Build/Intermediates" CODE_SIGNING_ALLOWED=NO build
