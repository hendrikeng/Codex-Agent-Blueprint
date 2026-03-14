# Active Plans

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: 2026-03-04
Source of Truth: This directory.

Place active non-trivial plans in this directory.

Each active plan must include:

- `## Metadata` section with required plan fields from `docs/exec-plans/README.md`.
- `Status` set to one of: `queued`, `in-progress`, `blocked`, `validation`, `completed`, `failed`.
- Explicit acceptance criteria before implementation begins.
- `## Must-Land Checklist` with the exact completion contract for the current plan.
- Scope separation via `## Already-True Baseline` and `## Deferred Follow-Ons` when the plan references broader target state.
- `## Prior Completed Plan Reconciliation` when the active plan is a strategic phase or other major current-state reset that overlaps earlier completed plans.

## Session Retention

- Keep active plan and evidence session histories concise; retain only the newest 8 to 12 session entries in active files.
- Move older session detail into a linked archive file (for example `docs/exec-plans/active/evidence/<plan-id>-session-archive.md`).
- Avoid duplicating long session narratives in both active plan and active evidence files.
- If a milestone has quantitative exit criteria and those criteria are met, mark it completed and proceed to the next milestone.


## Active Evidence

- Keep current evidence in `docs/exec-plans/active/evidence/README.md` and plan-specific files in the same directory.
- Retain only recent, decision-relevant sessions in active evidence; move older detail to `*-session-archive.md` files.
