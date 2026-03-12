# Planning Workflow

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document delegates to `docs/exec-plans/README.md`.

Use execution plans for all implemented changes so intent, decisions, and rollout state stay discoverable.

## Work Classes

Use `docs/future/` before execution when any of these are true:

- The change spans multiple domains, apps, or deployment steps.
- The change affects architecture boundaries or critical invariants.
- The implementation is expected to span multiple pull requests.
- The rollout risk is medium/high and benefits from staged promotion.

Use direct `docs/exec-plans/active/` entry for quick/manual fixes when all of these are true:

- The change is isolated and low risk.
- No architecture boundary or critical invariant changes are required.
- The work can complete as one focused slice while preserving full plan metadata/evidence.

Examples:

- `future required`: major feature slice, migration, cross-cutting refactor.
- `direct active allowed`: isolated UI color tweak, contained bug fix, minor copy/label update.

## Lifecycle

1. Strategic/non-trivial path: draft in `docs/future/` and set readiness (`draft` -> `ready-for-promotion`), then promote into `docs/exec-plans/active/` (normally via orchestrator).
   Use the Future Intake Gate and Promotion Gate in `docs/future/README.md` before setting `Status: ready-for-promotion`.
2. Quick/manual path: create the plan directly in `docs/exec-plans/active/` with complete metadata.
3. Record decisions and acceptance criteria before implementation.
4. Split plan text into three explicit scopes before implementation:
   `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons`.
   Future blueprints must also include `## Master Plan Coverage` or `## Capability Coverage Matrix`, plus `## Promotion Blockers`, so upstream strategy and unresolved gates are explicit.
5. Implement the smallest safe slice and update tests/docs in the same change.
6. Validate plan metadata with `npm run plans:verify`.
7. During implementation, run `npm run verify:fast`.
8. Before merge/completion, run `npm run verify:full` plus relevant domain tests.
9. Complete by moving to `docs/exec-plans/completed/` with concise summary/closure and canonical `Done-Evidence` index references.

Orchestration is the default execution driver. Manual execution is valid only if it preserves status transitions, metadata integrity, and evidence/index curation behavior.

## Plan-Only Requests

When the user asks for planning only (no implementation yet):

1. Update or create the blueprint in `docs/future/`.
2. Do not edit source/test/runtime files.
3. Make `## Must-Land Checklist` the exact executable contract for the future promotion.
4. Add `## Master Plan Coverage` or `## Capability Coverage Matrix` so nothing from upstream strategy is silently omitted.
5. Add `## Promotion Blockers` so the remaining gates to safe promotion are explicit.
6. Set `Status: ready-for-promotion` when the plan is implementation-ready.

This also applies when the agent/session is explicitly set to plan mode: default to `docs/future` planning outputs until implementation is explicitly requested.

## Structure

- `docs/exec-plans/README.md`
- `docs/exec-plans/active/README.md`
- `docs/exec-plans/completed/README.md`
- `docs/exec-plans/tech-debt-tracker.md`
