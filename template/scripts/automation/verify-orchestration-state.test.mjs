import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOrchestrationState } from './verify-orchestration-state.mjs';
import { createOrchestrationState } from './lib/orchestration-state-machine.mjs';

test('evaluateOrchestrationState passes matching replayed and persisted summaries', () => {
  const runState = {
    orchestrationState: {
      'plan-a': {
        ...createOrchestrationState('plan-a'),
        planState: 'completed',
        stageState: 'completed',
        validationState: 'passed',
        currentRole: 'worker',
        currentStageIndex: 1,
        currentStageTotal: 1,
        lastTransitionEvent: 'plan_completed',
        lastTransitionCode: 'plan.completed',
        transitionCount: 7
      }
    }
  };
  const runEvents = [
    { type: 'plan_started', details: { planId: 'plan-a' } },
    { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
    { type: 'completion_gate_opened', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
    { type: 'validation_started', details: { planId: 'plan-a' } },
    { type: 'validation_always_passed', details: { planId: 'plan-a' } },
    { type: 'host_validation_passed', details: { planId: 'plan-a' } },
    { type: 'plan_completed', details: { planId: 'plan-a' } }
  ];

  const result = evaluateOrchestrationState(runState, runEvents);
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.replayErrors.length, 0);
  assert.equal(result.checkedPlans, 1);
});

test('evaluateOrchestrationState reports mismatched persisted summaries', () => {
  const runState = {
    orchestrationState: {
      'plan-a': createOrchestrationState('plan-a')
    }
  };
  const runEvents = [
    { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } }
  ];

  const result = evaluateOrchestrationState(runState, runEvents);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].planId, 'plan-a');
});

test('evaluateOrchestrationState reports illegal transition replay errors', () => {
  const result = evaluateOrchestrationState(null, [
    { type: 'host_validation_passed', details: { planId: 'plan-a' } }
  ]);

  assert.equal(result.replayErrors.length, 1);
  assert.match(result.replayErrors[0].error, /Illegal plan machine transition/);
});
