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
- `run-state.json.orchestrationState[*]`: canonical per-plan control-plane state snapshot derived from replayable transitions.
- `docs/exec-plans/evidence-index/`: canonical compact evidence indexes by plan ID.
- `run-state.json`, `run-events.jsonl`, `runtime/`, and `handoffs/` are transient runtime artifacts; they are ignored by dirty preflight.
- `docs/ops/automation/handoffs/`: per-plan rollover handoff notes.
- `docs/ops/automation/runtime/`: per-run executor result payloads, per-plan rolling-context state, and the transient active-run lock file (`orchestrator.lock.json`).
- `docs/ops/automation/runtime/contacts/<run-id>/<plan-id>/<role>.md`: generated task-scoped contact packs for each role session.
- `docs/ops/automation/runtime/contacts/<run-id>/<plan-id>/<role>.json`: scored contact-pack manifest with selected inputs and thin-pack classification.
- `docs/ops/automation/runtime/state/<plan-id>/latest.json`: machine-readable current continuity state for the plan.
- `docs/ops/automation/runtime/state/<plan-id>/checkpoints.jsonl`: append-only checkpoint log for resumable episodic memory.
- `docs/ops/automation/runtime/incidents/<run-id>/<plan-id>/`: failed/degraded continuity replay bundles.

## Runtime Contract Posture

- `harness-manifest.json`, `run-state.json`, `run-events.jsonl`, continuity state, checkpoint records, contact-pack manifests, and validation result payloads are versioned machine-readable contracts.
- `run-events.jsonl` transition-bearing entries also carry canonical orchestration fields (`machine`, `fromState`, `toState`, `transitionCode`) and may attach `faultCode` plus `recoveryAction` when the harness classifies a failure path.
- Shared structured writes are expected to use the harness helpers so overwrite-style files are written atomically and append-only logs stay single-writer.
- Readers should fail closed on incompatible, malformed, or truncated structured state instead of silently treating it as valid runtime data.
- Downstream repos should treat manual edits to runtime contract files as exceptional operational recovery, not normal workflow.

## Source Of Truth

- `docs/future/`: proposed upcoming work not yet executing.
- `docs/exec-plans/active/`: current execution state and in-progress work.
- `docs/exec-plans/completed/`: completed execution plans and closure records.
- `docs/exec-plans/evidence-index/`: canonical compact evidence references by plan ID.
- `docs/product-specs/CURRENT-STATE.md`: product-facing delivery timeline via `Automated Delivery Log`.
- `## Must-Land Checklist` inside each plan is the executable completion contract; broader vision belongs in `## Deferred Follow-Ons`, not in completion gating.
- `Delivery-Class` and `Execution-Scope` make plan intent explicit. The harness does not infer executable meaning from titles such as `phase`, `portfolio`, or `blueprint`.
- `Execution-Scope: program` plans stay active as non-executable parent contracts. `Execution-Scope: slice` plans are the only plans that enter worker/reviewer/validation lanes directly.
- Future and active program parents must declare `Authoring-Intent`.
- Program parents with `Authoring-Intent: executable-default` must declare `## Child Slice Definitions`; orchestration/compiler materializes those child slices before promotion and queue selection.
- Program parents with `Authoring-Intent: blueprint-only` are explicit draft-only blueprints and must not promote or compile.
- Compiled child slices must declare `Validation-Lanes` and include `## Validation Contract` so proof references bind to configured validation IDs instead of free-form command text.
- Legacy program parents that still use `## Remaining Execution Slices` or `## Portfolio Units` must be migrated to `## Child Slice Definitions` before automatic child compilation is allowed; use `node ./scripts/automation/migrate-program-children.mjs --plan-file <path>` for a dry-run preview. `plans:scaffold-children` refuses legacy parents so migration stays explicit.
- If a broad executable parent still lacks a safe child graph, use `npm run plans:scaffold-children -- --plan-file <path>` to generate review-required draft child definitions instead of leaving the parent childless. The scaffold command auto-writes missing `Authoring-Intent: executable-default`.
- Generated child definitions are scaffolds, not acceptance-ready contracts. Remove draft markers, replace placeholders, and rerun `npm run plans:compile` before expecting `plans:verify` to accept the parent in stricter repos.
- Product slices must declare `Implementation-Targets`; those roots are the authoritative implementation evidence boundary. Worker sessions must not edit source/tests/config files outside those roots without first updating plan scope. `Spec-Targets` remain the broader impact list.
- Future blueprints and active program parents must also include `## Prior Completed Plan Reconciliation` so overlapping completed plans are explicitly preserved, refactored, superseded, marked obsolete, or reopened.

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

