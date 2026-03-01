# Agent Blueprint

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-28
Source of Truth: This directory.

Reusable blueprint for initializing agent-first repositories with standardized docs/governance architecture.

## What This Does

- Provides a production-oriented blueprint for agent-driven software delivery.
- Ships a docs-as-system-of-record structure with enforceable governance and architecture rules.
- Adds orchestration, risk-adaptive role routing, safety gates, and verification automation.

## What We Are Trying To Achieve

- Replace ad-hoc coding sessions with repeatable, auditable, high-quality execution.
- Keep agent velocity high without sacrificing correctness, safety, or maintainability.
- Make execution quality demonstrable through policy checks, evidence trails, and metrics.

## Benefits

- Faster delivery loops via `verify:fast` + compact runtime context.
- Stronger reliability via `verify:full`, risk-tier routing, and approval gates.
- Better handoff and team alignment via canonical docs, plan metadata, and evidence indexes.
- Clearer showcase value: structured, state-of-the-art workflow instead of prompt improvisation.

## How It Works

- Governance as working manual:
  - `AGENTS.md`, architecture docs, and governance rules define constraints and expectations.
  - The repository itself is the operating manual for humans and agents.
- Two execution paths:
  - Fast manual path for short tasks and direct coding loops at inference speed.
  - Futures path for larger work: define in `docs/future`, promote to active plans, execute with orchestration, and complete with closure/evidence.
- Evidence-first delivery:
  - Non-trivial work leaves clear metadata, validation traces, and done-evidence references.
  - Team members can inspect progress, decisions, and status directly in-repo.

## Daily Workflow

1. Bootstrap correctly:
   - Start with the Agent Quickstart prompt in plan mode.
   - Initialize docs/scripts from the blueprint only after planning decisions are approved.
   - Treat the repository docs as the operating manual from day one.
2. Lock intent and stack:
   - Decide product scope, first slices, stack/runtime/tooling, and core invariants.
   - Record those decisions before execution so implementation stays aligned.
3. Route work by size/risk:
   - Quick/manual change: create/update a plan in `docs/exec-plans/active/`.
   - Strategic/multi-slice work: define futures in `docs/future/` and mark ready plans for promotion.
4. Execute with the right engine:
   - Manual loop: implement focused slices + run `verify:fast` continuously.
   - Orchestrated loop: `automation:run` for sequential flow, `automation:run:parallel` for dependency-aware parallel execution.
   - Continue unfinished runs with `automation:resume` or `automation:resume:parallel`.
5. Close with evidence and governance:
   - Run `verify:full` before merge/completion.
   - Move finished plans to `docs/exec-plans/completed/` with canonical `Done-Evidence`.
   - Keep docs/metadata current in the same change so team visibility stays intact.

## Why This Model Works

- It keeps inference-speed execution while staying structured.
- It supports both rapid delivery and strategic multi-plan execution.
- It is team-grade: auditable, reviewable, and handoff-ready by default.

## Includes

- Canonical docs skeleton under `template/docs/`
- Canonical agent hardening docs under `template/docs/agent-hardening/`
- Base top-level docs: `template/AGENTS.md`, `template/README.md`, `template/ARCHITECTURE.md`
- Runtime standards docs: `template/docs/FRONTEND.md`, `template/docs/BACKEND.md`
- Governance/conformance/architecture checker scripts under `template/scripts/`
- Agent hardening checker script under `template/scripts/agent-hardening/`
- Plan metadata validator and execution orchestrator under `template/scripts/automation/`
- Risk-adaptive role orchestration contract and provider adapters under `template/docs/ops/automation/`
- Governance config, policy manifest/schema, and architecture rule schema in `template/docs/governance/`
- Compiled runtime context and performance comparison artifacts under `template/docs/generated/`
- Placeholder contract: `template/PLACEHOLDERS.md`

## Required Script Interface

Primary workflow commands (day-to-day):
- `context:compile` -> `node ./scripts/automation/compile-runtime-context.mjs`
- `verify:fast` -> `node ./scripts/automation/verify-fast.mjs`
- `verify:full` -> `node ./scripts/automation/verify-full.mjs`
- `perf:baseline` -> `node ./scripts/automation/collect-performance-baseline.mjs --stage baseline`
- `perf:after` -> `node ./scripts/automation/collect-performance-baseline.mjs --stage after`

