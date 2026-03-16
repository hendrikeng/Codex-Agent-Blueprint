#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

./scripts/check-template-placeholders.sh
npm run context:compile
npm run verify:fast
npm run verify:full

echo "[bootstrap-verify] passed"
