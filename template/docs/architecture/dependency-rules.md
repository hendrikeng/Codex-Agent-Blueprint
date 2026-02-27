# Dependency Rules

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document and `docs/governance/architecture-rules.json`.

## Rules

- Enforce module boundaries with explicit dependency constraints.
- Keep dependency direction aligned with architecture layers.
- Preserve tenant, auth, and money-sensitive boundaries server-side.

## Verification

- Run `npm run architecture:verify`.
- Keep rule config synchronized with actual project tags and imports.
