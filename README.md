# Agent Blueprint

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-03-01
Source of Truth: This directory.

Reusable blueprint for initializing agent-first repositories with docs-as-governance, blast-radius control, and evidence-based delivery.

## What This Does

- Provides a production-oriented blueprint for agent-driven software delivery.
- Ships a docs-as-system-of-record structure with enforceable governance and architecture rules.
- Adds optional orchestration, role-specialized execution (`planner`, `explorer`, `worker`, `reviewer`), safety gates, and verification automation.

## What We Are Trying To Achieve

- Replace ad-hoc coding sessions with repeatable, auditable, high-quality execution.
- Keep agent velocity high without sacrificing correctness, safety, or maintainability.
- Make execution quality demonstrable through policy checks, evidence trails, and metrics.

## Benefits

- Faster delivery loops via `verify:fast` + compact runtime context.
- Stronger reliability via `verify:full`, risk-tier routing, and approval gates.
- Session continuity by design: proactive context rollover + structured handoffs between isolated runs.
- Reduced content rot: canonical docs stay aligned with behavior through required checks and policy manifests.
- Better handoff and team alignment via canonical docs, plan metadata, and evidence indexes.
- Clearer operational posture: practical structure for correctness and rollback instead of prompt improvisation.

## Adoption Lanes

Use the least process that still protects correctness.

1. `Lite`: manual plan loop (`active -> completed`) + `verify:fast` / `verify:full`.
2. `Guarded`: orchestrator sequential execution with risk/approval gates.
3. `Conveyor`: parallel/worktree execution with branch/PR automation.

## Lite-First Onboarding

Start with `Lite` by default, then scale up only when risk or workload demands it.

1. Keep work in `docs/exec-plans/active/`.
2. Run `verify:fast` during implementation.
3. Run `verify:full` before completion.
4. Use `Guarded`/`Conveyor` only for higher-risk or dependency-heavy slices.

## Session Safety and Context Continuity

- Sessions are proactively rolled over before context gets too low (`contextRemaining <= threshold`).
- Every session must write a structured result payload (`ORCH_RESULT_PATH`) including numeric `contextRemaining`.
- Handoffs are written to disk and reused by the next session, so continuation is explicit and auditable.
- Runtime context is recompiled from canonical docs (`docs/generated/agent-runtime-context.md`) to reduce drift and hallucination risk.

## How It Works

- Governance as working manual:
  - `AGENTS.md`, architecture docs, and governance rules define constraints and expectations.
  - The repository itself is the operating manual for humans and agents.
- Role-specialized execution:
  - Risk-adaptive role routing runs focused stages (`planner`, `explorer`, `worker`, `reviewer`) instead of one generic agent loop.
  - Each role runs in an isolated session with explicit handoff metadata.
- Two execution paths:
  - Fast manual path for short tasks and direct coding loops at inference speed.
  - Futures path for larger work: define in `docs/future`, promote to active plans, optionally execute with orchestration, and complete with closure/evidence.
- Evidence-first delivery:
  - Non-trivial work leaves clear metadata, validation traces, and done-evidence references.
  - Team members can inspect progress, decisions, and status directly in-repo.

## Daily Workflow

1. Start in plan mode and lock decisions: app scope, stack/runtime/tooling, invariants, and first acceptance slices.
2. Define futures and active plans: strategic work goes through `future -> active -> completed`; quick/manual work can run `active -> completed`.
3. Execute and close: run manual or orchestrated loops, use `verify:fast` during implementation, run `verify:full` before completion/merge, and keep docs plus `Done-Evidence` current.

## Why This Model Works

- It keeps inference-speed execution while staying structured.
- It supports both rapid delivery and strategic multi-plan execution.
- It is team-grade: auditable, reviewable, and handoff-ready by default.

## Core Commands

- `context:compile`, `verify:fast`, `verify:full`
- `automation:run`, `automation:run:parallel`, `automation:resume`, `automation:resume:parallel`, `automation:audit`
- `perf:baseline`, `perf:after`
- `outcomes:report`, `interop:github:export`, `interop:github:export:write`

Canonical command contracts and policies:
- `template/docs/ops/automation/README.md`
- `template/docs/ops/automation/LITE_QUICKSTART.md`
- `template/docs/ops/automation/OUTCOMES.md`
- `template/docs/ops/automation/INTEROP_GITHUB.md`
- `template/docs/ops/automation/PROVIDER_COMPATIBILITY.md`
- `template/docs/governance/rules.md`
- `template/docs/governance/policy-manifest.json`
- `template/docs/PLANS.md`
- `template/PLACEHOLDERS.md`

## Bootstrap Steps

1. Copy `template/` contents into a new repository root.
2. Replace placeholders from `PLACEHOLDERS.md`.
3. Add required scripts to `package.json` (`context:compile`, `verify:fast`, `verify:full`, automation commands).
4. Run `./scripts/check-template-placeholders.sh`.
5. Run `./scripts/bootstrap-verify.sh`.


## Agent Quickstart (Plan Mode)

Use this when initializing a new repo from the blueprint:

1. Create a new repository using this GitHub template.
2. Enter the repository from CLI (`cd <new-repo>`).
3. Start the agent in plan mode and define the app before any file edits.
4. Lock decisions for product scope, first features, stack/runtime, and core invariants.
5. After decisions are approved, execute bootstrap: copy `template/` into repo root, replace placeholders from `PLACEHOLDERS.md`, and wire required scripts.
6. Seed strategic work in `docs/future/`; track quick/manual fixes directly in `docs/exec-plans/active/`.
7. Run `./scripts/check-template-placeholders.sh` until clean.
8. Run `./scripts/bootstrap-verify.sh`.

Use two prompts in sequence.

Prompt 1 (planning kickoff, before any file copy):

```text
We are starting a new app from this Agent Blueprint repository template.
Stay in plan mode and do not edit files yet.
Help me decide and lock:
1) what the app does and who it serves,
2) which stack/runtime/tooling we will use,
3) core invariants and non-negotiables,
4) first implementation slices and acceptance criteria,
5) initial futures backlog with dependencies/risk tiers.
Output a decision-complete implementation plan I can approve.
```

Prompt 2 (bootstrap + execution handoff, after planning approval):

```text
Approved. Execute bootstrap now:
1) copy template files into repository root,
2) replace placeholders from PLACEHOLDERS.md,
3) wire required package scripts,
4) seed strategic plans in docs/future and quick fixes in docs/exec-plans/active as appropriate,
5) run ./scripts/check-template-placeholders.sh,
6) run ./scripts/bootstrap-verify.sh.
Then start execution using automation:run (or automation:run:parallel when dependencies allow).
Keep docs, metadata, and Done-Evidence updated as work progresses.
```