- `node ./scripts/automation/pre-grind-hygiene.mjs [--plan-id <value>]`
- `node ./scripts/automation/orchestrator.mjs run --mode guarded --retry-failed true --auto-unblock true --max-failed-retries 2 --output pretty`
- `node ./scripts/automation/orchestrator.mjs run-parallel --mode guarded --parallel-plans 3 --retry-failed true --auto-unblock true --max-failed-retries 2 --output pretty`
- `node ./scripts/automation/orchestrator.mjs resume`
- `node ./scripts/automation/orchestrator.mjs audit --json true`
- `node ./scripts/automation/verify-orchestration-state.mjs`
- `node ./scripts/automation/orchestrator.mjs curate-evidence [--scope active|completed|all] [--plan-id <value>]`
- `node ./scripts/automation/compile-program-children.mjs --write true [--plan-id <value>]`
- `node ./scripts/automation/scaffold-program-children.mjs --plan-file <path> [--write true]`
- `node ./scripts/automation/migrate-program-children.mjs --plan-file <path> [--write true]`
- Typical migration path for older broad futures/phase parents:
  1. `plans:migrate` if the parent still uses legacy headings.
  2. `plans:scaffold-children` if the parent is future-native but childless.
  3. Review child definitions and remove draft markers/placeholders.
  4. `plans:compile` to materialize or refresh child slices.
  5. `plans:verify` and `verify:fast` to confirm the upgraded authoring shape.
- Optional continuation controls:
  - `--max-sessions-per-plan <n>` (default `12`)
  - `--max-rollovers <n>` (default `20`)
- Output controls:
  - `--output minimal|ticker|pretty|verbose` (default `pretty`)
  - `--failure-tail-lines <n>` (default `60`)
  - `--heartbeat-seconds <n>` (default `120`)
  - `--stall-warn-seconds <n>` (default `120`)
  - `--touch-summary true|false` (default `true`)
  - `--touch-sample-size <n>` (default `3`)
  - `--live-activity-mode off|best-effort` (default `best-effort`)
  - `--live-activity-max-chars <n>` (default `0`, no truncation)
  - `--live-activity-sample-seconds <n>` (default `2`)
  - `--live-activity-emit-event-lines true|false` (default `false`)
  - `--live-activity-redact-patterns "<regex1>;;<regex2>"` (optional)
  - `--worker-first-touch-deadline-seconds <n>` (default `180`, `0` disables)
  - `--worker-retry-first-touch-deadline-seconds <n>` (default inherits `--worker-first-touch-deadline-seconds`)
  - `--worker-no-touch-retry-limit <n>` (default `1`)
  - `--worker-pending-streak-limit <n>` (default `4`, `0` disables)
- Recovery controls:
  - `--retry-failed true|false` (default `true`)
  - `--auto-unblock true|false` (default `true`)
  - `--max-failed-retries <n>` (default `2`)
- Guarded grind recommendation:
  - Run one hygiene pass before a new grind.
  - When running the supervisor grind scripts, prefer `--auto-unblock false` so unchanged blockers stay parked.
- Parallel controls:
  - `--parallel-plans <n>` enables dependency-aware parallel branch/worktree execution.

## Executor Configuration

