# AGENTS.md

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
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
- Git safety: `docs/design-docs/git-safety.md`
- Plan lifecycle (non-trivial changes): `docs/PLANS.md`
- Product specs index: `docs/product-specs/index.md`
- Product state snapshot: `docs/product-specs/current-state.md`
- Execution plans: `docs/exec-plans/README.md`

## Non-Negotiables

- Correctness over speed for money, lifecycle, auth, and tenant boundaries.
- Server-side authority for RBAC, tenant scope, and workflow transitions.
- No fake production success-path behavior.
- Shared contracts and shared UI primitives are canonical.
- No float-based money calculations.

## Critical Domain Invariants

Auth, tenant, RBAC:
- Tenant scoping for tenant-owned entities is mandatory.
- RBAC is server-side only (default deny, least privilege).
- Sensitive actions must remain auditable.

Lifecycle and auditability:
- Controlled state transitions only.
- Transition history must remain traceable.

Money and tax:
- Use minor units and explicit currency.
- Financial/tax mutations must be auditable.

Time and integrations:
- Store timestamps in UTC; convert at presentation edges.
- Inbound integration data/webhooks are untrusted and idempotent.

## Documentation Contract

Any change affecting architecture boundaries, lifecycle behavior, money/tax handling,
tenancy/RBAC, or user-visible behavior must update:
- `README.md`
- relevant docs under `docs/`

Docs are part of done.

## Architecture Contract

- Follow `ARCHITECTURE.md` and `docs/governance/architecture-rules.json`.
- Respect module and layer dependency direction.
- Do not bypass CI architecture checks.

## Security and Data Safety

- Treat inbound integration data as untrusted.
- Ensure idempotency for webhook and ingestion handlers.
- Never use floats for money calculations.
- Enforce tenant boundaries and RBAC server-side.

## Git and File Safety

- Canonical policy location: `docs/design-docs/git-safety.md`.
- Never edit `.env` or environment variable files.
- Never run destructive git/file commands without explicit written instruction.

## Test and Validation Expectations

- Add/adjust tests for behavior changes.
- Every bug fix needs a regression test.
- Critical flows require focused coverage.

## If Unsure

Do not guess. Stop, inspect, and apply the safest explicit change.

## Repo-Specific Extensions

- Put repo-specific domain constraints in `docs/product-specs/current-state.md` and domain docs.
