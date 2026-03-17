# Lite Quickstart

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Use this as the canonical reference for how the harness is intended to work day to day.
`Lite` here means a flat, low-overhead control plane, not a manual-only workflow.

## Default Operating Loop

This is the intended default:

1. Plan futures in plan mode.
2. Create or update executable future slices in `docs/future/` immediately as the user decides what should be built.
3. Use one future file per executable slice.
4. Split broader efforts into multiple future files linked by `Dependencies`.
5. Set `Status: ready-for-promotion` when a future slice is decision-complete.
6. Let `automation:run`, `automation:resume`, or `automation:grind` promote ready futures and work the queue in sequence.
7. Validate, commit the slice atomically, curate evidence, and move finished work to `docs/exec-plans/completed/`.

## Planning Rules

- Planning-only requests should not edit product code or tests.
- Every future slice must keep `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons` separate.
- `## Must-Land Checklist` is the exact execution contract for promotion and grind.
- Keep `Implementation-Targets`, `Risk-Tier`, `Validation-Lanes`, and `Security-Approval` explicit.
- Do not reintroduce program parents, child-plan generation, or a second orchestration layer.

## Grind Rules

- `low` risk: `worker`
- `medium` risk: `worker -> reviewer`
- `high` risk: `worker -> reviewer`, plus explicit `Security-Approval`
- Low-context sessions should hand off cleanly before they run into the edge of the context window.
- The next agent should continue from the current plan, latest checkpoint, latest handoff, runtime context, and only the evidence relevant to that slice.

## Manual Exception

Use a direct active plan only when all of these are true:

- The task is tiny and low risk.
- The work does not need staged future planning.
- The same metadata, verification, and closure rules are still followed.

## Required Commands

- `npm run context:compile`
- `npm run plans:verify`
- `npm run verify:fast`
- `npm run verify:full`
- `npm run automation:run -- --max-risk low|medium|high`
- `npm run automation:resume -- --max-risk low|medium|high`
- `npm run automation:grind -- --max-risk low|medium|high`
- `npm run automation:audit`
- If you omit `--max-risk`, the package scripts use the repo's configured default risk ceiling. The template default is `high`.

## Non-Negotiables

- Plan in futures first unless the task is truly tiny.
- Promote only decision-complete futures.
- Keep the queue flat: `future -> active -> completed`.
- Preserve strong validation and evidence.
- Preserve low-context handoff discipline.
- Optimize for low token waste, not orchestration cleverness.

## Reference Docs

- `docs/PLANS.md`
- `docs/future/README.md`
- `docs/exec-plans/README.md`
- `docs/ops/automation/README.md`
- `docs/ops/automation/ROLE_ORCHESTRATION.md`