- `executor.command` in `docs/ops/automation/orchestrator.config.json` is required for `run`/`resume`.
- Set this once per repository; default is the portable `executor-wrapper` entrypoint.
- If empty, `run`/`resume` fail immediately with a clear error.
- `parallel.baseRef` supports `CURRENT_BRANCH` (recommended default) and resolves to the checked-out branch at run start.
- Example (`orchestrator.config.json`):
  - `"command": "node ./scripts/automation/executor-wrapper.mjs --plan-id {plan_id} --plan-file {plan_file} --run-id {run_id} --mode {mode} --session {session} --role {role} --effective-risk-tier {effective_risk_tier} --declared-risk-tier {declared_risk_tier} --stage-index {stage_index} --stage-total {stage_total} --result-path {result_path} --contact-pack-file {contact_pack_file}"`
  - `"provider": "codex"` (override per run with `ORCH_EXECUTOR_PROVIDER=...`)
  - `"providers.codex.command": "codex exec --json --full-auto -c model_reasoning_effort={role_reasoning_effort} -m {role_model} {prompt}"` (`{prompt}`, `{role_model}`, and `{role_reasoning_effort}` are required)
  - `"providers.claude.command": "claude -p --model {role_model} {prompt}"` (`{prompt}` and `{role_model}` are required)
  - `"enforceRoleModelSelection": true` requires each role command to include `{role_model}`.
  - `"contextThreshold": 10000` (legacy alias for the absolute remaining-context floor)
  - `"contextAbsoluteFloor": 10000`
  - `"contextSoftUsedRatio": 0.65`
  - `"contextHardUsedRatio": 0.8`
  - `"requireResultPayload": true`
  - `"context.runtimeContextPath"` points to compiled runtime instructions (`docs/generated/AGENT-RUNTIME-CONTEXT.md` by default).
  - `"context.maxTokens"` sets a hard budget for compiled runtime context size.
  - `"context.contactPacks"` configures per-task scoped role contact packs (`enabled`, `maxPolicyBullets`, `includeRecentEvidence`, `maxRecentEvidenceItems`, `includeLatestState`, `maxRecentCheckpointItems`, `maxStateListItems`, `cacheMode`).
  - Contact packs include the shared memory posture and select continuity inputs in priority order: latest continuity state, latest same-role checkpoint, latest cross-role or stage-transition checkpoint, then capped evidence refs.
  - Thin-pack classification is availability-aware: a first-session pack is not penalized for missing checkpoint entries when no prior checkpoint candidates existed yet.
  - `With "context.contactPacks.cacheMode": "run-memory", cache keys include an evidence freshness token (state signature when available, otherwise evidence-index file stat) to avoid stale recent-evidence payloads.`
  - `"logging.output": "pretty"` (`minimal` | `ticker` | `pretty` | `verbose`), `"logging.failureTailLines": 60`, `"logging.heartbeatSeconds": 120`, `"logging.stallWarnSeconds": 120`, `"logging.touchSummary": true`, `"logging.touchSampleSize": 3`, `"logging.touchScanMode": "adaptive"`, `"logging.touchScanMinHeartbeats": 1`, `"logging.touchScanMaxHeartbeats": 8`, `"logging.touchScanBackoffUnchanged": 2`, `"logging.liveActivity": {"mode": "best-effort", "maxChars": 0, "sampleSeconds": 2, "emitEventLines": false, "redactPatterns": [...]}`, `"logging.workerFirstTouchDeadlineSeconds": 180`, `"logging.workerRetryFirstTouchDeadlineSeconds": 180`, `"logging.workerNoTouchRetryLimit": 1`, and `"logging.workerPendingStreakLimit": 4` tune operator-facing output noise, liveness, live file-touch visibility, provider live-message surfacing, touch-scan cadence, and worker no-progress fail-fast behavior (`workerFirstTouchDeadlineSeconds: 0` disables deadline fail-fast; retry sessions inherit the base deadline unless overridden; `workerPendingStreakLimit: 0` disables worker same-role pending streak fail-fast).
  - `"recovery.retryFailed": true`, `"recovery.autoUnblock": true`, and `"recovery.maxFailedRetries": 2` control automatic retry/unblock behavior for resumable plans.
  - `"parallel.maxPlans"` sets default worker concurrency for `run --parallel-plans`.
  - `"parallel.workerOutputMode": "minimal"` keeps branch workers concise by default.
  - `"parallel.worktreeRoot"`, `"parallel.branchPrefix"`, `"parallel.baseRef"`, `"parallel.gitRemote"` configure branch/worktree strategy.
  - `"parallel.pushBranches": true` pushes worker branches automatically.
  - `"parallel.openPullRequests": true` with `"parallel.pullRequest.createCommand"` can open PRs per completed worker branch.
  - `"parallel.pullRequest.mergeCommand"` can enqueue or merge generated PRs after creation (for merge queues).
  - `pullRequest.createCommand` token support: `{plan_id}`, `{branch}`, `{base_ref}`, `{git_remote}`, `{run_id}`, `{head_sha}`, `{worktree}`.
  - `executor.promptTemplate` should stay set to `@canonical-executor-prompt`; the canonical policy text now lives in `scripts/automation/lib/executor-policy.mjs` and is reused across Codex and Claude Code adapters.
  - Keep the static instruction prefix at the start of `executor.promptTemplate` so repeated sessions get better prompt-cache reuse; push plan-specific identifiers later in the prompt.
