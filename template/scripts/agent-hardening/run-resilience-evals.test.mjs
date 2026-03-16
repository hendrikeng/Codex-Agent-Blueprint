import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateResilienceFixtures,
  evaluateResilienceScenario
} from './run-resilience-evals.mjs';

test('evaluateResilienceScenario passes when final state and fault metadata match', () => {
  const result = evaluateResilienceScenario({
    id: 'worker-no-touch-retry',
    suite: 'resilience-critical-faults',
    critical: true,
    events: [
      { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
      { type: 'session_finished', details: { planId: 'plan-a', status: 'pending', role: 'worker', stageIndex: 1, stageTotal: 1 } },
      {
        type: 'session_pending_no_touch_retry',
        details: { planId: 'plan-a', faultCode: 'worker.pending.no-touch', recoveryAction: 'retry-worker-edit-first' }
      }
    ],
    expected: {
      finalState: {
        planState: 'pending',
        stageState: 'pending',
        validationState: 'not-ready'
      },
      eventType: 'session_pending_no_touch_retry',
      faultCode: 'worker.pending.no-touch',
      recoveryAction: 'retry-worker-edit-first',
      lastTransitionCode: 'stage.retry'
    }
  });

  assert.equal(result.status, 'pass');
});

test('evaluateResilienceScenario fails when fault metadata does not match', () => {
  const result = evaluateResilienceScenario({
    id: 'host-validation-pending',
    events: [
      { type: 'validation_started', details: { planId: 'plan-a' } },
      { type: 'validation_always_passed', details: { planId: 'plan-a' } },
      { type: 'host_validation_blocked', details: { planId: 'plan-a', faultCode: 'validation.host.pending' } }
    ],
    expected: {
      finalState: {
        planState: 'validation-pending'
      },
      eventType: 'host_validation_blocked',
      faultCode: 'validation.host.external-blocker'
    }
  });

  assert.equal(result.status, 'fail');
});

test('evaluateResilienceFixtures aggregates suite totals', () => {
  const report = evaluateResilienceFixtures({
    scenarios: [
      {
        id: 'pass',
        suite: 'resilience-critical-faults',
        events: [
          { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
          { type: 'session_finished', details: { planId: 'plan-a', status: 'failed', role: 'worker', stageIndex: 1, stageTotal: 1 } },
          { type: 'session_failed', details: { planId: 'plan-a', faultCode: 'session.failed', recoveryAction: 'retry-plan' } }
        ],
        expected: {
          finalState: { planState: 'failed' },
          eventType: 'session_failed',
          faultCode: 'session.failed',
          recoveryAction: 'retry-plan',
          lastTransitionCode: 'stage.failed'
        }
      }
    ]
  });

  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.suites[0].status, 'pass');
});
