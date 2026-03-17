# {{PRODUCT}}

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document delegates to linked canonical docs.
Current State Date: {{CURRENT_STATE_DATE}}

{{SUMMARY}}

This file is intended to become the adopted repository's root `README.md` after bootstrap.

## Operating Model

- Docs-first minimal: repository-local docs are the system of record.
- `AGENTS.md` is the concise operating map for humans and agents.
- Non-trivial work follows one flat queue: `future -> active -> completed`.
- Codex plan mode creates or updates future slices.
- Orchestrated execution is sequential and bounded: `worker` for low risk, `worker -> reviewer` for medium/high risk.
- Runtime state stays repo-local with one latest checkpoint and one handoff note per unfinished plan.

## Lite Quickstart

Treat `docs/ops/automation/LITE_QUICKSTART.md` as the behavioral reference for how this harness is meant to operate.

Default loop:

1. Plan futures by creating or refining future slices in `docs/future/`.
2. Keep one future file per executable slice and link broader work with `Dependencies`.
3. Set `Status: ready-for-promotion` once the slice is decision-complete.
4. Run `automation:run`, `automation:resume`, or `automation:grind` to promote ready futures and work the queue in sequence.
5. Let low-context sessions hand off cleanly, then validate and close into `docs/exec-plans/completed/`.

Reference: `docs/ops/automation/LITE_QUICKSTART.md`.

## Execution Paths

- `Plan futures`: use Codex plan mode to create or refine future slices in `docs/future/`.
- `Promote when ready`: set `Status: ready-for-promotion` once the slice is executable.
- `Run in sequence`: use `automation:run`, `automation:resume`, or `automation:grind` to promote ready futures and work the active queue.
- `Manual loop`: direct human execution is still valid when the scope is small and the same metadata, verification, and closure rules are preserved.

## Session Safety and Context Continuity

- Default memory posture is repo-local: plans, docs, code, validation output, and evidence are the source of truth.
- Runtime context is rebuilt from canonical docs at `docs/generated/AGENT-RUNTIME-CONTEXT.md`.
- Every execution session must write a structured result payload to `ORCH_RESULT_PATH`.
- Execution sessions also report remaining context so the harness can hand work off before a session gets too close to the edge.
- Resume behavior relies on a single latest checkpoint plus a human-readable handoff note, not on contact packs, stage reuse, or continuity analytics.
- The harness deliberately avoids parallel worktrees, branch workers, and multi-stage planner/explorer runtime loops.

## Machine Contracts

The harness treats machine-readable runtime artifacts as explicit contracts, not informal JSON:

- `harness-manifest.json` in `docs/ops/automation/` tracks downstream template ownership.
- `run-state.json` and `run-events.jsonl` in `docs/ops/automation/` track the sequential queue and append-only event history.
- `docs/ops/automation/runtime/` stores latest per-plan checkpoints and validation artifacts.
- `docs/ops/automation/handoffs/` stores the latest human-readable follow-up note for unfinished work.

If a contract is missing, malformed, or incompatible, the harness should fail closed with a clear error.

## Documentation Navigation

Start with:
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/MANIFEST.md`
- `docs/README.md`
- `docs/PLANS.md`
- `docs/FRONTEND.md`
- `docs/BACKEND.md`
- `docs/agent-hardening/README.md`
- `docs/governance/README.md`
- `docs/product-specs/README.md`
- `docs/product-specs/CURRENT-STATE.md`
- `docs/exec-plans/README.md`
- `docs/ops/automation/README.md`

## Platform Scope Snapshot

- {{SCOPE1}}
- {{SCOPE2}}
- {{SCOPE3}}
- Detailed current behavior is tracked in `docs/product-specs/CURRENT-STATE.md`.

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

- Runtime context build: `npm run context:compile`
- Plan metadata verification: `npm run plans:verify`
- Fast iteration profile: `npm run verify:fast`
- Full merge profile: `npm run verify:full`
- Harness alignment check: `npm run harness:verify` verifies both `package.scripts.fragment.json` and the merged `package.json` operator scripts.
- Canonical policy map: `docs/governance/RULES.md`, `docs/governance/policy-manifest.json`, `docs/ops/automation/README.md`

## When To Run Checks

- During implementation loops: `npm run verify:fast`.
- Before merge: `npm run verify:full`.
- Before a new automated grind: `npm run context:compile` and `npm run plans:verify`.

## Automation Conveyor Commands

- Start a new sequential run: `npm run automation:run -- --max-risk low|medium|high --max-sessions-per-plan N`
- Continue the current run: `npm run automation:resume -- --max-risk low|medium|high --max-sessions-per-plan N`
- Drain the queue in supervised sequential mode: `npm run automation:grind -- --max-risk low|medium|high --max-sessions-per-plan N`
- If you omit `--max-risk`, these commands use the repo's configured `risk.defaultMaxRisk`. The template default is `high`.
- If you omit `--max-sessions-per-plan`, these commands use `executor.maxSessionsPerPlan`. The template default is `12`.
- Plans that stop only because they hit the session cap move to `Status: budget-exhausted`; resume them with a higher `--max-sessions-per-plan`.
- Inspect ready, active, blocked, and completed state: `npm run automation:audit`
- Canonical details live in `docs/ops/automation/README.md`, `docs/ops/automation/ROLE_ORCHESTRATION.md`, and `docs/ops/automation/LITE_QUICKSTART.md`.

## Change Discipline

Changes affecting architecture boundaries, critical invariants,
security/compliance domains, or user-visible behavior must update docs in the same change.