- Role orchestration:
  - `roleOrchestration.enabled: true` enables risk-adaptive role routing.
  - `roleOrchestration.roleProfiles` defines per-role execution profiles (`model`, `reasoningEffort`, optional `reasoningEffortByRisk`, `sandboxMode`, `instructions`).
  - Default profile policy:
  - `explorer`: fast model (`gpt-5.3-codex-spark`), `medium`, `read-only`
  - `reviewer`: high reasoning, `read-only`
  - `planner`: medium reasoning by default with high-risk override support, `read-only`
  - `worker`: high reasoning, `full-access`
  - `roleOrchestration.pipelines.low` defaults to `worker`.
  - `roleOrchestration.pipelines.medium` defaults to `planner -> worker -> reviewer`.
  - `roleOrchestration.pipelines.high` defaults to `planner -> explorer -> worker -> reviewer`.
  - `roleOrchestration.stageBudgetsSeconds` sets planner/explorer/reviewer session budget ceilings used for no-progress fail-fast.
  - `roleOrchestration.stageReuse` allows safe skip of previously completed planner/explorer stages when plan shape and scope remain stable (including across resume runs when `sameRunOnly: false`).
  - `roleOrchestration.riskModel` computes an effective risk tier from declared risk, dependencies, tags, scope paths, and prior validation failures.
  - `roleOrchestration.approvalGates` enforces Security Ops approval for high-risk completions and sensitive medium-risk completions.
  - `roleOrchestration.providers.<provider>.roles.<role>.command` can override provider command templates by role.
  - Role command templates can use profile placeholders:
    - `{role_model}`
    - `{role_reasoning_effort}`
    - `{role_sandbox_mode}`
    - `{role_instructions}`
  - Each role stage runs as a fresh executor process/session. For strict profile switching, include `{role_model}` and `{role_reasoning_effort}` in every role command template.
  - Detailed role contract: `docs/ops/automation/ROLE_ORCHESTRATION.md`.
- Validation lanes:
  - `validation.always`: sandbox-safe checks that should run in every completion gate.
  - Validation entries may be plain strings or structured objects with `id`, `command`, and optional `type`; proof mapping should reference explicit IDs instead of command text.
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
  - Recommended baseline: set `validation.host.local.command` to `npm run verify:full` so host-lane behavior is explicit and reproducible.
  - If host validation fails with command output (for example architecture/dependency checks), treat it as a real repository-gate failure and fix the code/docs; host configuration is already functioning.
  - Compiled child slices record `Validation-Lanes` plus a generated `## Validation Contract`; those contracts should reference explicit validation IDs already configured here.
- Semantic proof:
  - `semanticProof.mode: advisory|required` controls whether missing proof coverage is reported or blocks product-slice completion.
  - Product slices should add stable lowercase must-land IDs such as `ml-lifecycle-workbench-summary` plus `## Capability Proof Map` so must-land claims map to explicit capability and proof rows.
  - `## Capability Proof Map` must use two markdown tables in order: `Capability ID | Must-Land IDs | Claim | Required Strength`, then `Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness`.
  - Proof rows should reference explicit validation IDs or artifact paths; do not rely on title or test-name inference.
  - Validation commands can emit structured result payloads via `ORCH_VALIDATION_RESULT_PATH`; orchestrator uses those payloads for proof matching and external-residual failure classification.
  - When structured findings show a validation failure is entirely outside the current plan scope, orchestration records a residual blocker instead of failing the slice as product-incomplete.
- Evidence compaction:
  - `evidence.compaction.mode: "compact-index"` writes canonical per-plan index files in `docs/exec-plans/evidence-index/`.
  - `evidence.compaction.maxReferences` controls how many most-recent evidence links are retained in the canonical index.
  - Reference extraction accepts markdown links, inline code paths, and plain plan-text evidence paths under `docs/exec-plans/*/evidence/` so canonical indexes do not churn at `0` when the plan already contains compact evidence references.
- Evidence lifecycle:
  - `evidence.lifecycle.trackMode: "curated"` keeps canonical evidence and rewrites stale references to concise indices/readmes.
  - `evidence.lifecycle.dedupMode: "strict-upsert"` deduplicates noisy rerun artifacts by blocker signature.
  - `evidence.lifecycle.pruneOnComplete: true` re-runs curation before completion.
  - `evidence.lifecycle.keepMaxPerBlocker` controls how many artifacts remain per dedup group (default `1`).
  - `evidence.sessionCurationMode: "on-change"` runs per-session curation only when plan/evidence paths changed.
  - `evidence.sessionIndexRefreshMode: "on-change"` refreshes per-session evidence indexes only when plan/evidence paths changed.
  - Historical cleanup supports `--scope completed` to canonicalize completed-plan evidence metadata and indexes.
  - Evidence folders with markdown artifacts always have a canonical `README.md` generated/maintained by curation.
  - `docs/exec-plans/evidence-index/README.md` is generated/maintained as the index-directory guide.
