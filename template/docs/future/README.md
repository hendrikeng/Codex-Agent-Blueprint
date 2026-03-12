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

Each future blueprint must also include these scoped execution sections:

- `## Already-True Baseline`
- `## Must-Land Checklist`
- `## Deferred Follow-Ons`
- `## Master Plan Coverage` or `## Capability Coverage Matrix`
- `## Promotion Blockers`

Optional metadata:

- `Autonomy-Allowed` (`guarded` | `full` | `both`)
- `Risk-Tier` (`low` | `medium` | `high`)
- `Tags` (comma-separated risk hints such as `payments`, `security`, `migration`)
- `Security-Approval` (`not-required` | `pending` | `approved`)

## Future Intake Gate (Minimal)

Create or update a future blueprint as `Status: draft` only when these checks pass:

- [ ] `Plan-ID` is lowercase kebab-case and unique.
- [ ] Problem, scope, and non-goals are explicit.
- [ ] `Acceptance-Criteria` are concrete and testable.
- [ ] `Acceptance-Criteria` describe full completion for this plan and do not use weak language such as `at minimum`.
- [ ] `Dependencies` are complete (`none` when not applicable).
- [ ] `Risk-Tier` is set correctly (`low` | `medium` | `high`) when applicable.
- [ ] `Spec-Targets` reference canonical docs/files.
- [ ] `Done-Evidence` is `pending`.
- [ ] `## Must-Land Checklist` exists and every checkbox item is executable within one promoted plan.
- [ ] `## Already-True Baseline` and `## Deferred Follow-Ons` keep non-plan scope out of the must-land checklist.
- [ ] `## Master Plan Coverage` or `## Capability Coverage Matrix` explicitly maps upstream strategy/capabilities into `shipped now`, `this phase`, `later phase`, or `non-goal`.
- [ ] `## Promotion Blockers` lists the unresolved decisions, approvals, or external gates that still block safe promotion.
- [ ] `npm run plans:verify` passes.

## Promotion Gate (`draft` -> `ready-for-promotion`)

Set `Status: ready-for-promotion` only when these checks pass:

- [ ] At least one executable slice is defined with clear entry and exit criteria.
- [ ] `## Must-Land Checklist` is the exact completion contract for the promoted plan.
- [ ] `## Master Plan Coverage` or `## Capability Coverage Matrix` proves nothing from upstream strategy is silently omitted.
- [ ] `## Promotion Blockers` makes the remaining gating decisions explicit.
- [ ] Open questions/blockers are either resolved or explicitly listed.
- [ ] Validation path is clear (`verify:fast` during implementation, `verify:full` before completion).
- [ ] Owner and responsibility are explicit.
- [ ] `Security-Approval` is set correctly when required.
- [ ] No placeholder text remains in the blueprint.
- [ ] `npm run plans:verify` passes.

## Promotion Rules

1. `draft` stays in `docs/future/`.
2. `ready-for-promotion` is eligible for automation promotion into `docs/exec-plans/active/`.
3. Once promoted, the blueprint file is moved from `docs/future/` into `docs/exec-plans/active/`.
