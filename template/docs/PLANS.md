# Planning Workflow

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document delegates to `docs/exec-plans/README.md`.

Use execution plans for all implemented changes so intent, decisions, and rollout state stay discoverable.

The canonical workflow is:

1. Plan in `docs/future/`.
2. Make future slices decision-complete.
3. Promote and run ready futures through the flat queue in sequence.

## Work Classes

Use `docs/future/` before execution when any of these are true:

- The change spans multiple domains, apps, or deployment steps.
- The change affects architecture boundaries or critical invariants.
- The implementation is expected to span multiple pull requests.
- The rollout risk is medium/high and benefits from explicit promotion into the active queue.

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
5. Implement the smallest safe slice and update tests/docs in the same change.
6. Validate plan metadata with `npm run plans:verify`.
7. During implementation, run `npm run verify:fast`.
8. Before merge/completion, run `npm run verify:full` plus relevant domain tests.
9. Complete by moving to `docs/exec-plans/completed/` with concise summary/closure and canonical `Done-Evidence` index references.

Orchestration is the default execution driver for non-trivial queued work. Manual execution is valid only if it preserves status transitions, metadata integrity, and evidence/index curation behavior.

## Plan-Only Requests

When the user asks for planning only (no implementation yet):

1. Update or create the executable future slice in `docs/future/`.
2. Do not edit source/test/runtime files.
3. Stop once the future slice is decision-complete; do not continue into implementation just because the next coding step is obvious.
4. Make `## Must-Land Checklist` the exact executable contract for the future promotion.
5. Keep `Dependencies` explicit when the work depends on earlier slices.
6. Use separate future files instead of program parents when one ask expands into multiple executable slices.
7. Set `Status: ready-for-promotion` when the plan is implementation-ready.

This also applies when the agent/session is explicitly set to plan mode: default to `docs/future` planning outputs until implementation is explicitly requested. Planning completion is not execution approval.

## Multi-Phase Architecture Programs

For high-risk, multi-phase architecture work:

- Create one canonical target-state architecture doc.
- Create one future file per executable phase.
- Make all phases coverage-complete before implementation begins so major concerns are not forgotten.
- Make only the next one or two phases fully decision-complete before promotion.
- Keep distant phases lighter where exact implementation depends on earlier outcomes.
- Do not begin a high-risk phase until its future file names ownership boundaries, contracts, validation, and rollback or fallback expectations.

## Structure

- `docs/exec-plans/README.md`
- `docs/exec-plans/active/README.md`
- `docs/exec-plans/completed/README.md`
- `docs/exec-plans/TECH-DEBT-TRACKER.md`
