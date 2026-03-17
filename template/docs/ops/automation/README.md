# Automation Conveyor

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

This directory defines the planning-to-execution conveyor for bounded automation runs.

Treat `docs/ops/automation/LITE_QUICKSTART.md` as the simplest explanation of how this conveyor is meant to be used in practice.

## Goals

- Promote ready future slices into executable active plans.
- Continue existing active work before promoting more futures.
- Execute one sequential queue with bounded resumability and explicit risk gates.
- Force clean handoffs before a session burns through its remaining context budget.
- Record structured run traces for auditability.
- Move completed plans into `docs/exec-plans/completed/` with evidence.
- Keep the harness predictable: no program parents, no child compilation, no parallel worktrees, no contact packs.

## Runtime Files

- `docs/ops/automation/orchestrator.config.json`: executor and validation command configuration.
- `run-state.json` in `docs/ops/automation/`: latest resumable queue and plan progress snapshot.
- `docs/ops/automation/run-events.jsonl`: append-only JSON line event log.
- `docs/ops/automation/runtime/`: latest checkpoint, validation artifacts, and session payloads.
- `docs/ops/automation/handoffs/`: latest human-readable follow-up note per unfinished plan.
- `docs/exec-plans/evidence-index/`: canonical compact evidence indexes by plan ID.

## Queue Model

- `docs/future/`: proposed upcoming work not yet executing.
- `docs/exec-plans/active/`: current execution state and in-progress work.
- `docs/exec-plans/completed/`: completed execution plans and closure records.
- One file equals one executable slice. The harness does not compile or generate child plans.
- Larger initiatives are represented as multiple future files linked by `Dependencies`.

## Source Of Truth

- `docs/exec-plans/evidence-index/`: canonical compact evidence references by plan ID.
- `docs/product-specs/CURRENT-STATE.md`: product-facing delivery timeline via `Automated Delivery Log`.
- `## Must-Land Checklist` inside each plan is the executable completion contract.
- `Delivery-Class`, `Dependencies`, `Implementation-Targets`, `Risk-Tier`, and `Validation-Lanes` make execution boundaries explicit.

## Runtime Roles

- `planner`: planning-time only. Used in direct Codex planning sessions, not in the overnight grind.
- `explorer`: planning-time only. Used for focused investigation before implementation when needed.
- `worker`: runtime executor for code and doc changes.
- `reviewer`: runtime gate for medium/high-risk plans before validation and closeout.

## Risk Routing

- `low`: `worker`
- `medium`: `worker -> reviewer`
- `high`: `worker -> reviewer`, plus explicit `Security-Approval`
- Risk is explicit from plan metadata. The harness does not derive hidden risk scores from tags, paths, or generated child graphs.

## CLI

- `npm run automation:run -- --max-risk low|medium|high --max-sessions-per-plan N`
- `npm run automation:resume -- --max-risk low|medium|high --max-sessions-per-plan N`
- `npm run automation:grind -- --max-risk low|medium|high --max-sessions-per-plan N`
- `npm run automation:audit`
- The package scripts use the repo's configured `risk.defaultMaxRisk` when `--max-risk` is omitted. The template default is `high`.
- `--max-sessions-per-plan N` overrides `executor.maxSessionsPerPlan`. The template default is `12`.
- `--commit true|false` controls whether the harness creates one atomic git commit per completed slice. Default is `true`.
- `--output minimal|ticker|pretty|verbose` controls operator-facing console output. Default is `pretty`.

## Executor Configuration

- `executor.command` in `docs/ops/automation/orchestrator.config.json` is required for `run`, `resume`, and `grind`.
- `executor.roles.worker` defines the implementation profile.
- `executor.roles.reviewer` defines the review profile.
- `executor.maxSessionsPerPlan` defines the default per-plan worker/reviewer session budget before the run pauses that plan as `budget-exhausted`.
- `executor.contextBudget.minRemaining` defines the low-watermark token threshold for forced handoff.
- `executor.contextBudget.minRemainingPercent` defines the low-watermark ratio when the provider can report total context window.
- Provider commands must be non-interactive and must honor `ORCH_RESULT_PATH`.
- `validation.always` and `validation.hostRequired` define the completion gates.
- `runtimeContextPath` should point at `docs/generated/AGENT-RUNTIME-CONTEXT.md`.
- `logging.output`, `logging.failureTailLines`, `logging.heartbeatSeconds`, and `logging.stallWarnSeconds` tune grind readability and liveness signaling.
- `git.atomicCommits` controls whether completed slices are committed before the queue advances.

## Context Budget Discipline

- Every worker/reviewer session must report `contextRemaining`.
- Providers should also report `contextWindow` when available so percent-based thresholds work.
- If a session returns near the low-context threshold and the current role boundary is not safely complete, the runtime forces a handoff instead of pretending the session finished cleanly.
- The handoff note and latest checkpoint are the canonical packet for the next fresh agent.
- If the current run reaches its per-plan session cap before another worker/reviewer pass can start, the plan moves to `Status: budget-exhausted` instead of `blocked`.
- Resume a `budget-exhausted` plan by rerunning `automation:resume` with a higher `--max-sessions-per-plan`.
- `run`, `resume`, and `grind` now take a repo-local runtime lock in `docs/ops/automation/runtime/orchestrator.lock.json`; if another orchestrator process is already active, the second start fails fast with a clear message instead of racing the active plan files.

## Operator Output

- `pretty` output is the default. It keeps color-capable lifecycle lines plus one live heartbeat line while a session or validation command is running.
- `ticker` output emits compact timestamped lifecycle events without the live in-place line.
- `minimal` output keeps only the high-signal lifecycle lines.
- `verbose` streams raw executor and validation command output in addition to orchestrator lifecycle lines.
- Failure paths print a bounded tail from the relevant command log so blocked runs are easier to diagnose without opening files first.

## Atomic Commits

- The default queue behavior is one atomic git commit per completed slice.
- A plan may narrow or extend its commit boundary through metadata `Atomic-Roots` when the default `Implementation-Targets` and plan-doc files are not enough.
- The atomic commit guard also allows files the current slice actually touched during worker, reviewer, or validation sessions, so same-slice regression tests and adjacent proof updates are not misclassified as unrelated drift.
- If unrelated dirty files fall outside the current slice's commit roots, the harness stops instead of silently sweeping them into the same commit.
- Disable commits explicitly with `--commit false` only when you are doing manual recovery or intentionally running on a dirty worktree.

## Verification Profiles

- Fast iteration profile: `npm run verify:fast`
  - Runs runtime-context compilation, docs governance, plan metadata verification, and harness alignment checks.
  - Accepts `ORCH_PLAN_ID` so plan-scoped automation runs can verify only the current plan when needed.
- Full merge profile: `npm run verify:full`
  - Includes `verify:fast` plus broader repository checks required before merge.

## Removed Complexity

- No `Execution-Scope: program`
- No `Authoring-Intent`
- No child-slice generation or compilation
- No contact packs or continuity analytics
- No stage reuse or planner/explorer runtime stages
- No parallel worktrees or branch workers

## Related Documents

- Lite lane onboarding: `docs/ops/automation/LITE_QUICKSTART.md`
- Runtime role contract: `docs/ops/automation/ROLE_ORCHESTRATION.md`
- Outcome scorecard and interpretation: `docs/ops/automation/OUTCOMES.md`
- GitHub-native mapping: `docs/ops/automation/INTEROP_GITHUB.md`
- Provider command contract: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`
