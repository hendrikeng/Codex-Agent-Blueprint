# {{PRODUCT}}

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document delegates to linked canonical docs.
Current State Date: {{CURRENT_STATE_DATE}}

{{SUMMARY}}

## Operating Model

- Docs-first minimal: repository-local docs are the system of record.
- `AGENTS.md` is the concise map for humans and agents.
- Humans define priorities and constraints; agents execute scoped changes.
- Documentation and verification checks are required before merge.

## Documentation Navigation

Start with:
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/index.md`
- `docs/README.md`
- `docs/PLANS.md`
- `docs/FRONTEND.md`
- `docs/BACKEND.md`
- `docs/agent-hardening/README.md`
- `docs/governance/README.md`
- `docs/product-specs/index.md`
- `docs/product-specs/current-state.md`
- `docs/exec-plans/README.md`
- `docs/ops/automation/README.md`

## Platform Scope Snapshot

- {{SCOPE1}}
- {{SCOPE2}}
- {{SCOPE3}}
- Detailed current behavior is tracked in `docs/product-specs/current-state.md`.

## Architecture At A Glance

- Frontend/runtime stack: {{FRONTEND_STACK}}
- Backend/runtime stack: {{BACKEND_STACK}}
- Data/storage stack: {{DATA_STACK}}
- Shared contracts/primitives strategy: {{SHARED_CONTRACT_STRATEGY}}
- Frontend standards: `docs/FRONTEND.md`
- Backend standards: `docs/BACKEND.md`

## Documentation Layering

- `AGENTS.md`: concise operating map and non-negotiables.
- `README.md`: product-level snapshot and entrypoints.
- `ARCHITECTURE.md` + `docs/architecture/*`: architecture source of truth.
- `docs/FRONTEND.md` and `docs/BACKEND.md`: implementation-side standards.

## Enforcement and Quality Gates

- Docs verification: `npm run docs:verify`
- Conformance scope guardrail: `npm run conformance:verify`
- Architecture boundary checks: `npm run architecture:verify`
- Agent hardening checks: `npm run agent:verify`
- Plan metadata checks: `npm run plans:verify`

## When To Run Checks

- Before merge: `npm run docs:verify`, `npm run conformance:verify`, `npm run architecture:verify`, `npm run agent:verify`, `npm run plans:verify`.
- After changing architecture boundaries: `npm run architecture:verify`.
- After changing eval/observability/tool/memory policy docs: `npm run agent:verify`.

## Automation Conveyor Commands

- Start run: `npm run automation:run -- --mode guarded`
- Resume run: `npm run automation:resume`
- Audit runs: `npm run automation:audit -- --json true`
- Executor is required: pass `--executor "<command>"` on `automation:run`, or set a repo default in `docs/ops/automation/orchestrator.config.json`.

## Change Discipline

Changes affecting architecture boundaries, critical invariants,
security/compliance domains, or user-visible behavior must update docs in the same change.
