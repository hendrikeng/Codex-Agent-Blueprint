# Eval Policy

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Eval Lifecycle

- Define a stable set of golden tasks that represent high-risk and high-value workflows.
- Maintain a dedicated continuity suite that interrupts work mid-task and scores resume quality from checkpoint/contact-pack state only.
- Track pass/fail outcomes per model/runtime change.
- Treat eval regressions as defects, not documentation-only issues.

## Failure Taxonomy

- `hallucination`: output invents facts or behavior.
- `policy_violation`: output or action breaks explicit policy.
- `tool_misuse`: invalid tool choice, sequence, or parameter use.
- `workflow_incomplete`: task stops before required completion criteria.

## Release Gates

- No known high-severity regressions in golden tasks.
- New high-severity failure classes block release until mitigated or explicitly accepted in writing.
- Changes to critical flows require updated eval coverage in the same change.
- Continuity fixture suite must pass before merge; continuity dogfood runs are reported when configured but are not required for local template verification.

## Generated Artifact Contract

- Config source of truth: `docs/agent-hardening/evals.config.json`.
- Generated report artifact: `docs/generated/evals-report.json`.
- Continuity detail artifact: generated locally by `npm run eval:continuity`.
- Verifier command: `npm run eval:verify`.
- Continuity runner command: `npm run eval:continuity`.
- Required report fields:
  - `generatedAtUtc`
  - `summary.total`, `summary.passed`, `summary.failed`, `summary.passRate`
  - `regressions.criticalOpen`, `regressions.highOpen`
  - `suites[]` with `id`, `status`, `total`, `passed`, `failed`
  - `evidence[]` repository-local references
- Gate policy:
  - Report freshness must satisfy `maxAgeDays`.
  - Pass-rate must satisfy `minimumPassRate`.
  - Open critical/high regressions must be at or below configured maximums.
  - Required suite IDs/statuses must be present and valid.
- Continuity gate policy:
  - Fixture scenarios score correctness, context carryover, duplicate-work avoidance, and handoff quality.
  - Continuity report freshness must satisfy `maxAgeDays`.
  - Continuity pass-rate must satisfy `continuityMinimumPassRate`.
  - Required continuity suite IDs/statuses must be present and valid.
