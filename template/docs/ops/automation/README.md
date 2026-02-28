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
  - `"command": "node ./scripts/automation/executor-wrapper.mjs --plan-id {plan_id} --plan-file {plan_file} --run-id {run_id} --mode {mode} --session {session} --result-path {result_path}"`
  - `"provider": "codex"` (override per run with `ORCH_EXECUTOR_PROVIDER=...`)
  - `"providers.codex.command": "codex exec --full-auto {prompt}"` (`{prompt}` is required)
  - `"contextThreshold": 10000`
  - `"requireResultPayload": true`
  - `executor.promptTemplate` is provider-agnostic and reused across Codex/Claude/Gemini/Grok adapters.
- Validation lanes:
  - `validation.always`: sandbox-safe checks that should run in every completion gate.
  - `validation.always` should include a unit/integration test command (framework-appropriate).
  - `validation.hostRequired`: Docker/port/browser checks required before completion.
  - `validation.hostRequired` should include infra/bootstrap commands plus host-dependent E2E/system tests.
  - `validation.hostRequired` must be set per repository for DB/search/browser-dependent plans; an empty list means host validation auto-passes.
  - `alwaysExamples` and `hostRequiredExamples` in `orchestrator.config.json` provide a starter baseline (`unit`, `infra`, `db migrate`, `e2e`) that should be replaced with repo-specific commands.
  - Framework mapping is repository-defined (`vitest`, `jest`, `playwright`, `pytest`, `go test`, etc.); lane intent is mandatory even when command names differ.
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
