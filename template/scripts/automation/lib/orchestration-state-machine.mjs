import { nowIso, trimmedString } from './orchestrator-shared.mjs';

export const ORCHESTRATION_STATE_SCHEMA_VERSION = 1;

export const PLAN_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  PENDING: 'pending',
  HANDOFF_REQUIRED: 'handoff-required',
  VALIDATION: 'validation',
  VALIDATION_PENDING: 'validation-pending',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  COMPLETED: 'completed'
});

export const STAGE_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PENDING: 'pending',
  HANDOFF_REQUIRED: 'handoff-required',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  REUSED: 'reused'
});

export const VALIDATION_STATES = Object.freeze({
  NOT_READY: 'not-ready',
  ALWAYS_RUNNING: 'always-running',
  HOST_REQUESTED: 'host-requested',
  HOST_PENDING: 'host-pending',
  PASSED: 'passed',
  FAILED: 'failed'
});

const PLAN_TRANSITIONS = {
  [PLAN_STATES.QUEUED]: {
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    session_started: { to: PLAN_STATES.RUNNING, code: 'plan.session.started' },
    plan_retry_armed: { to: PLAN_STATES.QUEUED, code: 'plan.retry.armed' },
    plan_unblock_armed: { to: PLAN_STATES.QUEUED, code: 'plan.unblock.armed' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.RUNNING]: {
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    session_started: { to: PLAN_STATES.RUNNING, code: 'plan.session.started' },
    session_continued: { to: PLAN_STATES.RUNNING, code: 'plan.session.continued' },
    session_pending: { to: PLAN_STATES.PENDING, code: 'plan.session.pending' },
    session_handoff_required: { to: PLAN_STATES.HANDOFF_REQUIRED, code: 'plan.session.handoff-required' },
    session_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.session.blocked' },
    session_failed: { to: PLAN_STATES.FAILED, code: 'plan.session.failed' },
    completion_gate_opened: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.opened' },
    validation_started: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.started' },
    plan_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.blocked' },
    plan_failed: { to: PLAN_STATES.FAILED, code: 'plan.failed' },
    plan_pending: { to: PLAN_STATES.PENDING, code: 'plan.pending' },
    plan_completed: { to: PLAN_STATES.COMPLETED, code: 'plan.completed' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.PENDING]: {
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    session_started: { to: PLAN_STATES.RUNNING, code: 'plan.session.restarted' },
    session_continued: { to: PLAN_STATES.RUNNING, code: 'plan.session.continued' },
    completion_gate_opened: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.opened' },
    plan_retry_armed: { to: PLAN_STATES.QUEUED, code: 'plan.retry.armed' },
    plan_unblock_armed: { to: PLAN_STATES.QUEUED, code: 'plan.unblock.armed' },
    plan_pending: { to: PLAN_STATES.PENDING, code: 'plan.pending' },
    plan_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.blocked' },
    plan_failed: { to: PLAN_STATES.FAILED, code: 'plan.failed' },
    plan_completed: { to: PLAN_STATES.COMPLETED, code: 'plan.completed' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.HANDOFF_REQUIRED]: {
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    session_started: { to: PLAN_STATES.RUNNING, code: 'plan.session.restarted' },
    session_continued: { to: PLAN_STATES.RUNNING, code: 'plan.session.continued' },
    plan_retry_armed: { to: PLAN_STATES.QUEUED, code: 'plan.retry.armed' },
    plan_unblock_armed: { to: PLAN_STATES.QUEUED, code: 'plan.unblock.armed' },
    plan_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.blocked' },
    plan_failed: { to: PLAN_STATES.FAILED, code: 'plan.failed' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.VALIDATION]: {
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    validation_started: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.started' },
    validation_passed: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.always-passed' },
    validation_failed: { to: PLAN_STATES.FAILED, code: 'plan.validation.failed' },
    validation_residual_external: { to: PLAN_STATES.VALIDATION_PENDING, code: 'plan.validation.external-pending' },
    host_validation_requested: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.host-requested' },
    host_validation_started: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.host-started' },
    host_validation_blocked: { to: PLAN_STATES.VALIDATION_PENDING, code: 'plan.validation.host-pending' },
    host_validation_residual_external: { to: PLAN_STATES.VALIDATION_PENDING, code: 'plan.validation.host-external-pending' },
    host_validation_failed: { to: PLAN_STATES.FAILED, code: 'plan.validation.host-failed' },
    host_validation_passed: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.host-passed' },
    plan_pending: { to: PLAN_STATES.VALIDATION, code: 'plan.pending' },
    plan_completed: { to: PLAN_STATES.COMPLETED, code: 'plan.completed' },
    plan_failed: { to: PLAN_STATES.FAILED, code: 'plan.failed' },
    plan_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.blocked' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.VALIDATION_PENDING]: {
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    host_validation_requested: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.host-requested' },
    host_validation_started: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.host-started' },
    host_validation_blocked: { to: PLAN_STATES.VALIDATION_PENDING, code: 'plan.validation.host-pending' },
    host_validation_residual_external: { to: PLAN_STATES.VALIDATION_PENDING, code: 'plan.validation.host-external-pending' },
    host_validation_failed: { to: PLAN_STATES.FAILED, code: 'plan.validation.host-failed' },
    host_validation_passed: { to: PLAN_STATES.VALIDATION, code: 'plan.validation.host-passed' },
    plan_pending: { to: PLAN_STATES.VALIDATION_PENDING, code: 'plan.pending' },
    plan_completed: { to: PLAN_STATES.COMPLETED, code: 'plan.completed' },
    plan_failed: { to: PLAN_STATES.FAILED, code: 'plan.failed' },
    plan_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.blocked' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.BLOCKED]: {
    plan_retry_armed: { to: PLAN_STATES.QUEUED, code: 'plan.retry.armed' },
    plan_unblock_armed: { to: PLAN_STATES.QUEUED, code: 'plan.unblock.armed' },
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    plan_blocked: { to: PLAN_STATES.BLOCKED, code: 'plan.blocked' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.FAILED]: {
    plan_retry_armed: { to: PLAN_STATES.QUEUED, code: 'plan.retry.armed' },
    plan_started: { to: PLAN_STATES.RUNNING, code: 'plan.started' },
    plan_failed: { to: PLAN_STATES.FAILED, code: 'plan.failed' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  },
  [PLAN_STATES.COMPLETED]: {
    plan_completed: { to: PLAN_STATES.COMPLETED, code: 'plan.completed' },
    program_parent_closed: { to: PLAN_STATES.COMPLETED, code: 'program.closed' }
  }
};

const STAGE_TRANSITIONS = {
  [STAGE_STATES.IDLE]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.started' },
    role_stage_reused: { to: STAGE_STATES.REUSED, code: 'stage.reused' }
  },
  [STAGE_STATES.REUSED]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.started' }
  },
  [STAGE_STATES.RUNNING]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.started' },
    session_continued: { to: STAGE_STATES.RUNNING, code: 'stage.continued' },
    session_pending: { to: STAGE_STATES.PENDING, code: 'stage.pending' },
    session_handoff_required: { to: STAGE_STATES.HANDOFF_REQUIRED, code: 'stage.handoff-required' },
    session_blocked: { to: STAGE_STATES.BLOCKED, code: 'stage.blocked' },
    session_failed: { to: STAGE_STATES.FAILED, code: 'stage.failed' },
    role_stage_advanced: { to: STAGE_STATES.COMPLETED, code: 'stage.completed' },
    completion_gate_opened: { to: STAGE_STATES.COMPLETED, code: 'stage.completed' }
  },
  [STAGE_STATES.PENDING]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.restarted' },
    session_continued: { to: STAGE_STATES.RUNNING, code: 'stage.continued' },
    session_pending_no_touch_retry: { to: STAGE_STATES.PENDING, code: 'stage.retry' },
    session_pending_fail_fast: { to: STAGE_STATES.PENDING, code: 'stage.pending-fail-fast' },
    session_pending_streak_fail_fast: { to: STAGE_STATES.PENDING, code: 'stage.pending-fail-fast' }
  },
  [STAGE_STATES.HANDOFF_REQUIRED]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.restarted' },
    session_continued: { to: STAGE_STATES.RUNNING, code: 'stage.continued' }
  },
  [STAGE_STATES.BLOCKED]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.restarted' }
  },
  [STAGE_STATES.FAILED]: {
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.restarted' }
  },
  [STAGE_STATES.COMPLETED]: {
    role_stage_reused: { to: STAGE_STATES.REUSED, code: 'stage.reused' },
    session_started: { to: STAGE_STATES.RUNNING, code: 'stage.started' }
  }
};

