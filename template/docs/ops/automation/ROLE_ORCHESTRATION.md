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
- `reviewer`: validates correctness, security, race conditions, flaky-test risk, performance regressions, and missing-scope omissions in the plan contract.

## Role Profiles

Each role has a portable execution profile configured in `roleOrchestration.roleProfiles`.

- `model`: preferred model for the role.
- `reasoningEffort`: expected depth (`low|medium|high`).
- `reasoningEffortByRisk`: optional per-risk override when one role should stay lighter for routine work but ramp up on high-risk plans.
- `sandboxMode`: required tool/file access (`read-only` or `full-access`).
- `instructions`: role-specific operating instructions appended to executor prompt context.
- `read-only` role stages may still update the active plan/evidence docs, but must not modify product/source code.

Recommended baseline:

- `explorer`: fast model (`gpt-5.3-codex-spark`), `medium`, `read-only`.
- `reviewer`: `gpt-5.4`, `high`, `read-only`.
- `planner`: `gpt-5.4`, `medium` by default with `high` override for high-risk plans, `read-only`.
- `worker`: `gpt-5.4`, `high`, `full-access`.

## Risk Routing

- `low`: `worker`
- `medium`: `planner -> worker -> reviewer`
- `high`: `planner -> explorer -> worker -> reviewer`
- Effective risk tier is computed from declared risk + score-based signals (dependencies, tags, sensitive path hints, prior validation failures, autonomy mode).
- Optional stage reuse can skip already-completed `planner`/`explorer` stages when plan shape and scope are unchanged within policy limits.
- `stageBudgetsSeconds` provides role-specific no-progress budget ceilings for `planner`, `explorer`, and `reviewer`.

## Security Approval Gate

- Metadata field: `Security-Approval` (`not-required` | `pending` | `approved`).
- Required when:
  - effective risk is `high`, or
  - effective risk is `medium` and sensitive tags/paths are detected.
- Required value to complete: `Security-Approval: approved`.
- When a guarded run is resumed with the matching env approval (`ORCH_APPROVED_MEDIUM=1` or `ORCH_APPROVED_HIGH=1`), orchestration may record `Security-Approval: approved` automatically before validation/final completion so resumed high-risk plans do not dead-end on a redundant manual metadata edit.

## Executor Contract

- Executor wrapper receives:
  - `--role {role}`
  - `--effective-risk-tier {effective_risk_tier}`
  - `--declared-risk-tier {declared_risk_tier}`
  - `--stage-index {stage_index}`
  - `--stage-total {stage_total}`
  - `--contact-pack-file {contact_pack_file}`
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

- Completion gate opens when the top-level plan `Status` is `completed`, or when `Status: validation` is paired with explicit `Validation-Ready`.
- `## Must-Land Checklist` is the executable completion contract; validation/completion is blocked until every checkbox item is checked.
- If a plan also carries broader vision or target-state language, keep that scope in `## Already-True Baseline` and `## Deferred Follow-Ons` instead of treating it as implicitly complete.
- Future blueprints should not promote unless `## Master Plan Coverage` or `## Capability Coverage Matrix` explicitly reconciles upstream strategy, `## Prior Completed Plan Reconciliation` classifies overlapping completed plans, and `## Promotion Blockers` makes remaining gates explicit.
- `Status: validation` is only admission-ready when `Validation-Ready` is explicit (`yes` or `host-required-only`); status alone is not enough for validation fast-path.
- Plans already in `Status: validation` skip planner/explorer/worker/reviewer sessions and run validation lanes directly on `resume` only when `Validation-Ready` is explicit.
- Optional metadata `Validation-Ready: host-required-only` (or `yes`) enables deterministic reviewer closeout promotion to validation.
- Reviewer closeout should set `Validation-Ready` and `Status: validation` in the same edit.
- If completion gates are not yet satisfied, orchestration restarts at `worker` stage and reruns required review.
- Reviewer sessions that clearly indicate host validation is the only remaining gate are auto-promoted to `Status: validation` to prevent worker/reviewer churn.
- Host-validation `pending` keeps plans in `Status: validation` so resume runs avoid implementation-role churn while waiting for host lane execution.
- `pending` session results do not auto-advance risk pipeline stages; reviewer `pending` is routed back to `worker`.
- Planner/explorer `pending` entries that clearly indicate implementation handoff (read-only or implementation-incomplete reasons) are auto-advanced to the next stage.
- Repeated identical `pending` signals for the same role fail fast to prevent no-progress loops.
- Worker `pending` sessions with no repository edits outside `docs/exec-plans/**` are auto-retried (bounded by `logging.workerNoTouchRetryLimit`, retry timeout controlled by `logging.workerRetryFirstTouchDeadlineSeconds`) before fail-fast pending. Plans whose scoped targets are limited to execution-plan/evidence docs treat those plan/evidence edits as meaningful worker progress instead of no-touch churn. If the session already starts with dirty implementation edits in the plan's target roots, the first-touch deadline is skipped for that continuation session only.
- Planner/explorer/reviewer same-role `pending` sessions fail fast when the role stage budget is exceeded, even if they only touched plan/evidence docs.
- Read-only roles fail fast after repeated same-role `pending` returns so wording drift cannot keep them in doc-only churn loops.
- Worker/reviewer sessions should not run host-bound validation commands (infra/bootstrap, DB migrations, Playwright/E2E); those are executed by the host-validation lane from `validation.hostRequired`.
- Risk and stage decisions are recorded in `run-events.jsonl`.
