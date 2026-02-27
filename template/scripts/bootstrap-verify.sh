#!/usr/bin/env bash
set -euo pipefail

./scripts/check-template-placeholders.sh
npm run docs:verify
npm run conformance:verify
npm run architecture:verify

echo "[bootstrap-verify] passed"
