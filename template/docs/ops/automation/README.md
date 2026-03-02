# Automation Conveyor

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

This directory defines the optional planning-to-execution conveyor for bounded automation runs.

## Goals

- Promote ready future blueprints into executable plans.
- Promotion moves the blueprint file from `docs/future/` into `docs/exec-plans/active/`.
- Run order: continue existing active queue first, then promote ready future blueprints.
- Execute plans in repeated isolated sessions until done (bounded by session limits), with resumable handoffs.
- Record structured run traces for auditability.
- Move completed plans into `docs/exec-plans/completed/` with evidence.
- Update product state docs after completion.
- Keep blast radius explicit through risk routing, approvals, and isolated stage sessions.

## Adoption Lanes

Pick the smallest lane that still protects correctness and rollback:

1. `Lite`: manual execution with plan metadata discipline and canonical evidence/index references.
2. `Guarded`: sequential orchestration with risk routing + approval gates.
3. `Conveyor`: parallel/worktree orchestration and optional branch/PR automation.

Quick start for `Lite`: `docs/ops/automation/LITE_QUICKSTART.md`.

## Runtime Files

- `docs/ops/automation/orchestrator.config.json`: executor and validation command configuration.
- `run-state.json` (under `docs/ops/automation/`): latest resumable queue and plan progress snapshot.
- `run-events.jsonl` (under `docs/ops/automation/`): append-only JSON line event log.
- `docs/exec-plans/evidence-index/`: canonical compact evidence indexes by plan ID.
- `run-state.json`, `run-events.jsonl`, `runtime/`, and `handoffs/` are transient runtime artifacts; they are ignored by dirty preflight.
- `docs/ops/automation/handoffs/`: per-plan rollover handoff notes.
- `docs/ops/automation/runtime/`: per-run executor result payloads and the transient active-run lock file (`orchestrator.lock.json`).

## Source Of Truth

- `docs/future/`: proposed upcoming work not yet executing.
- `docs/exec-plans/active/`: current execution state and in-progress work.
- `docs/exec-plans/completed/`: completed execution plans and closure records.
- `docs/exec-plans/evidence-index/`: canonical compact evidence references by plan ID.
- `docs/product-specs/current-state.md`: product-facing delivery timeline via `Automated Delivery Log`.

## Orchestrated vs Manual Execution

- Orchestration is the canonical default for non-trivial plan execution.
- Manual execution is allowed with the same metadata/status rules and curated evidence/index behavior.
- Lifecycle is dual-track: strategic/non-trivial work follows `future -> active -> completed`, while quick/manual fixes may run `active -> completed`.
- This keeps completion records, evidence references, and rerun behavior consistent regardless of execution driver.

## When Not To Use Orchestration

Use the manual path when any of these are true:

- The change is low-risk, isolated, and fits a single focused session.
- The task is exploratory and requirements are still shifting rapidly.
- The overhead of queue promotion and staged execution outweighs risk reduction.

## CLI

- `node ./scripts/automation/orchestrator.mjs run --mode guarded`
- `node ./scripts/automation/orchestrator.mjs run-parallel --mode guarded --parallel-plans 4`
- `node ./scripts/automation/orchestrator.mjs resume`
- `node ./scripts/automation/orchestrator.mjs audit --json true`
- `node ./scripts/automation/orchestrator.mjs curate-evidence [--scope active|completed|all] [--plan-id <value>]`
- Optional continuation controls:
  - `--max-sessions-per-plan <n>` (default `20`)
  - `--max-rollovers <n>` (default `20`)
- Output controls:
  - `--output minimal|ticker|pretty|verbose` (default `pretty`)
  - `--failure-tail-lines <n>` (default `60`)
  - `--heartbeat-seconds <n>` (default `12`)
  - `--stall-warn-seconds <n>` (default `120`)
- Recovery controls:
  - `--retry-failed true|false` (default `true`)
  - `--auto-unblock true|false` (default `true`)
  - `--max-failed-retries <n>` (default `3`)
- Parallel controls:
  - `--parallel-plans <n>` enables dependency-aware parallel branch/worktree execution.

## Executor Configuration

