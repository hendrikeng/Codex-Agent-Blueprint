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
- `docs/exec-plans/TECH-DEBT-TRACKER.md`

## Plan Metadata Header

Every plan in `active/` and `completed/` must include `## Metadata` with:

- `Plan-ID`
- `Status`
- `Priority`
- `Owner`
- `Acceptance-Criteria`
- `Delivery-Class`
- `Execution-Scope`
- `Dependencies`
- `Spec-Targets`
- `Done-Evidence`

Optional fields:

- `Implementation-Targets` (required for `Delivery-Class: product` plus `Execution-Scope: slice`; omit or set to `none` otherwise)
- `Parent-Plan-ID` (optional child-to-parent link for executable slices)
- `Autonomy-Allowed` (`guarded` | `full` | `both`)
- `Risk-Tier` (`low` | `medium` | `high`)
- `Tags` (comma-separated routing hints such as `payments`, `security`, `migration`)
- `Security-Approval` (`not-required` | `pending` | `approved`)

Every executable plan must also include:

- `## Must-Land Checklist`: markdown checkboxes for the exact deliverables this plan must land before validation/completion.
- `Delivery-Class: product` plus `Execution-Scope: slice` should prefix each must-land checkbox with a stable backticked ID such as `` `ml-example-capability` `` so proof coverage can map to explicit claims.
- `## Already-True Baseline`: facts that are already true before the plan starts.
- `## Deferred Follow-Ons`: broader target state or later-phase items that are intentionally not part of this plan's completion gate.
- `## Prior Completed Plan Reconciliation`: required for future blueprints and strategic active phase plans so overlapping completed plans are classified instead of silently assumed.
- `## Capability Proof Map`: required when semantic proof mode is `required`; recommended in advisory mode for product slices so must-land claims map to explicit proof obligations.

Reconciliation lowers omission and stale-scope risk, but it does not replace planner or reviewer judgment.

## Delivery Semantics

- `Delivery-Class: product` means the plan must land shipped product behavior before validation/completion.
- `Delivery-Class: docs`, `ops`, and `reconciliation` allow artifact-first completion when the acceptance criteria are truthful.
- `Execution-Scope: slice` means the plan is directly executable by orchestration.
- `Execution-Scope: program` means the plan is a non-executable parent contract or portfolio. Keep it active while child slices execute; do not send it directly to validation.
- When a program plan enumerates remaining execution slices or portfolio units, materialize those units as child plans in `future/`, `active/`, or `completed/` with `Parent-Plan-ID` before expecting grind/promotion to continue automatically.
- `Implementation-Targets` are the authoritative code roots for product slices. `Spec-Targets` remain the broader impact/documentation list and do not replace implementation evidence.
- `## Capability Proof Map` maps must-land IDs to capability claims and proof rows. Proof rows should reference explicit validation IDs or artifact paths, not inferred test names.

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
