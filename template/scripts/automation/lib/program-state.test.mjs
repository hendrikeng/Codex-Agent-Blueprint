import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveProgramStates } from './program-state.mjs';

function plan(overrides = {}) {
  return {
    planId: 'plan',
    phase: 'active',
    status: 'in-progress',
    rel: 'docs/exec-plans/active/2026-03-16-plan.md',
    executionScope: 'slice',
    parentPlanId: null,
    dependencies: [],
    content: '',
    ...overrides
  };
}

test('deriveProgramStates summarizes child progress and closeout blockers', () => {
  const catalog = {
    future: [],
    active: [
      plan({
        planId: 'parent-program',
        executionScope: 'program',
        content: [
          '## Prior Completed Plan Reconciliation',
          '',
          '- None.'
        ].join('\n')
      }),
      plan({
        planId: 'child-a',
        parentPlanId: 'parent-program',
        status: 'completed'
      }),
      plan({
        planId: 'child-b',
        parentPlanId: 'parent-program',
        status: 'validation',
        dependencies: ['child-a']
      })
    ],
    completed: []
  };

  const states = deriveProgramStates(catalog, {
    parentOutcomesByParent: new Map([
      ['parent-program', {
        planId: 'parent-program',
        status: 'blocked-missing-child-definitions',
        reason: 'Program parent cannot run because no child definitions exist.',
        authoringIntent: 'executable-default'
      }]
    ]),
    derivedAt: '2026-03-16T10:00:00.000Z'
  });

  assert.deepEqual(Object.keys(states), ['parent-program']);
  assert.equal(states['parent-program'].completedChildren, 1);
  assert.equal(states['parent-program'].validationChildren, 1);
  assert.equal(states['parent-program'].percentComplete, 50);
  assert.equal(states['parent-program'].closeoutEligible, false);
  assert.match(states['parent-program'].closeoutBlockedReasons[0], /Incomplete child slices remain/);
  assert.match(states['parent-program'].closeoutBlockedReasons[1], /Validation pending for child slices/);
  assert.equal(states['parent-program'].authoringIntent, 'executable-default');
  assert.deepEqual(states['parent-program'].validationPendingChildPlanIds, ['child-b']);
  assert.equal(states['parent-program'].lastDerivedAt, '2026-03-16T10:00:00.000Z');
});

test('deriveProgramStates marks active program closeout eligible when all children and reconciliation are complete', () => {
  const catalog = {
    future: [],
    active: [
      plan({
        planId: 'parent-program',
        executionScope: 'program',
        content: [
          '## Prior Completed Plan Reconciliation',
          '',
          '- Reviewed.'
        ].join('\n')
      })
    ],
    completed: [
      plan({
        planId: 'child-a',
        phase: 'completed',
        status: 'completed',
        rel: 'docs/exec-plans/completed/2026-03-16-child-a.md',
        parentPlanId: 'parent-program'
      }),
      plan({
        planId: 'child-b',
        phase: 'completed',
        status: 'completed',
        rel: 'docs/exec-plans/completed/2026-03-16-child-b.md',
        parentPlanId: 'parent-program',
        dependencies: ['child-a']
      })
    ]
  };

  const states = deriveProgramStates(catalog, {
    parentOutcomesByParent: new Map([
      ['parent-program', {
        planId: 'parent-program',
        status: 'compiled-current',
        reason: 'Compiled child plans are current.',
        authoringIntent: 'executable-default'
      }]
    ])
  });

  assert.equal(states['parent-program'].completedChildren, 2);
  assert.equal(states['parent-program'].closeoutEligible, true);
  assert.deepEqual(states['parent-program'].closeoutBlockedReasons, []);
  assert.equal(states['parent-program'].summary.includes('2/2 completed'), true);
});

test('deriveProgramStates treats negated reconciliation blockers as resolved', () => {
  const catalog = {
    future: [],
    active: [
      plan({
        planId: 'parent-program',
        executionScope: 'program',
        content: [
          '## Prior Completed Plan Reconciliation',
          '',
          '- No pending overlap remains.',
          '- Previously unresolved issues are now closed.'
        ].join('\n')
      })
    ],
    completed: [
      plan({
        planId: 'child-a',
        phase: 'completed',
        status: 'completed',
        rel: 'docs/exec-plans/completed/2026-03-16-child-a.md',
        parentPlanId: 'parent-program'
      })
    ]
  };

  const states = deriveProgramStates(catalog, {
    parentOutcomesByParent: new Map([
      ['parent-program', {
        planId: 'parent-program',
        status: 'compiled-current',
        reason: 'Compiled child plans are current.',
        authoringIntent: 'executable-default'
      }]
    ])
  });

  assert.equal(states['parent-program'].reconciliationReady, true);
  assert.equal(states['parent-program'].closeoutEligible, true);
});