- `executor.command` in `docs/ops/automation/orchestrator.config.json` is required for `run`/`resume`.
- Set this once per repository; default is the portable `executor-wrapper` entrypoint.
- If empty, `run`/`resume` fail immediately with a clear error.
- Example (`orchestrator.config.json`):
  - `"command": "node ./scripts/automation/executor-wrapper.mjs --plan-id {plan_id} --plan-file {plan_file} --run-id {run_id} --mode {mode} --session {session} --role {role} --effective-risk-tier {effective_risk_tier} --declared-risk-tier {declared_risk_tier} --stage-index {stage_index} --stage-total {stage_total} --result-path {result_path}"`
  - `"provider": "codex"` (override per run with `ORCH_EXECUTOR_PROVIDER=...`)
  - `"providers.codex.command": "codex exec --full-auto -m {role_model} {prompt}"` (`{prompt}` and `{role_model}` are required)
  - `"providers.claude.command": "claude -p --model {role_model} {prompt}"` (`{prompt}` and `{role_model}` are required)
  - `"enforceRoleModelSelection": true` requires each role command to include `{role_model}`.
  - `"contextThreshold": 10000`
  - `"requireResultPayload": true`
  - `"context.runtimeContextPath"` points to compiled runtime instructions (`docs/generated/agent-runtime-context.md` by default).
  - `"context.maxTokens"` sets a hard budget for compiled runtime context size.
  - `"logging.output": "pretty"` (`minimal` | `ticker` | `pretty` | `verbose`), `"logging.failureTailLines": 60`, `"logging.heartbeatSeconds": 12`, and `"logging.stallWarnSeconds": 120` tune operator-facing output noise and liveness signaling.
  - `"recovery.retryFailed": true`, `"recovery.autoUnblock": true`, and `"recovery.maxFailedRetries": 3` control automatic retry/unblock behavior for resumable plans.
  - `"parallel.maxPlans"` sets default worker concurrency for `run --parallel-plans`.
  - `"parallel.worktreeRoot"`, `"parallel.branchPrefix"`, `"parallel.baseRef"`, `"parallel.gitRemote"` configure branch/worktree strategy.
  - `"parallel.pushBranches": true` pushes worker branches automatically.
  - `"parallel.openPullRequests": true` with `"parallel.pullRequest.createCommand"` can open PRs per completed worker branch.
  - `"parallel.pullRequest.mergeCommand"` can enqueue or merge generated PRs after creation (for merge queues).
  - `pullRequest.createCommand` token support: `{plan_id}`, `{branch}`, `{base_ref}`, `{git_remote}`, `{run_id}`, `{head_sha}`, `{worktree}`.
  - `executor.promptTemplate` is provider-agnostic and reused across Codex and Claude Code adapters.
- Role orchestration:
  - `roleOrchestration.enabled: true` enables risk-adaptive role routing.
  - `roleOrchestration.roleProfiles` defines per-role execution profiles (`model`, `reasoningEffort`, `sandboxMode`, `instructions`).
  - Default profile policy:
    - `explorer`: fast model (`gpt-5.3-codex-spark`), `medium`, `read-only`
    - `reviewer`: high reasoning, `read-only`
    - `planner`: high reasoning, `read-only`
    - `worker`: high reasoning, `full-access`
  - `roleOrchestration.pipelines.low` defaults to `worker`.
  - `roleOrchestration.pipelines.medium` defaults to `planner -> worker -> reviewer`.
  - `roleOrchestration.pipelines.high` defaults to `planner -> explorer -> worker -> reviewer`.
  - `roleOrchestration.stageReuse` allows safe skip of previously completed planner/explorer stages when plan shape and scope remain stable.
  - `roleOrchestration.riskModel` computes an effective risk tier from declared risk, dependencies, tags, scope paths, and prior validation failures.
  - `roleOrchestration.approvalGates` enforces Security Ops approval for high-risk completions and sensitive medium-risk completions.
  - `roleOrchestration.providers.<provider>.roles.<role>.command` can override provider command templates by role.
  - Role command templates can use profile placeholders:
    - `{role_model}`
    - `{role_reasoning_effort}`
    - `{role_sandbox_mode}`
    - `{role_instructions}`
  - Each role stage runs as a fresh executor process/session. For strict model switching, include `{role_model}` in every role command template.
  - Detailed role contract: `docs/ops/automation/ROLE_ORCHESTRATION.md`.
