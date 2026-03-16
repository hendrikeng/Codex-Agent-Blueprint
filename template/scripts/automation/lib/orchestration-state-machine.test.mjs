import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_STATES,
  STAGE_STATES,
  VALIDATION_STATES,
  applyOrchestrationTransition,
  createOrchestrationState,
  inferOrchestrationTransition,
  replayOrchestrationTransitions,
  summarizeOrchestrationState
} from './orchestration-state-machine.mjs';

test('applyOrchestrationTransition tracks session to validation to completion flow', () => {
  let state = createOrchestrationState('plan-a');
  state = applyOrchestrationTransition(state, 'plan_started', { planId: 'plan-a' });
  state = applyOrchestrationTransition(state, 'session_started', {
    planId: 'plan-a',
    role: 'worker',
    stageIndex: 1,
    stageTotal: 1
  });
  state = applyOrchestrationTransition(state, 'completion_gate_auto_promoted_validation', {
    planId: 'plan-a',
    role: 'worker',
    stageIndex: 1,
    stageTotal: 1
  });
  state = applyOrchestrationTransition(state, 'validation_started', { planId: 'plan-a' });
  state = applyOrchestrationTransition(state, 'validation_passed', { planId: 'plan-a' });
  state = applyOrchestrationTransition(state, 'host_validation_requested', { planId: 'plan-a' });
  state = applyOrchestrationTransition(state, 'host_validation_passed', { planId: 'plan-a' });
  state = applyOrchestrationTransition(state, 'plan_completed', { planId: 'plan-a' });

  assert.equal(state.planState, PLAN_STATES.COMPLETED);
  assert.equal(state.stageState, STAGE_STATES.COMPLETED);
  assert.equal(state.validationState, VALIDATION_STATES.PASSED);
  assert.equal(state.lastTransitionCode, 'plan.completed');
});

test('applyOrchestrationTransition tracks pending restart flow', () => {
  let state = createOrchestrationState('plan-a');
  state = applyOrchestrationTransition(state, 'session_started', {
    planId: 'plan-a',
    role: 'planner',
    stageIndex: 1,
    stageTotal: 3
  });
  state = applyOrchestrationTransition(state, 'session_finished', {
    planId: 'plan-a',
    role: 'planner',
    stageIndex: 1,
    stageTotal: 3,
    status: 'pending'
  });
  state = applyOrchestrationTransition(state, 'session_continued', {
    planId: 'plan-a',
    nextRole: 'planner',
    nextStageIndex: 1,
    nextStageTotal: 3
  });

  assert.equal(state.planState, PLAN_STATES.RUNNING);
  assert.equal(state.stageState, STAGE_STATES.RUNNING);
  assert.equal(state.currentRole, 'planner');
});

test('inferOrchestrationTransition maps session_finished status variants', () => {
  assert.deepEqual(inferOrchestrationTransition('session_finished', { status: 'pending' }), {
    planEvent: 'session_pending',
    stageEvent: 'session_pending'
  });
  assert.deepEqual(inferOrchestrationTransition('session_finished', { status: 'handoff_required' }), {
    planEvent: 'session_handoff_required',
    stageEvent: 'session_handoff_required'
  });
  assert.equal(inferOrchestrationTransition('session_finished', { status: 'completed' }), null);
});

test('replayOrchestrationTransitions rebuilds the latest state summary', () => {
  const finalState = replayOrchestrationTransitions([
    { type: 'plan_started', details: { planId: 'plan-a' } },
    { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
    { type: 'session_finished', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1, status: 'handoff_required' } }
  ], createOrchestrationState('plan-a'));
  const summary = summarizeOrchestrationState(finalState);

  assert.deepEqual(summary, {
    planState: PLAN_STATES.HANDOFF_REQUIRED,
    stageState: STAGE_STATES.HANDOFF_REQUIRED,
    validationState: VALIDATION_STATES.NOT_READY,
    currentRole: 'worker',
    currentStageIndex: 1,
    currentStageTotal: 1,
    lastTransitionEvent: 'session_finished',
    lastTransitionCode: 'stage.handoff-required',
    transitionCount: 3,
    lastUpdatedAt: finalState.lastUpdatedAt
  });
});

test('applyOrchestrationTransition rejects illegal validation transitions', () => {
  assert.throws(
    () => applyOrchestrationTransition(createOrchestrationState('plan-a'), 'host_validation_passed', { planId: 'plan-a' }),
    /Illegal plan machine transition/
  );
});