- Logging and observability:
  - `pretty` output adds interactive-style, color-capable lifecycle logs plus a single live heartbeat line for in-flight session/validation activity.
  - `minimal` output prints high-signal lifecycle lines only (plan/session start-end, role transitions, validation state, blockers).
  - `ticker` output prints compact single-line lifecycle events and a single-line run summary.
  - Live heartbeats can include best-effort provider text as `agent="..."` when available; this stream is informational only and never used for orchestration gating.
  - When Codex runs with `--json`, orchestrator prefers structured event fields for `agent="..."` updates and falls back to plain line parsing when needed.
  - Live heartbeats include touched-file summaries (`touch=<count>(<category>:<count>,...)`) so long-running sessions still show concrete progress.
  - File-touch detail lines (`file activity ...`) emit category counts and representative file samples when touched-file sets change.
  - `logging.liveActivity.emitEventLines: true` appends optional `provider_activity` events to `run-events.jsonl` (disabled by default to limit noise).
  - Raw command output is written to `docs/ops/automation/runtime/<run-id>/` session/validation logs.
  - Failure summaries include only the last `--failure-tail-lines` lines and a pointer to the full log file.
  - `logging.heartbeatSeconds`, `logging.stallWarnSeconds`, `logging.touchSummary`, `logging.touchSampleSize`, `logging.touchScanMode`, `logging.touchScanMinHeartbeats`, `logging.touchScanMaxHeartbeats`, `logging.touchScanBackoffUnchanged`, `logging.liveActivity.mode`, `logging.liveActivity.maxChars`, `logging.liveActivity.sampleSeconds`, `logging.liveActivity.redactPatterns`, `logging.workerFirstTouchDeadlineSeconds`, `logging.workerRetryFirstTouchDeadlineSeconds`, `logging.workerNoTouchRetryLimit`, and `logging.workerPendingStreakLimit` tune heartbeat cadence, stall-warning threshold, file-touch detail level/cadence, provider live-message capture/redaction/rate-limiting, worker first-edit deadline fail-fast (`--worker-first-touch-deadline-seconds`), retry-session first-edit deadline (`--worker-retry-first-touch-deadline-seconds`), automatic worker no-touch retries (`--worker-no-touch-retry-limit`), and same-role worker pending streak fail-fast (`--worker-pending-streak-limit`).
- Drift guardrail:
  - Run `npm run harness:verify` to fail on harness policy drift (role-model enforcement, role command placeholders, pretty logging default, runtime-context and stage-reuse policy).
- Do not use provider interactive modes (they will block orchestration); use non-interactive CLI flags in provider commands.

## Verification Profiles

- Fast iteration profile: `npm run verify:fast`
  - Runs mandatory safety checks plus scope-selected verifiers.
  - When run inside orchestration sessions, `verify:fast` receives `ORCH_PLAN_ID` and scopes `check-plan-metadata` to the in-flight plan to avoid unrelated plan-metadata drift blocking completion.
  - Runs `node ./scripts/docs/repair-plan-references.mjs` before docs governance checks so stale plan-path links and stale runtime links (contact packs and run artifacts) are auto-healed while keeping strict governance enabled.
  - Runs `node ./scripts/automation/check-plan-metadata.mjs`; in local runs it auto-heals top-level `Status:` drift to metadata `- Status` (set `ORCH_PLAN_METADATA_AUTO_HEAL_STATUS=0` to disable; CI defaults to disabled).
  - When orchestration provides `ORCH_VALIDATION_RESULT_PATH`, `verify:fast` aggregates child-checker finding files into a structured result payload so residual external blockers can be distinguished from plan-scoped failures.
  - In orchestrator planner/explorer/reviewer sessions (`ORCH_ROLE` non-worker), it automatically switches to read-only behavior (`repair-plan-references --dry-run`, runtime-context output to `/tmp`, and metadata auto-heal disabled) to avoid role-scope policy violations.
- Full merge profile: `npm run verify:full`
  - Runs all required repository gates.
  - When run inside orchestration sessions, `verify:full` receives `ORCH_PLAN_ID` and scopes `check-plan-metadata` to the in-flight plan to avoid unrelated plan-metadata auto-heal edits during host validation.
  - When orchestration provides `ORCH_VALIDATION_RESULT_PATH`, `verify:full` aggregates child-checker finding files into a structured result payload for host-lane reporting.
- State replay verifier:
  - `npm run state:verify`
  - Replays orchestration state from `run-events.jsonl`, compares it with `run-state.json`, and fails on illegal transitions or persisted-state drift.
- Metrics capture:
  - `npm run perf:baseline`
  - `npm run perf:after`
  - Generates `docs/generated/perf-comparison.json` with before/after deltas.