const VALIDATION_TRANSITIONS = {
  [VALIDATION_STATES.NOT_READY]: {
    validation_started: { to: VALIDATION_STATES.ALWAYS_RUNNING, code: 'validation.started' }
  },
  [VALIDATION_STATES.ALWAYS_RUNNING]: {
    validation_passed: { to: VALIDATION_STATES.HOST_REQUESTED, code: 'validation.always-passed' },
    validation_failed: { to: VALIDATION_STATES.FAILED, code: 'validation.failed' },
    validation_residual_external: { to: VALIDATION_STATES.HOST_PENDING, code: 'validation.external-pending' }
  },
  [VALIDATION_STATES.HOST_REQUESTED]: {
    validation_started: { to: VALIDATION_STATES.ALWAYS_RUNNING, code: 'validation.restarted' },
    host_validation_requested: { to: VALIDATION_STATES.HOST_REQUESTED, code: 'validation.host-requested' },
    host_validation_started: { to: VALIDATION_STATES.HOST_REQUESTED, code: 'validation.host-started' },
    host_validation_blocked: { to: VALIDATION_STATES.HOST_PENDING, code: 'validation.host-pending' },
    host_validation_residual_external: { to: VALIDATION_STATES.HOST_PENDING, code: 'validation.host-external-pending' },
    host_validation_failed: { to: VALIDATION_STATES.FAILED, code: 'validation.host-failed' },
    host_validation_passed: { to: VALIDATION_STATES.PASSED, code: 'validation.host-passed' }
  },
  [VALIDATION_STATES.HOST_PENDING]: {
    validation_started: { to: VALIDATION_STATES.ALWAYS_RUNNING, code: 'validation.restarted' },
    host_validation_requested: { to: VALIDATION_STATES.HOST_REQUESTED, code: 'validation.host-requested' },
    host_validation_started: { to: VALIDATION_STATES.HOST_REQUESTED, code: 'validation.host-started' },
    host_validation_blocked: { to: VALIDATION_STATES.HOST_PENDING, code: 'validation.host-pending' },
    host_validation_residual_external: { to: VALIDATION_STATES.HOST_PENDING, code: 'validation.host-external-pending' },
    host_validation_failed: { to: VALIDATION_STATES.FAILED, code: 'validation.host-failed' },
    host_validation_passed: { to: VALIDATION_STATES.PASSED, code: 'validation.host-passed' }
  },
  [VALIDATION_STATES.PASSED]: {
    validation_started: { to: VALIDATION_STATES.ALWAYS_RUNNING, code: 'validation.restarted' },
    plan_completed: { to: VALIDATION_STATES.PASSED, code: 'validation.completed' }
  },
  [VALIDATION_STATES.FAILED]: {
    validation_started: { to: VALIDATION_STATES.ALWAYS_RUNNING, code: 'validation.restarted' }
  }
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function valueFromSet(value, allowed, fallback) {
  const normalized = trimmedString(value, fallback);
  return Object.values(allowed).includes(normalized) ? normalized : fallback;
}

function descriptorFor(machineTransitions, currentState, eventName, machineLabel) {
  const transitions = machineTransitions[currentState] ?? {};
  const descriptor = transitions[eventName];
  if (!descriptor) {
    throw new Error(`Illegal ${machineLabel} transition from '${currentState}' via '${eventName}'.`);
  }
  return descriptor;
}

function nextState(machineTransitions, currentState, eventName, machineLabel) {
  if (!eventName) {
    return { state: currentState, code: null };
  }
  const descriptor = descriptorFor(machineTransitions, currentState, eventName, machineLabel);
  return {
    state: descriptor.to,
    code: descriptor.code
  };
}

export function createOrchestrationState(planId, planType = 'slice') {
  return {
    schemaVersion: ORCHESTRATION_STATE_SCHEMA_VERSION,
    planId: trimmedString(planId),
    planType: trimmedString(planType, 'slice'),
    planState: PLAN_STATES.QUEUED,
    stageState: STAGE_STATES.IDLE,
    validationState: VALIDATION_STATES.NOT_READY,
    currentRole: null,
    currentStageIndex: 0,
    currentStageTotal: 0,
    lastTransitionEvent: null,
    lastTransitionCode: null,
    lastUpdatedAt: null,
    transitionCount: 0
  };
}

export function normalizeOrchestrationState(currentState, patch = {}) {
  const source = {
    ...asObject(currentState),
    ...asObject(patch)
  };
  const normalized = createOrchestrationState(source.planId, source.planType);
  return {
    ...normalized,
    planId: trimmedString(source.planId, normalized.planId),
    planType: trimmedString(source.planType, normalized.planType),
    planState: valueFromSet(source.planState, PLAN_STATES, normalized.planState),
    stageState: valueFromSet(source.stageState, STAGE_STATES, normalized.stageState),
    validationState: valueFromSet(source.validationState, VALIDATION_STATES, normalized.validationState),
    currentRole: trimmedString(source.currentRole, null),
    currentStageIndex: Math.max(0, Number(source.currentStageIndex ?? 0) || 0),
    currentStageTotal: Math.max(0, Number(source.currentStageTotal ?? 0) || 0),
    lastTransitionEvent: trimmedString(source.lastTransitionEvent, null),
    lastTransitionCode: trimmedString(source.lastTransitionCode, null),
    lastUpdatedAt: trimmedString(source.lastUpdatedAt, null),
    transitionCount: Math.max(0, Number(source.transitionCount ?? 0) || 0)
  };
}

export function inferOrchestrationTransition(type, details = {}) {
  const status = trimmedString(details.status)?.toLowerCase();
  switch (type) {
    case 'plan_started':
      return { planEvent: 'plan_started' };
    case 'session_started':
      return { planEvent: 'session_started', stageEvent: 'session_started' };
    case 'session_finished':
      if (status === 'pending') {
        return { planEvent: 'session_pending', stageEvent: 'session_pending' };
      }
      if (status === 'handoff_required') {
        return { planEvent: 'session_handoff_required', stageEvent: 'session_handoff_required' };
      }
      if (status === 'blocked') {
        return { planEvent: 'session_blocked', stageEvent: 'session_blocked' };
      }
      if (status === 'failed') {
        return { planEvent: 'session_failed', stageEvent: 'session_failed' };
      }
      return null;
    case 'session_pending_no_touch_retry':
      return { stageEvent: 'session_pending_no_touch_retry' };
    case 'session_pending_fail_fast':
      return { stageEvent: 'session_pending_fail_fast' };
    case 'session_pending_streak_fail_fast':
      return { stageEvent: 'session_pending_streak_fail_fast' };
    case 'session_continued':
      return { planEvent: 'session_continued', stageEvent: 'session_continued' };
    case 'role_stage_advanced':
      return { stageEvent: 'role_stage_advanced' };
    case 'role_stage_reused':
      return { stageEvent: 'role_stage_reused' };
    case 'completion_gate_auto_promoted_validation':
    case 'completion_gate_opened':
      return { planEvent: 'completion_gate_opened', stageEvent: 'completion_gate_opened' };
    case 'validation_started':
      return { planEvent: 'validation_started', validationEvent: 'validation_started' };
    case 'validation_always_passed':
    case 'validation_passed':
      return { validationEvent: 'validation_passed' };
    case 'validation_failed':
      return { planEvent: 'validation_failed', validationEvent: 'validation_failed' };
    case 'validation_residual_external':
      return { planEvent: 'validation_residual_external', validationEvent: 'validation_residual_external' };
    case 'host_validation_requested':
      return { planEvent: 'host_validation_requested', validationEvent: 'host_validation_requested' };
    case 'host_validation_started':
      return { planEvent: 'host_validation_started', validationEvent: 'host_validation_started' };
    case 'host_validation_blocked':
      return { planEvent: 'host_validation_blocked', validationEvent: 'host_validation_blocked' };
    case 'host_validation_residual_external':
      return { planEvent: 'host_validation_residual_external', validationEvent: 'host_validation_residual_external' };
    case 'host_validation_failed':
      return { planEvent: 'host_validation_failed', validationEvent: 'host_validation_failed' };
    case 'host_validation_passed':
      return { planEvent: 'host_validation_passed', validationEvent: 'host_validation_passed' };
    case 'plan_blocked':
      return { planEvent: 'plan_blocked' };
    case 'plan_failed':
      return { planEvent: 'plan_failed' };
    case 'plan_pending':
      return { planEvent: 'plan_pending' };
    case 'plan_completed':
    case 'plan_completed_parallel':
      return { planEvent: 'plan_completed', validationEvent: 'plan_completed' };
    case 'plan_blocked_parallel':
      return { planEvent: 'plan_blocked' };
    case 'plan_failed_parallel':
      return { planEvent: 'plan_failed' };
    case 'program_parent_closed':
      return { planEvent: 'program_parent_closed' };
    case 'plan_retry_armed':
      return { planEvent: 'plan_retry_armed' };
    case 'plan_unblock_armed':
      return { planEvent: 'plan_unblock_armed' };
    default:
      return null;
  }
}

export function applyOrchestrationTransition(currentState, type, details = {}) {
  const base = asObject(currentState).planId
    ? normalizeOrchestrationState(currentState)
    : createOrchestrationState(details.planId, details.planType);
  const transition = inferOrchestrationTransition(type, details);
  if (!transition) {
    return base;
  }

  const plan = nextState(PLAN_TRANSITIONS, base.planState, transition.planEvent, 'plan machine');
  const stage = nextState(STAGE_TRANSITIONS, base.stageState, transition.stageEvent, 'stage machine');
  const validation = nextState(
    VALIDATION_TRANSITIONS,
    base.validationState,
    transition.validationEvent,
    'validation machine'
  );

  const currentRole = trimmedString(details.nextRole ?? details.role, base.currentRole);
  const currentStageIndex =
    Number.isInteger(details.nextStageIndex) ? details.nextStageIndex : (Number.isInteger(details.stageIndex) ? details.stageIndex : base.currentStageIndex);
  const currentStageTotal =
    Number.isInteger(details.nextStageTotal) ? details.nextStageTotal : (Number.isInteger(details.stageTotal) ? details.stageTotal : base.currentStageTotal);
  const preferPlanCode = type.startsWith('plan_') || type === 'program_parent_closed';
  const transitionCode = preferPlanCode
    ? plan.code ?? validation.code ?? stage.code
    : validation.code ?? stage.code ?? plan.code;

  return {
    ...base,
    planId: trimmedString(details.planId, base.planId),
    planType: trimmedString(details.planType, base.planType),
    planState: plan.state,
    stageState: stage.state,
    validationState: validation.state,
    currentRole,
    currentStageIndex: Math.max(0, currentStageIndex || 0),
    currentStageTotal: Math.max(0, currentStageTotal || 0),
    lastTransitionEvent: type,
    lastTransitionCode: transitionCode,
    lastUpdatedAt: trimmedString(details.timestamp, nowIso()),
    transitionCount: Math.max(0, Number(base.transitionCount ?? 0)) + 1
  };
}

export function summarizeOrchestrationState(state) {
  const source = asObject(state);
  return {
    planState: trimmedString(source.planState, PLAN_STATES.QUEUED),
    stageState: trimmedString(source.stageState, STAGE_STATES.IDLE),
    validationState: trimmedString(source.validationState, VALIDATION_STATES.NOT_READY),
    currentRole: trimmedString(source.currentRole, null),
    currentStageIndex: Math.max(0, Number(source.currentStageIndex ?? 0) || 0),
    currentStageTotal: Math.max(0, Number(source.currentStageTotal ?? 0) || 0),
    lastTransitionEvent: trimmedString(source.lastTransitionEvent, null),
    lastTransitionCode: trimmedString(source.lastTransitionCode, null),
    transitionCount: Math.max(0, Number(source.transitionCount ?? 0) || 0),
    lastUpdatedAt: trimmedString(source.lastUpdatedAt, null)
  };
}

export function replayOrchestrationTransitions(entries, initialState = null) {
  return (Array.isArray(entries) ? entries : []).reduce(
    (current, entry) => applyOrchestrationTransition(current, entry.type, entry.details),
    initialState
  );
}
