# Execution Plans

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Directory Layout

- `docs/exec-plans/active/`
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

## Status Conventions

- Active plan statuses: `queued`, `in-progress`, `blocked`, `validation`, `completed`, `failed`.
- Completed plan status: `completed`.

## Workflow

1. Use `active/` as the execution entrypoint for both promoted future blueprints and direct quick/manual fixes.
2. Validate plan metadata with `npm run plans:verify`.
3. Execute one plan at a time with isolated context/session.
4. Move completed plans to `completed/` with closure notes and validation evidence.
5. Point `Done-Evidence` to canonical references under `evidence-index/`.
6. Keep tech debt references current.
