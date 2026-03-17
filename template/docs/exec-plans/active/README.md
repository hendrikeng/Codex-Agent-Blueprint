# Active Plans

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: 2026-03-04
Source of Truth: This directory.

Place currently executing plans in this directory.

Each active plan must include:

- `## Metadata` section with required plan fields from `docs/exec-plans/README.md`.
- `Status` set to one of: `queued`, `in-progress`, `in-review`, `budget-exhausted`, `blocked`, `validation`.
- Explicit acceptance criteria before implementation begins.
- `## Must-Land Checklist` with the exact completion contract for the current plan.
- Product slices should prefix must-land items with stable backticked IDs.
- Scope separation via `## Already-True Baseline` and `## Deferred Follow-Ons` when the plan references broader target state.
- `Implementation-Targets`, `Risk-Tier`, `Validation-Lanes`, and `Security-Approval` kept current while the plan moves through the queue.

Active plan intent rules:

- One active file equals one executable slice.
- Use multiple active/future files linked by `Dependencies` when the broader effort needs several slices.
- Do not keep non-executable program parents in `active/`.
- `Delivery-Class: product` plans must declare non-doc `Implementation-Targets`.

## Session Retention

- Keep active plan and evidence session histories concise; retain only the newest 8 to 12 session entries in active files.
- Move older session detail into a linked archive file (for example `docs/exec-plans/active/evidence/<plan-id>-session-archive.md`).
- Avoid duplicating long session narratives in both active plan and active evidence files.
- If a slice is decision-complete and validated, move it to `completed/` instead of letting it linger in `active/`.

## Active Evidence

- Keep current evidence in `docs/exec-plans/active/evidence/README.md` and plan-specific files in the same directory.
- Retain only recent, decision-relevant sessions in active evidence; move older detail to `*-session-archive.md` files.
