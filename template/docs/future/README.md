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
- `Execution-Scope` (`slice` | `program`)
- `Dependencies` (comma-separated Plan-IDs or `none`)
- `Spec-Targets` (comma-separated paths)
- `Done-Evidence` (`pending` until completed)

Each future blueprint must also include these scoped execution sections:

- `## Already-True Baseline`
- `## Must-Land Checklist`
- `## Deferred Follow-Ons`
- `## Master Plan Coverage` or `## Capability Coverage Matrix`
- `## Prior Completed Plan Reconciliation`
- `## Promotion Blockers`

Future `Execution-Scope: program` blueprints with `Authoring-Intent: executable-default` must also include `## Child Slice Definitions`. Each child definition should declare the child plan ID in the `###` heading plus `Title`, `Dependencies`, `Spec-Targets`, `Implementation-Targets` for product slices, `Validation-Lanes`, `#### Must-Land Checklist`, `#### Already-True Baseline`, `#### Deferred Follow-Ons`, and `#### Capability Proof Map` for product slices.

Optional metadata:

- `Implementation-Targets` (required for `Delivery-Class: product` plus `Execution-Scope: slice`; omit or set to `none` otherwise)
- `Authoring-Intent` (required for future `Execution-Scope: program`; values: `executable-default` or `blueprint-only`)
- `Parent-Plan-ID` (optional when the future blueprint is a child slice under a parent program)
- `Autonomy-Allowed` (`guarded` | `full` | `both`)
- `Risk-Tier` (`low` | `medium` | `high`)
- `Tags` (comma-separated risk hints such as `payments`, `security`, `migration`)
- `Security-Approval` (`not-required` | `pending` | `approved`)

For `Delivery-Class: product` plus `Execution-Scope: slice`, prefer adding stable must-land IDs and `## Capability Proof Map` during blueprinting even while semantic proof mode is still advisory. That keeps promotion and later validation machine-checkable without relying on test-name heuristics.
Compiled child slices inherit parent defaults for priority/owner/delivery/risk/autonomy/security, then add generated `Validation-Lanes` and `## Validation Contract` so proof references resolve to explicit configured validation IDs.
Compiled child slices under `docs/future/` are still future blueprints until promoted. They must satisfy the same future gate sections (`## Master Plan Coverage` or `## Capability Coverage Matrix`, `## Prior Completed Plan Reconciliation`, and `## Promotion Blockers`) and, for product slices, must carry valid non-doc `Implementation-Targets`.

## Future Authoring Contract

Default rule: future authoring must produce executable shapes, not blueprint-only dead ends.

- Concrete ask: author a direct `Execution-Scope: slice`.
- Broad multi-slice ask: author `Execution-Scope: program` with `Authoring-Intent: executable-default` and complete `## Child Slice Definitions`.
- If child decomposition is not safe yet, run `npm run plans:scaffold-children -- --plan-file <path>` and review the generated draft child definitions instead of leaving the parent without children. The scaffold command auto-writes missing `Authoring-Intent: executable-default`.
- Review-generated children are intentionally incomplete. Replace placeholders, remove draft markers, and ensure product child definitions point at real source roots before relying on `plans:compile` + `plans:verify`.
- Only use `Authoring-Intent: blueprint-only` when the user explicitly asked for a blueprint-only artifact. Blueprint-only parents must stay `Status: draft`, stay in `docs/future/`, and must not declare child definitions.

Minimal examples:

- Direct slice:
  - `Execution-Scope: slice`
  - `Implementation-Targets: src/feature`
- Executable program:
  - `Execution-Scope: program`
  - `Authoring-Intent: executable-default`
  - `## Child Slice Definitions`
- Explicit blueprint-only:
  - `Execution-Scope: program`
  - `Authoring-Intent: blueprint-only`
  - no `## Child Slice Definitions`

## Future Intake Gate (Minimal)

Create or update a future blueprint as `Status: draft` only when these checks pass:

