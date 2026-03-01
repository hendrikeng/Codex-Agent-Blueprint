# Role Orchestration

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Define deterministic role routing for execution plans so low-risk work stays fast and medium/high-risk work gets additional safeguards.

## Roles

- `planner`: turns acceptance criteria into concrete implementation steps, identifies irreversible decisions, and updates sequencing.
- `explorer`: performs focused repository/dependency reconnaissance for risky areas before implementation.
- `worker`: executes code and documentation changes.
- `reviewer`: validates correctness, security, race conditions, flaky-test risk, and performance regressions.

## Role Profiles

Each role has a portable execution profile configured in `roleOrchestration.roleProfiles`.

- `model`: preferred model for the role.
- `reasoningEffort`: expected depth (`low|medium|high`).
- `sandboxMode`: required tool/file access (`read-only` or `full-access`).
- `instructions`: role-specific operating instructions appended to executor prompt context.

Recommended baseline:

- `explorer`: fast model (`gpt-5.3-codex-spark`), `medium`, `read-only`.
- `reviewer`: `gpt-5.3-codex`, `high`, `read-only`.
- `planner`: `gpt-5.3-codex`, `high`, `read-only`.
- `worker`: `gpt-5.3-codex`, `high`, `full-access`.

## Risk Routing

- `low`: `worker`
- `medium`: `planner -> worker -> reviewer`
- `high`: `planner -> explorer -> worker -> reviewer`
- Effective risk tier is computed from declared risk + score-based signals (dependencies, tags, sensitive path hints, prior validation failures, autonomy mode).

## Security Approval Gate

- Metadata field: `Security-Approval` (`not-required` | `pending` | `approved`).
- Required when:
  - effective risk is `high`, or
  - effective risk is `medium` and sensitive tags/paths are detected.
- Required value to complete: `Security-Approval: approved`.

## Executor Contract

- Executor wrapper receives:
  - `--role {role}`
  - `--effective-risk-tier {effective_risk_tier}`
  - `--declared-risk-tier {declared_risk_tier}`
  - `--stage-index {stage_index}`
  - `--stage-total {stage_total}`
- Environment variables:
  - `ORCH_ROLE`
  - `ORCH_ROLE_MODEL`
  - `ORCH_ROLE_REASONING_EFFORT`
  - `ORCH_ROLE_SANDBOX_MODE`
  - `ORCH_ROLE_INSTRUCTIONS`
  - `ORCH_EFFECTIVE_RISK_TIER`
  - `ORCH_DECLARED_RISK_TIER`
  - `ORCH_STAGE_INDEX`
  - `ORCH_STAGE_TOTAL`

## Provider Adapters

- Default command resolution:
  - `roleOrchestration.providers.<provider>.roles.<role>.command`
  - fallback to `executor.providers.<provider>.command`
- Provider-specific profile overrides can be set via:
  - `roleOrchestration.providers.<provider>.roleProfiles.<role>`
- Command templates can consume:
  - `{role_model}`, `{role_reasoning_effort}`, `{role_sandbox_mode}`, `{role_instructions}`
- Provider command templates must include `{prompt}`.
- Use non-interactive provider modes only.

## Operational Notes

- If completion gates are not yet satisfied, orchestration restarts at `worker` stage and reruns required review.
- Worker/reviewer sessions should not run host-bound validation commands (infra/bootstrap, DB migrations, Playwright/E2E); those are executed by the host-validation lane from `validation.hostRequired`.
- Risk and stage decisions are recorded in `run-events.jsonl`.
