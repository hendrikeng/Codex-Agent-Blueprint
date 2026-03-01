# AGENTS.md

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document delegates to linked canonical docs.

This file is the agent/human entrypoint map for repository behavior.
If instructions conflict, this file is the behavioral priority entrypoint.

## Operating Model

- Docs-first minimal: this file is a concise map, not an execution playbook.
- Humans define intent, constraints, and acceptance criteria.
- Agents execute scoped tasks using repository-local docs, code, and checks.
- Continuous docs hygiene is required through repository checks.

## Core Map

Start here, then follow linked source-of-truth docs:
- Platform scope/status: `README.md`
- Architecture quick entrypoint: `ARCHITECTURE.md`
- Canonical docs coverage index: `docs/index.md`
- Documentation index: `docs/README.md`
- Governance policy (detailed): `docs/governance/rules.md`
- Golden principles: `docs/governance/golden-principles.md`
- Quality scorecard: `docs/QUALITY_SCORE.md`
- Design docs index: `docs/design-docs/index.md`
- Engineering invariants: `docs/design-docs/engineering-invariants.md`
- UI standards: `docs/design-docs/ui-standards.md`
- Frontend standards: `docs/FRONTEND.md`
- Backend standards: `docs/BACKEND.md`
- Agent hardening policy map: `docs/agent-hardening/README.md`
- Git safety: `docs/design-docs/git-safety.md`
- Plan lifecycle (non-trivial changes): `docs/PLANS.md`
- Product specs index: `docs/product-specs/index.md`
- Product state snapshot: `docs/product-specs/current-state.md`
- Execution plans: `docs/exec-plans/README.md`
- Ops automation conveyor: `docs/ops/automation/README.md`
- Role orchestration contract: `docs/ops/automation/ROLE_ORCHESTRATION.md`

## Non-Negotiables

- Correctness over speed for `{{CRITICAL_DOMAIN_SET}}`.
- Server-side authority for `{{SERVER_AUTHORITY_BOUNDARY_SET}}`.
- No fake production success-path behavior.
- Shared contracts and shared UI primitives are canonical where applicable.
- Agent hardening policy in `docs/agent-hardening/*` is canonical and mandatory.
- `{{MONEY_AND_NUMERIC_RULE}}`

## Critical Domain Invariants

{{DOMAIN_INVARIANT_AREA_1}}:
- {{DOMAIN_INVARIANT_1A}}
- {{DOMAIN_INVARIANT_1B}}

{{DOMAIN_INVARIANT_AREA_2}}:
- {{DOMAIN_INVARIANT_2A}}
- {{DOMAIN_INVARIANT_2B}}

{{DOMAIN_INVARIANT_AREA_3}}:
- {{DOMAIN_INVARIANT_3A}}
- {{DOMAIN_INVARIANT_3B}}

## Documentation Contract

Any change affecting architecture boundaries, critical invariants,
security/compliance domains, or user-visible behavior must update:
- `README.md`
- relevant docs under `docs/`

Docs are part of done.

## Architecture Contract

- Follow `ARCHITECTURE.md` and `docs/governance/architecture-rules.json`.
- Respect module and layer dependency direction.
- Do not bypass CI architecture checks.

## Security and Data Safety

- Treat inbound integration data as untrusted.
- Ensure idempotency/retry safety where external callbacks exist.
- Enforce boundary checks server-side for sensitive operations.

## Git and File Safety

- Canonical policy location: `docs/design-docs/git-safety.md`.
- Never edit `.env` or environment variable files.
- Never run destructive git/file commands without explicit written instruction.
- Do not use `git stash` unless explicitly requested in-thread.
- Do not switch branches or modify git worktrees unless explicitly requested in-thread.

## Test and Validation Expectations

- Run `npm run docs:verify`, `npm run conformance:verify`, `npm run architecture:verify`, `npm run agent:verify`, `npm run eval:verify`, `npm run blueprint:verify`, and `npm run plans:verify` before merge.
- Add/adjust tests for behavior changes.
- Every bug fix needs a regression test.
- Critical flows require focused coverage.
- If required dependencies/tools are missing, install via the repo-defined package manager and rerun the exact command once.

## If Unsure

Do not guess. Stop, inspect, and apply the safest explicit change.

## Repo-Specific Extensions

- Put repo-specific domain constraints in `docs/product-specs/current-state.md` and domain docs.