- Validation lanes:
  - `validation.always`: sandbox-safe checks that should run in every completion gate.
  - `validation.requireAlwaysCommands: true` enforces fail-closed behavior when `validation.always` is empty.
  - `validation.always` should include a unit/integration test command (framework-appropriate).
  - `validation.hostRequired`: Docker/port/browser checks required before completion.
  - `validation.requireHostRequiredCommands: true` enforces fail-closed behavior when `validation.hostRequired` is empty.
  - `validation.hostRequired` should include infra/bootstrap commands plus host-dependent E2E/system tests.
  - Executors should not run `validation.hostRequired` commands inline; completion gating runs them via host validation providers (`ci`/`local`).
  - `validation.hostRequired` must be set per repository for DB/search/browser-dependent plans.
  - `alwaysExamples` and `hostRequiredExamples` in `orchestrator.config.json` provide a starter baseline (`unit`, `infra`, `db migrate`, `e2e`) that should be replaced with repo-specific commands.
  - Framework mapping is repository-defined (`vitest`, `jest`, `playwright`, `pytest`, `go test`, etc.); lane intent is mandatory even when command names differ.
  - For Playwright web-server tests, bind dev server explicitly to loopback (`127.0.0.1`/`localhost`) and keep the e2e command in `validation.hostRequired`.
  - `validation.host.mode`: `ci`, `local`, or `hybrid` (default).
  - `validation.host.ci.command`: optional command that performs CI-dispatched host validation.
  - `validation.timeoutSeconds` / `validation.host.timeoutSeconds` / `validation.host.ci.timeoutSeconds` define hard command timeouts (default 1800s).
  - `validation.host.local.command`: optional local host-validation command override.
- Evidence compaction:
  - `evidence.compaction.mode: "compact-index"` writes canonical per-plan index files in `docs/exec-plans/evidence-index/`.
  - `evidence.compaction.maxReferences` controls how many most-recent evidence links are retained in the canonical index.
- Evidence lifecycle:
  - `evidence.lifecycle.trackMode: "curated"` keeps canonical evidence and rewrites stale references to concise indices/readmes.
  - `evidence.lifecycle.dedupMode: "strict-upsert"` deduplicates noisy rerun artifacts by blocker signature.
  - `evidence.lifecycle.pruneOnComplete: true` re-runs curation before completion.
  - `evidence.lifecycle.keepMaxPerBlocker` controls how many artifacts remain per dedup group (default `1`).
  - Historical cleanup supports `--scope completed` to canonicalize completed-plan evidence metadata and indexes.
  - Evidence folders with markdown artifacts always have a canonical `README.md` generated/maintained by curation.
  - `docs/exec-plans/evidence-index/README.md` is generated/maintained as the index-directory guide.
- Logging and observability:
  - `pretty` output adds interactive-style, color-capable lifecycle logs plus a single live heartbeat line for in-flight session/validation activity.
  - `minimal` output prints high-signal lifecycle lines only (plan/session start-end, role transitions, validation state, blockers).
  - `ticker` output prints compact single-line lifecycle events and a single-line run summary.
  - Raw command output is written to `docs/ops/automation/runtime/<run-id>/` session/validation logs.
  - Failure summaries include only the last `--failure-tail-lines` lines and a pointer to the full log file.
  - `logging.heartbeatSeconds` and `logging.stallWarnSeconds` tune heartbeat cadence and stall-warning threshold (override via CLI flags).
- Drift guardrail:
  - Run `npm run blueprint:verify` to fail on orchestration policy drift (role-model enforcement, role command placeholders, pretty logging default, runtime-context and stage-reuse policy).
- Do not use provider interactive modes (they will block orchestration); use non-interactive CLI flags in provider commands.

## Verification Profiles

- Fast iteration profile: `npm run verify:fast`
  - Runs mandatory safety checks plus scope-selected verifiers.
- Full merge profile: `npm run verify:full`
  - Runs all required repository gates.
