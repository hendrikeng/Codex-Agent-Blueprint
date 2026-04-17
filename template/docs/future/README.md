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
- `Delivery-Class` (`product` | `docs` | `ops` | `reconciliation`)
- `Dependencies` (comma-separated Plan-IDs or `none`)
- `Spec-Targets` (comma-separated paths)
- `Implementation-Targets` for `Delivery-Class: product`
- `Risk-Tier` (`low` | `medium` | `high`)
- `Validation-Lanes` (`always` or `always, host-required`)
- `Security-Approval` (`not-required` | `pending` | `approved`) when applicable
- `Done-Evidence` (`pending` until completed)

Each future blueprint must also include these scoped execution sections:

- `## Already-True Baseline`
- `## Must-Land Checklist`
- `## Deferred Follow-Ons`

Optional metadata:

- `Tags` (comma-separated risk hints such as `payments`, `security`, `migration`)

## Future Intake Gate (Minimal)

Create or update a future blueprint as `Status: draft` only when these checks pass:

- [ ] `Plan-ID` is lowercase kebab-case and unique.
- [ ] Problem, scope, and non-goals are explicit.
- [ ] `Acceptance-Criteria` are concrete and testable.
- [ ] `Acceptance-Criteria` describe full completion for this plan and do not use weak language such as `at minimum`.
- [ ] `Delivery-Class` is explicit; do not rely on titles like `phase`, `future`, or `blueprint` to communicate intent.
- [ ] `Dependencies` are complete (`none` when not applicable).
- [ ] `Risk-Tier` is set correctly (`low` | `medium` | `high`) when applicable.
- [ ] `Spec-Targets` reference canonical docs/files.
- [ ] Product slices declare non-doc `Implementation-Targets`.
- [ ] `Done-Evidence` is `pending`.
- [ ] `## Must-Land Checklist` exists and every checkbox item is executable within one promoted plan.
- [ ] `## Already-True Baseline` and `## Deferred Follow-Ons` keep non-plan scope out of the must-land checklist.
- [ ] If the ask expands into multiple executable units, split it into multiple future files linked by `Dependencies`.
- [ ] `npm run plans:verify` passes.

## Promotion Gate (`draft` -> `ready-for-promotion`)

Set `Status: ready-for-promotion` only when these checks pass:

- [ ] At least one executable slice is defined with clear entry and exit criteria.
- [ ] `## Must-Land Checklist` is the exact completion contract for the promoted plan.
- [ ] Open questions/blockers are either resolved or explicitly listed.
- [ ] Validation path is clear (`verify:fast` during implementation, `verify:full` before completion).
- [ ] Owner and responsibility are explicit.
- [ ] `Security-Approval` is set correctly when required.
- [ ] No placeholder text remains in the blueprint.
- [ ] `npm run plans:verify` passes.

## Coverage and Depth Rule

For high-risk multi-phase programs:

- All phase files should be coverage-complete before implementation starts.
- Coverage-complete means scope, non-goals, dependencies, validation, risks, and handoff boundaries are explicit enough that nothing major is left floating.
- Only the next one or two phases should be fully decision-complete and promotion-ready.
- Later phases may stay lighter where implementation detail should wait for earlier learnings.
- Do not compensate for uncertainty by making every future file huge; add detail where it removes real execution ambiguity.

## Promotion Rules

1. `draft` stays in `docs/future/`.
2. `ready-for-promotion` is eligible for automation promotion into `docs/exec-plans/active/`.
3. Once promoted, the blueprint file is moved from `docs/future/` into `docs/exec-plans/active/`.

## Future Authoring Rule

Use one future file per executable slice.

- If the user asks for a single implementable change, create one future slice.
- If the user describes a broader effort, create multiple future slices and link them with `Dependencies`.
- Use a plain roadmap or notes document for grouping if needed, but do not put grouping documents into the execution queue.
- For high-risk architecture programs, define the full phase set first, then deepen the next executable phases before promotion.
