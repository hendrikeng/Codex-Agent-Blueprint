# Engineering Invariants

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Core Invariants

- Server-side authority for sensitive state.
- Authorization/isolation boundary enforcement.
- Deterministic numeric and timestamp handling for critical domains.
- Shared contracts define inter-module boundaries.
- Prefer root-cause fixes over superficial patches.
- Keep files concise and refactor when size hurts legibility or testability.

## Quality Escalation

- When the same defect, reviewer comment, or operator confusion repeats, strengthen the guardrail instead of restating the advice.
- Promote repeated guidance in this order when feasible: docs -> focused test coverage -> lint/structure rule -> script or automation gate.
- Bug fixes need regression coverage unless the failure mode cannot be reproduced mechanically.
- End-to-end coverage should stay focused on high-signal user journeys and regression-prone integration seams, not styling or implementation trivia.
- Prefer explicit test setup close to each test over hidden shared state unless shared setup materially improves correctness or cost.

## Documentation Discipline

- Canonical docs must reflect real behavior.
- Behavior changes must update docs in the same change.
- Avoid parallel policy sources.