Underlying check primitives (used by `verify:fast` / `verify:full`, also available for targeted debugging):
- `docs:verify` -> `node ./scripts/docs/check-governance.mjs`
- `conformance:verify` -> `node ./scripts/check-article-conformance.mjs`
- `architecture:verify` -> `node ./scripts/architecture/check-dependencies.mjs`
- `agent:verify` -> `node ./scripts/agent-hardening/check-agent-hardening.mjs`
- `eval:verify` -> `node ./scripts/agent-hardening/check-evals.mjs`
- `blueprint:verify` -> `node ./scripts/automation/check-blueprint-alignment.mjs`
- `plans:verify` -> `node ./scripts/automation/check-plan-metadata.mjs`

## Automation Commands

- `automation:run` -> `node ./scripts/automation/orchestrator.mjs run`
  - Continues active queue first, then promotes ready futures, executing sequentially.
- `automation:run:parallel` -> `node ./scripts/automation/orchestrator.mjs run-parallel`
  - Executes dependency-ready plans in isolated worktrees/branches in parallel.
- `automation:resume` -> `node ./scripts/automation/orchestrator.mjs resume`
  - Resumes the persisted sequential run-state and continues pending work.
- `automation:resume:parallel` -> `node ./scripts/automation/orchestrator.mjs run-parallel`
  - Convenience alias to resume parallel processing by re-invoking `run-parallel`.
- `automation:audit` -> `node ./scripts/automation/orchestrator.mjs audit`
  - Summarizes historical run events and outcomes for operational review.
- Executor is required and loaded from `docs/ops/automation/orchestrator.config.json` (`executor.command`).
- Role routing is risk-adaptive (`low: worker`, `medium: planner->worker->reviewer`, `high: planner->explorer->worker->reviewer`) with Security-Approval gates for high/sensitive plans.
- Safe stage-reuse can skip repeated planner/explorer stages when plan shape and scope are unchanged.
- Role stages are isolated executor sessions; role commands should include `{role_model}` to enforce model switching.
- Orchestrator defaults to interactive pretty console output with raw session logs written under `docs/ops/automation/runtime/<run-id>/` (`--output ticker` for ultra-compact mode).
- Pretty mode includes a single in-place heartbeat/status line for active phases (session/validation/host validation) with elapsed/idle timing.
- `guarded` mode is non-interactive and env-gated (`ORCH_APPROVED_MEDIUM=1`, `ORCH_APPROVED_HIGH=1`); quick command matrix is in `template/docs/ops/automation/README.md`.

## When To Run Checks

- Use fast iteration checks while implementing: `verify:fast`.
- Run full gate before merge: `verify:full`.
- Capture baseline/after optimization metrics: `perf:baseline`, `perf:after`.
- Run `agent:verify` when changing eval policy, agent observability, tool-safety, or memory/context rules.
- Run `architecture:verify` when changing dependency boundaries.

## Template Policy

This blueprint is intentionally stack- and domain-agnostic.
Agents must replace all `{{...}}` placeholders before treating a repo as production-ready.

## State-of-the-Art Workflow

Use a dual-track lifecycle for implemented work:

1. Strategic/non-trivial work: `future -> active -> completed`.
2. Quick/manual fixes: `active -> completed` (no prior `future` blueprint required).
3. In both tracks, `active` plans must keep metadata/status current and evidence curated.
4. Completed plans must keep concise closure plus canonical `Done-Evidence` index references.

Orchestration is the default execution driver. Manual execution is valid only when it follows the same metadata, status, and evidence-index contract.

## Bootstrap Steps

1. Copy `template/` contents into a new repository root.
2. Replace placeholders listed in `PLACEHOLDERS.md`.
3. Verify no placeholders remain:
   - `./scripts/check-template-placeholders.sh`
4. Add script entries to repository `package.json` from **Required Script Interface**.
5. Update `docs/generated/article-conformance.json` evidence paths for the new repository.
6. Run `./scripts/bootstrap-verify.sh` (or run each verify command manually).


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
