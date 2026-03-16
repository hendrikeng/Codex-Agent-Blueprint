import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_CHILD_DEFINITION_MARKER,
  evaluateProgramParentAuthoring,
  scaffoldProgramChildDefinitions
} from './program-parent-authoring.mjs';

function parentPlan(content, overrides = {}) {
  return {
    planId: 'parent-program',
    phase: 'future',
    status: 'draft',
    rel: 'docs/future/2026-03-16-parent-program.md',
    executionScope: 'program',
    content,
    ...overrides
  };
}

test('evaluateProgramParentAuthoring accepts draft blueprint-only future parents', () => {
  const state = evaluateProgramParentAuthoring(parentPlan(`# Parent Program

## Metadata

- Plan-ID: parent-program
- Status: draft
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Keep this as a blueprint only.
- Delivery-Class: product
- Execution-Scope: program
- Authoring-Intent: blueprint-only
- Dependencies: none
- Spec-Targets: docs/spec.md
- Done-Evidence: pending
`));

  assert.equal(state.statusCode, 'skipped-blueprint-only');
  assert.equal(state.issues.length, 0);
});

test('evaluateProgramParentAuthoring blocks blueprint-only active parents', () => {
  const state = evaluateProgramParentAuthoring(parentPlan(`# Parent Program

## Metadata

- Plan-ID: parent-program
- Status: in-progress
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Keep this as a blueprint only.
- Delivery-Class: product
- Execution-Scope: program
- Authoring-Intent: blueprint-only
- Dependencies: none
- Spec-Targets: docs/spec.md
- Done-Evidence: pending
`, {
    phase: 'active',
    status: 'in-progress',
    rel: 'docs/exec-plans/active/2026-03-16-parent-program.md'
  }));

  assert.equal(state.issues.some((issue) => issue.code === 'BLUEPRINT_ONLY_PROGRAM_NOT_FUTURE'), true);
  assert.equal(state.statusCode, 'blocked-blueprint-only-invalid');
});

test('scaffoldProgramChildDefinitions derives deterministic draft children from coverage rows', () => {
  const result = scaffoldProgramChildDefinitions(`# Parent Program

## Metadata

- Plan-ID: parent-program
- Status: draft
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Build the child graph.
- Delivery-Class: product
- Execution-Scope: program
- Dependencies: none
- Spec-Targets: docs/spec.md, src/app
- Done-Evidence: pending

## Must-Land Checklist

- [ ] Build the parent graph.

## Master Plan Coverage

| Capability | Current Status | This Plan | Later |
| --- | --- | --- | --- |
| Search Inbox | foundation only | yes | no |
| Tour Builder | not shipped | yes | no |

## Promotion Blockers

- None.
`, {
    validationIds: {
      always: ['repo:verify-fast'],
      'host-required': ['repo:verify-full']
    }
  });

  assert.equal(result.definitions.length, 2);
  assert.equal(result.definitions[0].planId, 'search-inbox');
  assert.equal(result.definitions[1].planId, 'tour-builder');
  assert.match(result.updatedContent, /- Authoring-Intent: executable-default/);
  assert.match(result.updatedContent, new RegExp(DRAFT_CHILD_DEFINITION_MARKER));
  assert.match(result.updatedContent, /## Child Slice Definitions/);
  assert.match(result.updatedContent, /REVIEW-REQUIRED/);
});

test('scaffoldProgramChildDefinitions rejects legacy child heading parents', () => {
  assert.throws(
    () => scaffoldProgramChildDefinitions(`# Parent Program

## Metadata

- Plan-ID: parent-program
- Status: draft
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Build the child graph.
- Delivery-Class: product
- Execution-Scope: program
- Dependencies: none
- Spec-Targets: docs/spec.md, src/app
- Done-Evidence: pending

## Promotion Blockers

- None.

## Remaining Execution Slices

### 1. Legacy Child Slice
`),
    /plans:migrate/
  );
});
