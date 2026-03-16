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
- `Validation-Lanes` (required for compiled child slices with `Parent-Plan-ID`; values: `always`, `host-required`, or both)
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
- `## Validation Contract`: required for compiled child slices so validation lanes map to explicit configured validation IDs.

Reconciliation lowers omission and stale-scope risk, but it does not replace planner or reviewer judgment.
Compiled child slices are owned in three bands: compiler-generated contract sections, a preserved `## Planner Overlay`, and execution-updated status/evidence/closure sections.
When compiled child slices live under `docs/future/`, they also remain subject to the future blueprint requirements documented in `docs/future/README.md`.

## Delivery Semantics

- `Delivery-Class: product` means the plan must land shipped product behavior before validation/completion.
- `Delivery-Class: docs`, `ops`, and `reconciliation` allow artifact-first completion when the acceptance criteria are truthful.
- `Execution-Scope: slice` means the plan is directly executable by orchestration.
- `Execution-Scope: program` means the plan is a non-executable parent contract or portfolio. Keep it active while child slices execute; do not send it directly to validation.
- Future and active program parents must declare `Authoring-Intent`.
- `Authoring-Intent: executable-default` requires `## Child Slice Definitions`; orchestration/compiler turns those definitions into child slice plans deterministically.
- `Authoring-Intent: blueprint-only` is draft-only future state and must not be promoted or compiled.
- Legacy `## Remaining Execution Slices` / `## Portfolio Units` headings are migration-only discovery hints. They do not enable automatic child generation, and `plans:scaffold-children` refuses them so `plans:migrate` remains the one clean migration path.
- `Implementation-Targets` are the authoritative code roots for product slices. `Spec-Targets` remain the broader impact/documentation list and do not replace implementation evidence.
- `Validation-Lanes` and `## Validation Contract` tie each compiled child slice to explicit configured validation IDs instead of inferred command text.
- `## Capability Proof Map` maps must-land IDs to capability claims and proof rows. Proof rows should reference explicit validation IDs or artifact paths, not inferred test names.

## Status Conventions

- Active plan statuses: `queued`, `in-progress`, `blocked`, `validation`, `completed`, `failed`.
- Completed plan status: `completed`.

## Workflow

1. Use `active/` as the execution entrypoint for both promoted future blueprints and direct quick/manual fixes.
2. For program parents with structured child definitions, materialize or refresh compiled children with `npm run plans:compile`.
3. Validate plan metadata with `npm run plans:verify`.
4. Execute one plan at a time with isolated context/session.
5. Move completed plans to `completed/` with closure notes and validation evidence.
6. Keep current, high-signal active evidence under `docs/exec-plans/active/evidence/`.
7. Point `Done-Evidence` to canonical references under `evidence-index/`.
8. Keep tech debt references current.

Do not use weak acceptance wording such as `at minimum`. If a plan needs staged delivery, keep the current plan's concrete work in `## Must-Land Checklist` and move everything else into `## Deferred Follow-Ons`. For future blueprints and strategic phase plans, classify relevant historical completed plans in `## Prior Completed Plan Reconciliation` before promotion or validation.
