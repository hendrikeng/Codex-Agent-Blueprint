# Future Blueprints

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This directory.

Track future-state blueprints for intentionally staged strategic/non-trivial work that is not yet executing.
Quick/manual fixes should be tracked directly in `docs/exec-plans/active/` when future staging is unnecessary.

## Required Metadata

Each future blueprint must include a `## Metadata` section with:

- `Plan-ID`
- `Status` (`draft` | `ready-for-promotion`)
- `Priority` (`p0` | `p1` | `p2` | `p3`)
- `Owner`
- `Acceptance-Criteria`
- `Dependencies` (comma-separated Plan-IDs or `none`)
- `Spec-Targets` (comma-separated paths)
- `Done-Evidence` (`pending` until completed)

Optional metadata:

- `Autonomy-Allowed` (`guarded` | `full` | `both`)
- `Risk-Tier` (`low` | `medium` | `high`)
- `Tags` (comma-separated risk hints such as `payments`, `security`, `migration`)
- `Security-Approval` (`not-required` | `pending` | `approved`)

## Promotion Rules

1. `draft` stays in `docs/future/`.
2. `ready-for-promotion` is eligible for automation promotion into `docs/exec-plans/active/`.
3. Once promoted, the blueprint file is moved from `docs/future/` into `docs/exec-plans/active/`.
