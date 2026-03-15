import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAtomicCommitReadiness,
  resolveAtomicCommitRoots
} from './atomic-commit-policy.mjs';

test('evaluateAtomicCommitReadiness refuses atomic commit when allowDirty is true', () => {
  const result = evaluateAtomicCommitReadiness('/tmp/irrelevant', 'example-plan', true, {}, {});

  assert.equal(result.ok, false);
  assert.match(result.reason, /allow-dirty true/);
});

test('resolveAtomicCommitRoots includes plan, spec, implementation, and evidence roots', () => {
  const roots = resolveAtomicCommitRoots(
    {
      planId: 'example-plan',
      rel: 'docs/exec-plans/active/2026-03-15-example-plan.md',
      specTargets: ['docs/product-specs/CURRENT-STATE.md'],
      implementationTargets: ['src/app'],
      atomicRoots: ['scripts/automation']
    },
    {
      git: {
        atomicCommitRoots: {
          defaults: ['package.json'],
          shared: ['docs/generated'],
          allowPlanMetadata: true
        }
      },
      context: {
        runtimeContextPath: 'docs/generated/AGENT-RUNTIME-CONTEXT.md'
      }
    },
    {
      rootDir: '/repo',
      evidenceIndexDir: '/repo/docs/exec-plans/evidence-index'
    },
    {
      completedRel: 'docs/exec-plans/completed/2026-03-15-example-plan.md'
    }
  );

  assert.equal(roots.includes('docs/exec-plans/active/2026-03-15-example-plan.md'), true);
  assert.equal(roots.includes('docs/exec-plans/completed/2026-03-15-example-plan.md'), true);
  assert.equal(roots.includes('docs/exec-plans/evidence-index/example-plan.md'), true);
  assert.equal(roots.includes('src/app'), true);
  assert.equal(roots.includes('scripts/automation'), true);
});