- [ ] `Plan-ID` is lowercase kebab-case and unique.
- [ ] Problem, scope, and non-goals are explicit.
- [ ] `Acceptance-Criteria` are concrete and testable.
- [ ] `Acceptance-Criteria` describe full completion for this plan and do not use weak language such as `at minimum`.
- [ ] `Delivery-Class` and `Execution-Scope` are explicit; do not rely on titles like `phase`, `future`, or `blueprint` to communicate intent.
- [ ] `Dependencies` are complete (`none` when not applicable).
- [ ] `Risk-Tier` is set correctly (`low` | `medium` | `high`) when applicable.
- [ ] `Spec-Targets` reference canonical docs/files.
- [ ] Product slices declare non-doc `Implementation-Targets`; programs and non-product blueprints do not.
- [ ] Product slices should prefix must-land checkboxes with stable backticked IDs and prepare `## Capability Proof Map` entries before promotion.
- [ ] `Done-Evidence` is `pending`.
- [ ] `## Must-Land Checklist` exists and every checkbox item is executable within one promoted plan.
- [ ] `## Already-True Baseline` and `## Deferred Follow-Ons` keep non-plan scope out of the must-land checklist.
- [ ] `## Master Plan Coverage` or `## Capability Coverage Matrix` explicitly maps upstream strategy/capabilities into `shipped now`, `this phase`, `later phase`, or `non-goal`.
- [ ] `## Prior Completed Plan Reconciliation` classifies relevant completed plans as `kept-as-baseline`, `kept-but-refactored`, `superseded`, `obsolete`, or `reopened`.
- [ ] `## Promotion Blockers` lists the unresolved decisions, approvals, or external gates that still block safe promotion.
- [ ] Future `Execution-Scope: program` plans declare `Authoring-Intent`.
- [ ] Future `Execution-Scope: program` plans with `Authoring-Intent: executable-default` include `## Child Slice Definitions`; legacy `## Remaining Execution Slices` / `## Portfolio Units` headings are migration-only and do not trigger child compilation.
- [ ] Future `Execution-Scope: program` plans with `Authoring-Intent: blueprint-only` stay `Status: draft`, remain in `docs/future/`, and do not declare child definitions.
- [ ] If decomposition is not safe yet, use `npm run plans:scaffold-children -- --plan-file <path>` and review the draft child definitions before promotion. This command is for future-native parents only and will refuse legacy heading parents.
- [ ] Use `node ./scripts/automation/migrate-program-children.mjs --plan-file <path>` to turn legacy `## Remaining Execution Slices` / `## Portfolio Units` headings into reviewable `## Child Slice Definitions` before expecting automatic child compilation.
- [ ] Compiled future child slices still carry the future authoring sections required for promotion readiness.
- [ ] `npm run plans:verify` passes.

## Promotion Gate (`draft` -> `ready-for-promotion`)

Set `Status: ready-for-promotion` only when these checks pass:

- [ ] At least one executable slice is defined with clear entry and exit criteria.
- [ ] `Execution-Scope: program` blueprints are only promoted when they are intended to remain active parent contracts; executable work still belongs in child slices.
- [ ] Program blueprints with `Authoring-Intent: executable-default` have complete `## Child Slice Definitions`, and their child definitions already declare `Validation-Lanes`.
- [ ] Blueprint-only parents are not promoted.
- [ ] `## Must-Land Checklist` is the exact completion contract for the promoted plan.
- [ ] `## Master Plan Coverage` or `## Capability Coverage Matrix` proves nothing from upstream strategy is silently omitted.
- [ ] `## Prior Completed Plan Reconciliation` proves older completed work in the same area is either preserved, refactored, superseded, or intentionally retired.
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
3. Before promotion/queue selection, orchestration compiles structured program children so ready parent programs and ready child slices move forward together.
4. Once promoted, the blueprint file is moved from `docs/future/` into `docs/exec-plans/active/`.

## Reconciliation Guidance

Use `## Prior Completed Plan Reconciliation` to prevent two failure modes:

- shipped behavior disappearing because a future blueprint forgot to mention it
- obsolete behavior returning because an old completed plan was treated as still-current by default

Reconciliation is part of the planning contract. It reduces omission and stale-scope risk, but it does not replace planner or reviewer judgment.

Safe rule: `reconcile -> verify -> promote -> execute`

List only the relevant completed plans, not every historical plan. Classify each one with a short rationale:

- `kept-as-baseline`
- `kept-but-refactored`
- `superseded`
- `obsolete`
- `reopened`

Use `node ./scripts/automation/suggest-plan-reconciliation.mjs --plan-file <path>` to generate a metadata-overlap candidate list before reviewer signoff.
