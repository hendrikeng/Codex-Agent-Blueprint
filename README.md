# Agent Blueprint

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This directory.

Reusable blueprint for initializing agent-first repositories with standardized docs/governance architecture.

## Includes

- Canonical docs skeleton under `template/docs/`
- Base top-level docs: `template/AGENTS.md`, `template/README.md`, `template/ARCHITECTURE.md`
- Runtime standards docs: `template/docs/FRONTEND.md`, `template/docs/BACKEND.md`
- Governance/conformance/architecture checker scripts under `template/scripts/`
- Governance config and architecture rule schema in `template/docs/governance/`
- Placeholder contract: `template/PLACEHOLDERS.md`

## Required Script Interface

- `docs:verify` -> `node ./scripts/docs/check-governance.mjs`
- `conformance:verify` -> `node ./scripts/check-article-conformance.mjs`
- `architecture:verify` -> `node ./scripts/architecture/check-dependencies.mjs`

## Template Policy

This blueprint is intentionally stack- and domain-agnostic.
Agents must replace all `{{...}}` placeholders before treating a repo as production-ready.

## Bootstrap Steps

1. Copy `template/` contents into a new repository root.
2. Replace placeholders listed in `PLACEHOLDERS.md`.
3. Verify no placeholders remain:
   - `./scripts/check-template-placeholders.sh`
4. Add script entries to repository `package.json`:
   - `docs:verify`
   - `conformance:verify`
   - `architecture:verify`
5. Update `docs/generated/article-conformance.json` evidence paths for the new repository.
6. Run `./scripts/bootstrap-verify.sh` (or run each verify command manually).


## Agent Quickstart (Plan Mode)

Use this when initializing a new repo from the blueprint:

1. Copy `template/` into the target repository.
2. Replace all placeholders from `PLACEHOLDERS.md`.
3. Run `./scripts/check-template-placeholders.sh` until clean.
4. Run `./scripts/bootstrap-verify.sh`.

Suggested prompt for an agent:

```text
Initialize this repository from the Agent Blueprint template.
Replace all placeholders using project-specific values.
Then run ./scripts/check-template-placeholders.sh and ./scripts/bootstrap-verify.sh.
Do not stop until both pass with zero errors.
```
