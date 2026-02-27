# Automation Conveyor

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

This directory defines the autonomous planning-to-execution conveyor for overnight runs.

## Goals

- Promote ready future blueprints into executable plans.
- Run order: continue existing active queue first, then promote ready future blueprints.
- Execute one plan per isolated session with resumable handoffs.
- Record structured run traces for auditability.
- Move completed plans into `docs/exec-plans/completed/` with evidence.
- Update product state docs after completion.

## Runtime Files

- `docs/ops/automation/orchestrator.config.json`: executor and validation command configuration.
- `docs/ops/automation/run-state.json`: latest resumable queue and plan progress snapshot.
- `docs/ops/automation/run-events.jsonl`: append-only JSON line event log.
- `docs/ops/automation/handoffs/`: per-plan rollover handoff notes.
- `docs/ops/automation/runtime/`: per-run executor result payloads.

## CLI

- `node ./scripts/automation/orchestrator.mjs run --mode guarded`
- `node ./scripts/automation/orchestrator.mjs resume`
- `node ./scripts/automation/orchestrator.mjs audit --json true`

## Executor Configuration

- `executor.command` in `docs/ops/automation/orchestrator.config.json` is required for `run`/`resume`.
- Set this once per repository (default here is Codex non-interactive).
- If empty, `run`/`resume` fail immediately with a clear error.

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

Optional result payload (path from `ORCH_RESULT_PATH`):

```json
{
  "status": "completed",
  "summary": "Implemented acceptance criteria 1 and 2",
  "contextRemaining": 2100,
  "reason": "optional detail"
}
```