- Outcomes capture (optional):
  - `npm run outcomes:report`
  - Generates `docs/generated/run-outcomes.json` from `run-events.jsonl`, including `summary.memory` continuity and contact-pack metrics.
  - `npm run outcomes:verify`
  - Warns locally when samples are too thin, and blocks CI/merge flows when derived continuity, thin-pack, resume-safe checkpoint, or repeated handoff-loop thresholds are breached.
  - `resumeSafeCheckpointRate` prefers `session_checkpoint_assessed` per session and falls back to checkpoint fields embedded in that session's `session_finished` event when no dedicated assessment event exists.
  - `thinPackRate` only counts sessions that were genuinely missing expected continuity categories from the available candidate set; first-session packs without reusable checkpoints are not thin by default.
- Perf budget verification:
  - `node ./scripts/automation/check-performance-budgets.mjs`
  - Warns locally when baseline/sample evidence is insufficient, and blocks CI/merge flows when comparable metrics regress past the configured budgets.
  - Budgets cover runtime-context size, `verify:fast`, `verify:full`, median time-to-first-worker-edit, and average sessions per completed plan.
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
- When a required security approval is satisfied via these env vars during a resumed run, orchestration records `Security-Approval: approved` before validation/final completion so blocked high-risk plans can continue without a separate manual metadata edit.
- Atomic commits are blocked when `--allow-dirty true` is set to avoid committing unrelated workspace changes.
- `git.atomicCommitRoots` can enforce plan-scoped commit boundaries. Plans may extend roots via metadata `Atomic-Roots`.
- Plans may also define `Concurrency-Locks` metadata to serialize specific shared resources during `run-parallel`.
- Effective risk tier is the max of declared risk and computed risk model output.
- Security approval gate is required when:
  - effective risk is `high`, or
  - effective risk is `medium` with sensitive tag/path hits.

Quick run guide:

- Default (low-only baseline, clean + atomic): `npm run automation:run`
- Enable medium-risk plans (low+medium): `npm run automation:run:medium`
- Enable high-risk plans (low+medium+high): `npm run automation:run:high`
- Parallel default (low-only baseline, clean + atomic): `npm run automation:run:parallel`
- Parallel with medium-risk plans enabled (low+medium): `npm run automation:run:parallel:medium`
- Parallel with high-risk plans enabled (low+medium+high): `npm run automation:run:parallel:high`
- Enable full mode: `ORCH_ALLOW_FULL_AUTONOMY=1 npm run automation:run -- --mode full`
- Provider override: `ORCH_EXECUTOR_PROVIDER=claude npm run automation:run`

Start examples:

- Run with default pretty output + recovery profile: `npm run automation:run`
- Materialize structured program children explicitly: `npm run plans:compile`
- Process up to 5 plans in one run: `npm run automation:run -- --max-plans 5`
- Faster liveness signal in pretty mode: `npm run automation:run -- --heartbeat-seconds 5 --stall-warn-seconds 45`
- Compact ticker output: `npm run automation:run -- --output ticker`
- Supervised overnight loop (run + repeated resume): `npm run automation:run:grind`
- Supervised resume loop: `npm run automation:resume:grind`
- Supervised parallel loop: `npm run automation:run:parallel:grind`
- Resume direct non-atomic high-risk continuation: `npm run automation:resume:high:non-atomic`

Future blueprint promotion quick rule:

- Before setting `Status: ready-for-promotion`, require `## Master Plan Coverage` or `## Capability Coverage Matrix`, require `## Prior Completed Plan Reconciliation`, require `## Promotion Blockers`, and run `npm run plans:verify`.
- `run`, `resume`, `run-parallel`, and `resume-parallel` compile structured program children before future promotion and before queue selection so the executable queue comes from the compiled active child graph rather than ad hoc plan discovery.

Pretty output example:

```text
16:04:07 | RUN   run started runId=run-20260301160407-k4l9wd mode=guarded output=pretty failureTailLines=60
16:04:07 / RUN   plan start attendee-search-suggestion-qa-hardening declared=low effective=low score=0
16:04:07 \ RUN   session 1 start attendee-search-suggestion-qa-hardening role=worker stage=1/1 provider=codex model=gpt-5.4 risk=low
16:04:19 ... RUN  phase=session plan=attendee-search-suggestion-qa-hardening role=worker activity=implementing agent="reviewing organizer service edge cases" elapsed=12s idle=3s touch=4(source:3,tests:1)
16:04:19 - RUN    file activity phase=session plan=attendee-search-suggestion-qa-hardening role=worker touched=4 categories=[source:3, tests:1] sample=[libs/events/backend/src/lib/event-organizer.service.ts, libs/events/backend/src/lib/event-organizer.service.spec.ts, docs/exec-plans/active/evidence/attendee-search-suggestion-qa-hardening.md]
```

