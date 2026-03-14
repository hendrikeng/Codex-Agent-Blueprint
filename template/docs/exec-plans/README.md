# Execution Plans

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Directory Layout

- `docs/exec-plans/active/`
- `docs/exec-plans/active/evidence/`
- `docs/exec-plans/completed/`
- `docs/exec-plans/evidence-index/`
- `docs/exec-plans/tech-debt-tracker.md`

## Plan Metadata Header

Every plan in `active/` and `completed/` must include `## Metadata` with:

- `Plan-ID`
- `Status`
- `Priority`
- `Owner`
- `Acceptance-Criteria`
- `Dependencies`
- `Spec-Targets`
- `Done-Evidence`

Optional fields:

- `Autonomy-Allowed` (`guarded` | `full` | `both`)
- `Risk-Tier` (`low` | `medium` | `high`)
- `Tags` (comma-separated routing hints such as `payments`, `security`, `migration`)
- `Security-Approval` (`not-required` | `pending` | `approved`)

Every executable plan must also include:

- `## Must-Land Checklist`: markdown checkboxes for the exact deliverables this plan must land before validation/completion.
- `## Already-True Baseline`: facts that are already true before the plan starts.
- `## Deferred Follow-Ons`: broader target state or later-phase items that are intentionally not part of this plan's completion gate.
- `## Prior Completed Plan Reconciliation`: required for future blueprints and strategic active phase plans so overlapping completed plans are classified instead of silently assumed.

Reconciliation lowers omission and stale-scope risk, but it does not replace planner or reviewer judgment.

## Status Conventions

- Active plan statuses: `queued`, `in-progress`, `blocked`, `validation`, `completed`, `failed`.
- Completed plan status: `completed`.

## Workflow

1. Use `active/` as the execution entrypoint for both promoted future blueprints and direct quick/manual fixes.
2. Validate plan metadata with `npm run plans:verify`.
3. Execute one plan at a time with isolated context/session.
4. Move completed plans to `completed/` with closure notes and validation evidence.
5. Keep current, high-signal active evidence under `docs/exec-plans/active/evidence/`.
6. Point `Done-Evidence` to canonical references under `evidence-index/`.
7. Keep tech debt references current.

Do not use weak acceptance wording such as `at minimum`. If a plan needs staged delivery, keep the current plan's concrete work in `## Must-Land Checklist` and move everything else into `## Deferred Follow-Ons`. For future blueprints and strategic phase plans, classify relevant historical completed plans in `## Prior Completed Plan Reconciliation` before promotion or validation.
