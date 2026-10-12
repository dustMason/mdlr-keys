#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Compiled frontend output is deliberately excluded from version control.
cd "$PROJECT_ROOT/Frontend"
npm ci
npm run check
npm run build