Parallelism note:

- `--max-plans` is a processing cap.
- `run` is sequential by default.
- `run --parallel-plans <n>` (or `run-parallel`) dispatches independent plans into isolated git worktrees/branches.
- `--base-ref CURRENT_BRANCH` anchors parallel workers/PR targets to the branch you started from.
- `resume-parallel` is available when you want to continue an existing run with parallel workers.
- npm convenience alias: `npm run automation:resume:parallel` (maps to `resume-parallel` with template defaults).
- Dependency gating remains strict: plans only start when all `Dependencies` are satisfied.
- `parallel.assumeDependencyCompletion` defaults to `false` so dependent plans wait for integration unless explicitly enabled.
- Supervisor loop controls:
  - `ORCH_SUPERVISOR_MAX_CYCLES` (default `120`)
  - `ORCH_SUPERVISOR_STABLE_LIMIT` (default `4`)
  - `ORCH_SUPERVISOR_MAX_CONSECUTIVE_ERRORS` (default `2`)
  - `ORCH_SUPERVISOR_CONTINUE_ON_ERROR` (default `1`)
  - `ORCH_SUPERVISOR_ALLOW_DIRTY_RECOVERY` (default `0`; when set to `1`, supervisor can continue with `--allow-dirty true --commit false` after atomic deadlocks, including follow-up `resume` cycles on dirty worktrees)
- Grind aliases (`automation:*:grind*`) set `ORCH_SUPERVISOR_ALLOW_DIRTY_RECOVERY=1` and increase `ORCH_SUPERVISOR_MAX_CONSECUTIVE_ERRORS` to `8` for overnight continuity.
- Supervisor treats `Status: validation` plans as externally gated for drain detection, so grind loops stop once executable queues are empty instead of repeatedly re-running no-progress validation-only resumes.

## Exit Conventions

Executor commands should use these outcomes:

- Exit code `0`: success (or write result status `completed`).
- Exit code `75`: request session rollover/handoff.
- Non-zero other than `75`: fail execution.
- A plan is auto-moved to `docs/exec-plans/completed/` only when its top-level `Status:` line is `completed`.
- If the top-level `Status:` is `validation` (or `completed`), orchestration skips role sessions and runs validation lanes directly.
- If the top-level `Status:` is neither `validation` nor `completed`, orchestration starts another executor session for the same plan in the same run (up to `--max-sessions-per-plan`), then leaves it in `active/` for later `resume` if still incomplete.
- Session boundaries are strict: each planner/explorer/worker/reviewer stage starts a new executor process and can use a role-specific model profile.
- Each session gets a task-scoped contact pack (`{contact_pack_file}`) built from runtime policy, shared memory posture, task scope, latest continuity state, selected checkpoints, and capped evidence references. Executors should use it as primary context before expanding scope.
- Contact packs also emit a JSON manifest so later sessions can score which continuity inputs were actually useful.
- Thin-pack scoring only expects continuity categories that had candidates available for that session, so missing checkpoints are only penalized once reusable checkpoint history exists.
- Executor sessions must always emit a structured result payload (`ORCH_RESULT_PATH`) with a numeric `contextRemaining`; include numeric `contextWindow` and `contextUsedRatio` whenever the provider/runtime can estimate them reliably.
- Non-terminal executor payloads must also include `currentSubtask`, `nextAction`, and `stateDelta` so orchestration can checkpoint resumable state instead of relying on raw session history.
- Persisted checkpoints are scored for resume safety; synthesized continuity, thin contact packs, and unsafe checkpoints are treated as degraded continuity and can emit replay bundles.
- Default context rollover policy is hybrid and proactive: use `contextSoftUsedRatio` to stop widening scope, `contextHardUsedRatio` to force same-role handoff when more work remains, and `contextAbsoluteFloor` as the hard remaining-context backstop (override with `--context-soft-used-ratio`, `--context-hard-used-ratio`, or `--context-absolute-floor`; `--context-threshold` remains a legacy alias for the floor).
- If an executor exits `0` without payload (or without numeric `contextRemaining` for `completed`/`pending`), orchestrator forces an immediate handoff/rollover to protect coding accuracy.
- Handoff markdown is now paired with a structured JSON handoff packet; same-run rollovers and later `resume` runs rebuild continuity from the durable checkpoint state, not from the raw transcript.
- If host-required validations cannot run in the current environment, orchestration keeps the plan `validation`, records a host-validation pending reason, and continues with other executable plans.
- If validation lanes are required but unconfigured, `run`/`resume` fail immediately (fail-closed).
- Failed plans are automatically re-queued on `resume` when policy/security/dependency gates are now satisfied (up to `--max-failed-retries`).
- Blocked plans are automatically re-queued on `resume` when their blocking gates are now satisfied (for example, approvals provided).
- `pending` keeps work in the active implementation role instead of auto-advancing the full pipeline; reviewer `pending` routes back to worker for fixes.
- Planner/explorer `pending` with implementation-handoff reasons (for example, read-only constraints or implementation still pending) auto-advances to the next stage to avoid no-op loops.
- Planner/explorer/reviewer sessions are restricted to execution plan/evidence docs (`docs/exec-plans/**`); touching other paths fails fast as a policy violation.
- Worker `pending` without repository edits outside `docs/exec-plans/**` auto-retries first (bounded by `--worker-no-touch-retry-limit`, with retry timeout controlled by `--worker-retry-first-touch-deadline-seconds`); plan/evidence-only churn does not count as worker progress unless the plan's scoped targets are themselves limited to execution-plan/evidence docs. When a worker continuation session already starts with dirty implementation edits inside the plan's spec-target roots, the first-touch deadline is skipped for that session, but returning `pending` without new meaningful repository edits still fail-fasts at session end.
- Worker same-role `pending` streaks fail fast when they exceed `--worker-pending-streak-limit`, forcing narrower implementation slices instead of long in-run loops.
- Read-only same-role `pending` returns fail fast after a bounded streak so plan-doc churn cannot keep planner/explorer/reviewer sessions alive.
- Repeated identical `pending` signals for the same role fail fast in-run so orchestration does not spin on no-progress loops.
- `blocked` / `failed` / `pending` outcomes print concrete `next steps` guidance with a ready-to-run `automation:resume` command.
- `blocked` remains reserved for external/manual gates; `failed` remains a validation/execution failure signal.
- When a plan completes, `Done-Evidence` points to its canonical evidence index file.
- During curation, removed evidence paths are automatically rewritten in plan docs to the retained canonical reference.

