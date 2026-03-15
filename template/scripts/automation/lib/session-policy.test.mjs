import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkerTouchPolicy,
  disallowedTouchedPathsForRole,
  hasMeaningfulWorkerTouchSummary
} from './session-policy.mjs';

test('buildWorkerTouchPolicy allows docs-only artifact plans to count scoped docs progress', () => {
  const plan = {
    planId: 'docs-slice',
    rel: 'docs/exec-plans/active/2026-03-15-docs-slice.md',
    deliveryClass: 'docs',
    executionScope: 'slice',
    specTargets: ['docs/README.md'],
    content: '# Docs Slice\n\nStatus: in-progress\nValidation-Ready: no\n'
  };

  const policy = buildWorkerTouchPolicy(plan);

  assert.equal(policy.docsOnlySpecTargets, true);
  assert.equal(policy.allowPlanDocsOnlyTouches, true);
  assert.equal(policy.allowedTouchRoots.includes('docs/README.md'), true);
});

test('disallowedTouchedPathsForRole keeps non-worker roles inside exec-plan docs only', () => {
  assert.deepEqual(
    disallowedTouchedPathsForRole('reviewer', {}, [
      'docs/exec-plans/active/example.md',
      'src/app.ts',
      'docs/README.md'
    ]),
    ['src/app.ts', 'docs/README.md']
  );
});

test('hasMeaningfulWorkerTouchSummary ignores plan-doc-only touches for product plans', () => {
  const policy = {
    allowPlanDocsOnlyTouches: false
  };
  const summary = {
    touched: ['docs/exec-plans/active/example.md']
  };

  assert.equal(hasMeaningfulWorkerTouchSummary(summary, policy), false);
});
