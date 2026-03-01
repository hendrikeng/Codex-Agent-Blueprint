# Automation Conveyor

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

This directory defines the autonomous planning-to-execution conveyor for overnight runs.

## Goals

- Promote ready future blueprints into executable plans.
- Promotion moves the blueprint file from `docs/future/` into `docs/exec-plans/active/`.
- Run order: continue existing active queue first, then promote ready future blueprints.
- Execute plans in repeated isolated sessions until done (bounded by session limits), with resumable handoffs.
- Record structured run traces for auditability.
- Move completed plans into `docs/exec-plans/completed/` with evidence.
- Update product state docs after completion.

## Runtime Files

- `docs/ops/automation/orchestrator.config.json`: executor and validation command configuration.
- `docs/ops/automation/run-state.json`: latest resumable queue and plan progress snapshot.
- `docs/ops/automation/run-events.jsonl`: append-only JSON line event log.
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

## CLI

- `node ./scripts/automation/orchestrator.mjs run --mode guarded`
- `node ./scripts/automation/orchestrator.mjs resume`
- `node ./scripts/automation/orchestrator.mjs audit --json true`
- `node ./scripts/automation/orchestrator.mjs curate-evidence [--scope active|completed|all] [--plan-id <value>]`
- Optional continuation controls:
  - `--max-sessions-per-plan <n>` (default `20`)
  - `--max-rollovers <n>` (default `20`)

## Executor Configuration

- `executor.command` in `docs/ops/automation/orchestrator.config.json` is required for `run`/`resume`.
- Set this once per repository; default is the portable `executor-wrapper` entrypoint.
- If empty, `run`/`resume` fail immediately with a clear error.
- Example (`orchestrator.config.json`):
  - `"command": "node ./scripts/automation/executor-wrapper.mjs --plan-id {plan_id} --plan-file {plan_file} --run-id {run_id} --mode {mode} --session {session} --role {role} --effective-risk-tier {effective_risk_tier} --declared-risk-tier {declared_risk_tier} --stage-index {stage_index} --stage-total {stage_total} --result-path {result_path}"`
  - `"provider": "codex"` (override per run with `ORCH_EXECUTOR_PROVIDER=...`)
  - `"providers.codex.command": "codex exec --full-auto {prompt}"` (`{prompt}` is required)
  - `"contextThreshold": 10000`
  - `"requireResultPayload": true`
  - `executor.promptTemplate` is provider-agnostic and reused across Codex/Claude/Gemini/Grok adapters.
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
  - `roleOrchestration.riskModel` computes an effective risk tier from declared risk, dependencies, tags, scope paths, and prior validation failures.
  - `roleOrchestration.approvalGates` enforces Security Ops approval for high-risk completions and sensitive medium-risk completions.
  - `roleOrchestration.providers.<provider>.roles.<role>.command` can override provider command templates by role.
  - Role command templates can use profile placeholders:
    - `{role_model}`
    - `{role_reasoning_effort}`
    - `{role_sandbox_mode}`
    - `{role_instructions}`
  - Detailed role contract: `docs/ops/automation/ROLE_ORCHESTRATION.md`.
- Validation lanes:
  - `validation.always`: sandbox-safe checks that should run in every completion gate.
  - `validation.always` should include a unit/integration test command (framework-appropriate).
  - `validation.hostRequired`: Docker/port/browser checks required before completion.
  - `validation.hostRequired` should include infra/bootstrap commands plus host-dependent E2E/system tests.
  - Executors should not run `validation.hostRequired` commands inline; completion gating runs them via host validation providers (`ci`/`local`).
  - `validation.hostRequired` must be set per repository for DB/search/browser-dependent plans; an empty list means host validation auto-passes.
  - `alwaysExamples` and `hostRequiredExamples` in `orchestrator.config.json` provide a starter baseline (`unit`, `infra`, `db migrate`, `e2e`) that should be replaced with repo-specific commands.
  - Framework mapping is repository-defined (`vitest`, `jest`, `playwright`, `pytest`, `go test`, etc.); lane intent is mandatory even when command names differ.
  - For Playwright web-server tests, bind dev server explicitly to loopback (`127.0.0.1`/`localhost`) and keep the e2e command in `validation.hostRequired`.
  - `validation.host.mode`: `ci`, `local`, or `hybrid` (default).
  - `validation.host.ci.command`: optional command that performs CI-dispatched host validation.
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
- Do not use provider interactive modes (they will block orchestration); use non-interactive CLI flags in provider commands.

## Plan File Naming

- Active plan files are date-prefixed by creation date: `YYYY-MM-DD-<plan-id>.md`.
- Completed plan files are date-prefixed by completion date: `YYYY-MM-DD-<plan-id>.md`.
- Legacy files without a date prefix are allowed; new automation promotions/completions use date-prefixed naming.
- This naming convention applies to plan files in `active/` and `completed/` only.
- Evidence artifacts may use step-prefixed files (`01-...md`) and date-prefixed folders (`YYYY-MM-DD-...`).

## Policy Controls

- `guarded` mode blocks medium/high risk plans unless explicitly approved.
- `full` mode is allowed only when `ORCH_ALLOW_FULL_AUTONOMY=1`.
- Medium/high approvals in full mode require:
  - `ORCH_APPROVED_MEDIUM=1`
  - `ORCH_APPROVED_HIGH=1`
- Effective risk tier is the max of declared risk and computed risk model output.
- Security approval gate is required when:
  - effective risk is `high`, or
  - effective risk is `medium` with sensitive tag/path hits.

Common run invocations:

- Default guarded run: `npm run automation:run -- --mode guarded`
- Medium-risk approved run: `ORCH_APPROVED_MEDIUM=1 npm run automation:run -- --mode guarded`
- High-risk approved run: `ORCH_APPROVED_HIGH=1 npm run automation:run -- --mode guarded`
- Provider override: `ORCH_EXECUTOR_PROVIDER=claude npm run automation:run -- --mode guarded`

## Exit Conventions

Executor commands should use these outcomes:

- Exit code `0`: success (or write result status `completed`).
- Exit code `75`: request session rollover/handoff.
- Non-zero other than `75`: fail execution.
- A plan is auto-moved to `docs/exec-plans/completed/` only when its top-level `Status:` line is `completed`.
- If the top-level `Status:` is not `completed`, orchestration starts another executor session for the same plan in the same run (up to `--max-sessions-per-plan`), then leaves it in `active/` for later `resume` if still incomplete.
- Executor sessions must always emit a structured result payload (`ORCH_RESULT_PATH`) with a numeric `contextRemaining`.
- Default context rollover policy is proactive: a new session is forced when `contextRemaining <= 10000` (override with `--context-threshold` or `executor.contextThreshold`).
- If an executor exits `0` without payload (or without numeric `contextRemaining`), orchestrator forces an immediate handoff/rollover to protect coding accuracy.
- If host-required validations cannot run in the current environment, orchestration keeps the plan `in-progress`, records a host-validation pending reason, and continues with other executable plans.
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
