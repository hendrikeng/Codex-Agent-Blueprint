# Codex Agent Blueprint

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This directory.

Reusable blueprint for initializing agent-first repositories with standardized docs/governance architecture.

## Includes

- Canonical docs skeleton under `template/docs/`
- Base top-level docs: `template/AGENTS.md`, `template/README.md`, `template/ARCHITECTURE.md`
- Governance/conformance/architecture checker scripts under `template/scripts/`
- Governance config and architecture rule schema in `template/docs/governance/`

## Required Script Interface

- `docs:verify` -> `node ./scripts/docs/check-governance.mjs`
- `conformance:verify` -> `node ./scripts/check-article-conformance.mjs`
- `architecture:verify` -> `node ./scripts/architecture/check-dependencies.mjs`

## Extension Points

- `{{PRODUCT}}` in `template/README.md`
- `{{SUMMARY}}` and `{{SCOPE*}}` in product snapshot sections
- Repo-specific domain invariants in `template/AGENTS.md`
- Repo-specific architecture constraints in `template/docs/governance/architecture-rules.json`

## Bootstrap Steps

1. Copy `template/` contents into a new repository root.
2. Replace placeholder tokens in `template/README.md` and `template/docs/product-specs/current-state.md`.
3. Add script entries to repository `package.json`:
   - `docs:verify`
   - `conformance:verify`
   - `architecture:verify`
4. Update `docs/generated/article-conformance.json` evidence paths for the new repository.
5. Run `npm run docs:verify && npm run conformance:verify && npm run architecture:verify`.
