#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "[placeholder-check] rg is required (ripgrep)." >&2
  exit 1
fi

HITS=$(rg --hidden -n "\{\{[A-Z0-9_]+\}\}" . --glob '!PLACEHOLDERS.md' --glob '!node_modules/**' --glob '!.git/**' || true)

if [ -n "$HITS" ]; then
  echo "[placeholder-check] unresolved placeholders found:"
  echo "$HITS"
  echo
  echo "[placeholder-check] hint: this is expected on the raw blueprint template."
  echo "[placeholder-check] run this after copying the template into a new repo and replacing placeholders."
  exit 1
fi

echo "[placeholder-check] passed (no unresolved placeholders)."