- Metrics capture:
  - `npm run perf:baseline`
  - `npm run perf:after`
  - Generates `docs/generated/perf-comparison.json` with before/after deltas.
- Outcomes capture (optional):
  - `npm run outcomes:report`
  - Generates `docs/generated/run-outcomes.json` from `run-events.jsonl`.
- GitHub interop export scaffold (optional):
  - `npm run interop:github:export`
  - Generates `docs/generated/github-agent-export.json` and can emit `.agent.md` plus JSON scaffolds under `.github/agents/`.
  - `npm run interop:github:export:write` writes scaffold files under `.github/agents/`.

## Related Documents

- Lite lane onboarding: `docs/ops/automation/LITE_QUICKSTART.md`
- Outcome scorecard and interpretation: `docs/ops/automation/OUTCOMES.md`
- GitHub-native mapping and export contract: `docs/ops/automation/INTEROP_GITHUB.md`
- Provider command/version contract: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`

## Plan File Naming

- Active plan files are date-prefixed by creation date: `YYYY-MM-DD-<plan-id>.md`.
- Completed plan files are date-prefixed by completion date: `YYYY-MM-DD-<plan-id>.md`.
- Legacy files without a date prefix are allowed; new automation promotions/completions use date-prefixed naming.
- This naming convention applies to plan files in `active/` and `completed/` only.
- Evidence artifacts may use step-prefixed files (`01-...md`) and date-prefixed folders (`YYYY-MM-DD-...`).

## Policy Controls

- `guarded` mode is non-interactive (no terminal approval prompt) and blocks medium/high risk plans unless explicitly approved.
- `full` mode is allowed only when `ORCH_ALLOW_FULL_AUTONOMY=1`.
- Medium/high approvals are env-gated in both `guarded` and `full` modes:
  - `ORCH_APPROVED_MEDIUM=1`
  - `ORCH_APPROVED_HIGH=1`
- Atomic commits are blocked when `--allow-dirty true` is set to avoid committing unrelated workspace changes.
- `git.atomicCommitRoots` can enforce plan-scoped commit boundaries. Plans may extend roots via metadata `Atomic-Roots`.
- Plans may also define `Concurrency-Locks` metadata to serialize specific shared resources during `run-parallel`.
- Effective risk tier is the max of declared risk and computed risk model output.
- Security approval gate is required when:
  - effective risk is `high`, or
  - effective risk is `medium` with sensitive tag/path hits.

Quick run guide:

- Default (low-only): `npm run automation:run -- --mode guarded`
- Allow medium-risk plans: `ORCH_APPROVED_MEDIUM=1 npm run automation:run -- --mode guarded`
- Allow high-risk plans: `ORCH_APPROVED_HIGH=1 npm run automation:run -- --mode guarded`
- Allow medium+high plans: `ORCH_APPROVED_MEDIUM=1 ORCH_APPROVED_HIGH=1 npm run automation:run -- --mode guarded`
- Enable full mode (still requires medium/high approvals): `ORCH_ALLOW_FULL_AUTONOMY=1 npm run automation:run -- --mode full`
- Full mode with medium+high approvals: `ORCH_ALLOW_FULL_AUTONOMY=1 ORCH_APPROVED_MEDIUM=1 ORCH_APPROVED_HIGH=1 npm run automation:run -- --mode full`
- Provider override: `ORCH_EXECUTOR_PROVIDER=claude npm run automation:run -- --mode guarded`

Start examples:

- Run with default pretty output: `npm run automation:run -- --mode guarded`
- Process up to 5 plans in one run: `npm run automation:run -- --mode guarded --max-plans 5`
- Faster liveness signal in pretty mode: `npm run automation:run -- --mode guarded --heartbeat-seconds 5 --stall-warn-seconds 45`
- Compact ticker output: `npm run automation:run -- --mode guarded --output ticker`

Pretty output example:

```text
16:04:07 | RUN   run started runId=run-20260301160407-k4l9wd mode=guarded output=pretty failureTailLines=60
16:04:07 / RUN   plan start attendee-search-suggestion-qa-hardening declared=low effective=low score=0
16:04:07 \ RUN   session 1 start attendee-search-suggestion-qa-hardening role=worker stage=1/1 provider=codex model=gpt-5.3-codex risk=low
16:04:19 ... RUN  phase=session plan=attendee-search-suggestion-qa-hardening role=worker activity=implementing elapsed=12s idle=12s
```

Parallelism note:

- `--max-plans` is a processing cap.
- `run` is sequential by default.
- `run --parallel-plans <n>` (or `run-parallel`) dispatches independent plans into isolated git worktrees/branches.
- There is no dedicated `resume-parallel` CLI subcommand; continuing parallel execution means invoking `run-parallel` again with desired concurrency.
- npm convenience alias: `npm run automation:resume:parallel -- --mode guarded --parallel-plans 4` (maps to `run-parallel`).
- Dependency gating remains strict: plans only start when all `Dependencies` are satisfied.
- `parallel.assumeDependencyCompletion` defaults to `false` so dependent plans wait for integration unless explicitly enabled.

## Exit Conventions

Executor commands should use these outcomes:

- Exit code `0`: success (or write result status `completed`).
- Exit code `75`: request session rollover/handoff.
- Non-zero other than `75`: fail execution.
- A plan is auto-moved to `docs/exec-plans/completed/` only when its top-level `Status:` line is `completed`.
- If the top-level `Status:` is not `completed`, orchestration starts another executor session for the same plan in the same run (up to `--max-sessions-per-plan`), then leaves it in `active/` for later `resume` if still incomplete.
- Session boundaries are strict: each planner/explorer/worker/reviewer stage starts a new executor process and can use a role-specific model profile.
- Executor sessions must always emit a structured result payload (`ORCH_RESULT_PATH`) with a numeric `contextRemaining`.
- Default context rollover policy is proactive: a new session is forced when `contextRemaining <= 10000` (override with `--context-threshold` or `executor.contextThreshold`).
- If an executor exits `0` without payload (or without numeric `contextRemaining`), orchestrator forces an immediate handoff/rollover to protect coding accuracy.
- If host-required validations cannot run in the current environment, orchestration keeps the plan `in-progress`, records a host-validation pending reason, and continues with other executable plans.
- If validation lanes are required but unconfigured, `run`/`resume` fail immediately (fail-closed).
- Failed plans are automatically re-queued on `resume` when policy/security/dependency gates are now satisfied (up to `--max-failed-retries`).
- Blocked plans are automatically re-queued on `resume` when their blocking gates are now satisfied (for example, approvals provided).
- `blocked` remains reserved for external/manual gates; `failed` remains a validation/execution failure signal.
- When a plan completes, `Done-Evidence` points to its canonical evidence index file.
- During curation, removed evidence paths are automatically rewritten in plan docs to the retained canonical reference.

## Risk-Adaptive Role Flow

- `low`: `worker`
- `medium`: `planner -> worker -> reviewer`
- `high`: `planner -> explorer -> worker -> reviewer`
- If final completion criteria are not yet met after reviewer/worker, orchestrator resets stage progression to `worker` and continues until completion gates pass.
- The active role is passed to executors via `ORCH_ROLE` and `--role {role}`.

## Security Approval Field

- Metadata field: `Security-Approval` (`not-required` | `pending` | `approved`).
- For required approval gates, completion is blocked until `Security-Approval: approved`.
- If approval is required and the field is missing/`not-required`, orchestration updates it to `pending` and blocks with an explicit reason.

## Real-World Examples

- Low-risk UI copy plan:
  - `Risk-Tier: low`
  - stages: `worker`
- Medium-risk refactor with auth tags:
  - `Risk-Tier: medium`
  - `Tags: auth`
  - stages: `planner -> worker -> reviewer`
- High-risk payment callback change:
  - `Risk-Tier: high`
  - `Tags: payments, security`
  - stages: `planner -> explorer -> worker -> reviewer`
  - completion blocked until `Security-Approval: approved`

Required result payload (path from `ORCH_RESULT_PATH`):

```json
{
  "status": "completed",
  "summary": "Implemented acceptance criteria 1 and 2",
  "contextRemaining": 2100,
  "reason": "optional detail",
  "blockerKey": "optional-stable-blocker-id",
  "evidenceAction": "upsert"
}
```