## Risk-Adaptive Role Flow

- `low`: `worker`
- `medium`: `planner -> worker -> reviewer`
- `high`: `planner -> explorer -> worker -> reviewer`
- Completion gate opens when top-level plan `Status` is `completed`, or when `Status: validation` is paired with explicit `Validation-Ready`.
- Optional metadata `Validation-Ready: host-required-only` (or `yes`) allows deterministic reviewer closeout promotion to validation without relying only on free-text phrasing.
- `Status: validation` on its own is not enough for validation fast-path; reviewer closeout should set `Validation-Ready` and `Status: validation` together.
- Validation/completion is blocked when any `## Must-Land Checklist` checkbox remains unchecked.
- `Execution-Scope: program` plans are never validation-ready; they remain parent contracts until child slices finish and parent scope is reconciled.
- Product slices must record implementation evidence under `Implementation-Targets` before validation/completion; docs/ops/reconciliation slices do not require code-root touches.
- Plans that discuss broader target state must separate current facts into `## Already-True Baseline` and later work into `## Deferred Follow-Ons`; only `## Must-Land Checklist` is executable scope.
- Future blueprints and active program parents fail plan verification when `## Prior Completed Plan Reconciliation` is missing.
- If final completion criteria are not yet met after reviewer/worker, orchestrator resets stage progression to `worker` and continues until completion gates pass.
- Reviewer sessions that clearly indicate host validation is the only remaining gate are auto-promoted to `Status: validation` to avoid worker/reviewer churn.
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
  "currentSubtask": "Finish reviewer closeout and validation handoff",
  "nextAction": "Set Validation-Ready and hand off to validation lane",
  "stateDelta": {
    "completedWork": [
      "Implemented acceptance criteria 1 and 2"
    ],
    "acceptedFacts": [
      "verify:fast passed after worker edits"
    ],
    "decisions": [
      "Kept public API unchanged"
    ],
    "openQuestions": [],
    "pendingActions": [
      "Run host-required validation"
    ],
    "recentResults": [
      "Worker stage completed"
    ],
    "artifacts": [
      "docs/ops/automation/runtime/state/example-plan/latest.json"
    ],
    "risks": [],
    "reasoning": {
      "nextAction": "Run host-required validation",
      "blockers": [],
      "rationale": [
        "Implementation scope is complete"
      ]
    },
    "evidence": {
      "artifactRefs": [],
      "extractedFacts": [],
      "logRefs": [],
      "validationRefs": []
    }
  },
  "contextRemaining": 2100,
  "contextWindow": 128000,
  "contextUsedRatio": 0.9836,
  "reason": "optional detail",
  "blockerKey": "optional-stable-blocker-id",
  "evidenceAction": "upsert"
}
```
