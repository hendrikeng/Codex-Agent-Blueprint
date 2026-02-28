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

## CLI

- `node ./scripts/automation/orchestrator.mjs run --mode guarded`
- `node ./scripts/automation/orchestrator.mjs resume`
- `node ./scripts/automation/orchestrator.mjs audit --json true`
- `node ./scripts/automation/orchestrator.mjs curate-evidence [--scope active|completed|all] [--plan-id <value>]`
- Optional continuation controls:
  - `--max-sessions-per-plan <n>` (default `20`)
  - `--max-rollovers <n>` (default `5`)

## Executor Configuration

- `executor.command` in `docs/ops/automation/orchestrator.config.json` is required for `run`/`resume`.
- Set this once per repository (default here is Codex non-interactive).
- If empty, `run`/`resume` fail immediately with a clear error.
- Example (`orchestrator.config.json`):
  - `"command": "codex exec --full-auto \"Continue plan {plan_id} in {plan_file}. Apply the next concrete step. Update the plan document with progress and evidence. Reuse existing evidence files when blocker state is unchanged; update canonical evidence index/readme links instead of creating new timestamped evidence files. Write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and contextRemaining. If all acceptance criteria and required validations are complete, set top-level Status: completed; otherwise keep top-level Status: in-progress and list remaining work.\""`
- Validation lanes:
  - `validation.always`: sandbox-safe checks run before completion.
  - `validation.hostRequired`: Docker/port/browser checks required before completion.
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
- Do not use plain `"codex"` (interactive mode will block orchestration).

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
- To prevent evidence/file spam loops, executor sessions that do not emit a structured result payload (`ORCH_RESULT_PATH`) are deferred after one pass.
- If host-required validations cannot run in the current environment, orchestration keeps the plan `in-progress`, records a host-validation pending reason, and continues with other executable plans.
- When a plan completes, `Done-Evidence` points to its canonical evidence index file.
- During curation, removed evidence paths are automatically rewritten in plan docs to the retained canonical reference.

Optional result payload (path from `ORCH_RESULT_PATH`):

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
