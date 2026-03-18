# Role Orchestration

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Define the runtime role model for execution plans so low-risk work stays fast and medium/high-risk work gets an explicit review gate.

## Roles

- `planner`: planning-time only. Used in direct Codex sessions to turn intent into decision-complete future slices.
- `explorer`: planning-time only. Used in direct Codex sessions for focused investigation before implementation.
- `worker`: executes code and documentation changes.
- `reviewer`: validates correctness, security, race conditions, flaky-test risk, performance regressions, and missing-scope omissions in the plan contract.

## Role Profiles

Each role has a portable execution profile, but only `worker` and `reviewer` participate in the queued grind runtime.

- `model`: preferred model for the role.
- `reasoningEffort`: expected depth (`low|medium|high`).
- `sandboxMode`: required tool/file access (`read-only` or `full-access`).
- `instructions`: role-specific operating instructions appended to executor prompt context.
- Planning-time roles may update future docs and notes, but the overnight grind does not schedule them.

Recommended baseline:

- `planner`: `gpt-5.4`, `medium` by default with `high` override for high-risk plans, `read-only`.
- `explorer`: fast model (`gpt-5.3-codex-spark`), `medium`, `read-only`.
- `worker`: `gpt-5.4`, `high`, `full-access`.
- `reviewer`: `gpt-5.4`, `high`, `read-only`.

## Risk Routing

- `low`: `worker`
- `medium`: `worker -> reviewer`
- `high`: `worker -> reviewer`
- Risk is explicit from plan metadata. The runtime does not derive hidden risk scores from path heuristics or child-plan state.

## Security Approval Gate

- Metadata field: `Security-Approval` (`not-required` | `pending` | `approved`).
- Required when effective risk is `high`.
- Required value to complete: `Security-Approval: approved`.

## Executor Contract

- Runtime executor receives:
  - `--role {role}`
  - `--plan-id {plan_id}`
  - `--plan-file {plan_file}`
  - `--result-path {result_path}`
- Environment variables:
  - `ORCH_ROLE`
  - `ORCH_PLAN_ID`
  - `ORCH_PLAN_FILE`
  - `ORCH_RESULT_PATH`
  - `ORCH_RUN_ID`
  - `ORCH_RUNTIME_CONTEXT_PATH`

Runtime prompts also include the current low-context handoff thresholds so the agent can stop before grinding into the edge of the window.
If a read-only sandbox prevents writing `ORCH_RESULT_PATH`, the provider must emit the equivalent single-line `{"type":"orch_result","payload":...}` stdout envelope instead.

## Provider Adapters

- Provider command templates must be non-interactive and must include `{prompt}`.
- Runtime profiles only need to cover `worker` and `reviewer`.
- Use non-interactive provider modes only.
- Provider adapters must map the portable `sandboxMode` profile onto the provider's native flag. For Codex, `full-access` maps to `--sandbox danger-full-access`.

## Operational Notes

- `Delivery-Class`, `Dependencies`, `Implementation-Targets`, `Risk-Tier`, and `Validation-Lanes` are required active/future metadata.
- `Delivery-Class: product` plans must declare `Implementation-Targets`; product completion evidence is measured against those roots rather than inferred from `Spec-Targets`.
- Completion gate opens when the plan is moved to `Status: validation` or `Status: completed`, depending on the runtime's chosen closeout flow.
- `## Must-Land Checklist` is the executable completion contract; validation/completion is blocked until every checkbox item is checked.
- If a plan also carries broader vision or target-state language, keep that scope in `## Already-True Baseline` and `## Deferred Follow-Ons` instead of treating it as implicitly complete.
- Reviewer sessions either approve the plan for validation or return concrete implementation follow-up for the next worker pass.
- For `medium` and `high` risk plans, `Status: in-review` is the authoritative handoff state between a completed worker slice and reviewer approval; the orchestrator moves the plan to `validation` after review approval.
- Worker/reviewer sessions should not run host-bound validation commands (infra/bootstrap, DB migrations, Playwright/E2E); those belong in `validation.hostRequired`.
- Worker/reviewer sessions should hand off early when remaining context drops under the configured low-watermark before the current role boundary is safely complete.
- Risk and stage decisions are recorded in `run-events.jsonl`.
