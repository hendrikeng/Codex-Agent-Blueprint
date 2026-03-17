const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

export const CONTRACT_IDS = {
  downstreamHarnessManifest: 'downstream-harness-manifest',
  runState: 'run-state',
  runEvent: 'run-event',
  continuityLatestState: 'continuity-latest-state',
  continuityCheckpoint: 'continuity-checkpoint',
  validationResult: 'validation-result'
};

function fail(contractId, message) {
  throw new Error(`[${contractId}] ${message}`);
}

function asObject(value, contractId, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(contractId, `${label} must be an object.`);
  }
  return value;
}

function asString(value, contractId, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail(contractId, `${label} must be a string.`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    fail(contractId, `${label} must not be empty.`);
  }
  return value;
}

function asNullableString(value, contractId, label) {
  if (value == null) {
    return null;
  }
  return asString(value, contractId, label, { allowEmpty: true });
}

function asBoolean(value, contractId, label) {
  if (typeof value !== 'boolean') {
    fail(contractId, `${label} must be a boolean.`);
  }
  return value;
}

function asInteger(value, contractId, label, { minimum = null } = {}) {
  if (!Number.isInteger(value)) {
    fail(contractId, `${label} must be an integer.`);
  }
  if (minimum != null && value < minimum) {
    fail(contractId, `${label} must be >= ${minimum}.`);
  }
  return value;
}

function asNumber(value, contractId, label, { minimum = null, maximum = null } = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    fail(contractId, `${label} must be a number.`);
  }
  if (minimum != null && value < minimum) {
    fail(contractId, `${label} must be >= ${minimum}.`);
  }
  if (maximum != null && value > maximum) {
    fail(contractId, `${label} must be <= ${maximum}.`);
  }
  return value;
}

function asStringArray(value, contractId, label) {
  if (!Array.isArray(value)) {
    fail(contractId, `${label} must be an array.`);
  }
  for (const [index, entry] of value.entries()) {
    asString(entry, contractId, `${label}[${index}]`, { allowEmpty: true });
  }
  return value;
}

function asObjectRecord(value, contractId, label) {
  return asObject(value, contractId, label);
}

function ensureKnownSchemaVersion(contractId, payload, versions) {
  const version = payload?.schemaVersion;
  if (!Number.isInteger(version)) {
    fail(contractId, 'schemaVersion must be an integer.');
  }
  if (!versions.includes(version)) {
    fail(contractId, `Unsupported schemaVersion '${version}'.`);
  }
  return version;
}

function normalizeLegacyValidationResult(payload) {
  const source = asObject(payload, CONTRACT_IDS.validationResult, 'validation result payload');
  return {
    schemaVersion: 1,
    validationId: String(source.validationId ?? '').trim(),
    command: String(source.command ?? '').trim(),
    lane: String(source.lane ?? '').trim(),
    type: String(source.type ?? '').trim(),
    status: String(source.status ?? '').trim().toLowerCase(),
    summary: String(source.summary ?? '').trim(),
    startedAt: String(source.startedAt ?? '').trim(),
    finishedAt: String(source.finishedAt ?? '').trim(),
    evidenceRefs: Array.isArray(source.evidenceRefs) ? source.evidenceRefs.map((entry) => String(entry)) : [],
    artifactRefs: Array.isArray(source.artifactRefs) ? source.artifactRefs.map((entry) => String(entry)) : [],
    findingFiles: Array.isArray(source.findingFiles) ? source.findingFiles.map((entry) => String(entry)) : [],
    outputLogPath: source.outputLogPath == null ? null : String(source.outputLogPath)
  };
}

function validateDownstreamHarnessManifest(payload) {
  const contractId = CONTRACT_IDS.downstreamHarnessManifest;
  asObject(payload, contractId, 'payload');
  ensureKnownSchemaVersion(contractId, payload, [1]);
  asString(payload.ownershipMode, contractId, 'ownershipMode');
  asString(payload.sourceManifest, contractId, 'sourceManifest');
  asString(payload.sourceManifestSha256, contractId, 'sourceManifestSha256');
  if (payload.sourceRevision != null) {
    asNullableString(payload.sourceRevision, contractId, 'sourceRevision');
  }
  asString(payload.installedAt, contractId, 'installedAt');
  if (!Array.isArray(payload.managedFiles)) {
    fail(contractId, 'managedFiles must be an array.');
  }
  for (const [index, entry] of payload.managedFiles.entries()) {
    const item = asObject(entry, contractId, `managedFiles[${index}]`);
    asString(item.sourcePath, contractId, `managedFiles[${index}].sourcePath`);
    asString(item.targetPath, contractId, `managedFiles[${index}].targetPath`);
    asString(item.sha256, contractId, `managedFiles[${index}].sha256`);
    asInteger(item.size, contractId, `managedFiles[${index}].size`, { minimum: 0 });
  }
  return payload;
}

function validateRunState(payload) {
  const contractId = CONTRACT_IDS.runState;
  asObject(payload, contractId, 'payload');
  ensureKnownSchemaVersion(contractId, payload, [1]);
  asString(payload.runId, contractId, 'runId');
  asString(payload.requestedMode, contractId, 'requestedMode');
  asString(payload.effectiveMode, contractId, 'effectiveMode');
  asString(payload.startedAt, contractId, 'startedAt');
  asString(payload.lastUpdated, contractId, 'lastUpdated');
  asStringArray(payload.queue, contractId, 'queue');
  asStringArray(payload.completedPlanIds, contractId, 'completedPlanIds');
  asStringArray(payload.blockedPlanIds, contractId, 'blockedPlanIds');
  asStringArray(payload.failedPlanIds, contractId, 'failedPlanIds');
  asObjectRecord(payload.capabilities, contractId, 'capabilities');
  asObjectRecord(payload.validationState, contractId, 'validationState');
  asObjectRecord(payload.validationResults, contractId, 'validationResults');
  asObjectRecord(payload.recoveryState, contractId, 'recoveryState');
  asObjectRecord(payload.continuationState, contractId, 'continuationState');
  asObjectRecord(payload.sessionState, contractId, 'sessionState');
  asObjectRecord(payload.evidenceState, contractId, 'evidenceState');
  asObjectRecord(payload.implementationState, contractId, 'implementationState');
  asObjectRecord(payload.programState, contractId, 'programState');
  asObjectRecord(payload.roleState, contractId, 'roleState');
  if (payload.orchestrationState != null) {
    asObjectRecord(payload.orchestrationState, contractId, 'orchestrationState');
  }
  const parallelState = asObjectRecord(payload.parallelState, contractId, 'parallelState');
  asObjectRecord(parallelState.activeWorkers, contractId, 'parallelState.activeWorkers');
  asObjectRecord(parallelState.lastResults, contractId, 'parallelState.lastResults');
  if (payload.inProgress != null && (typeof payload.inProgress !== 'object' || Array.isArray(payload.inProgress))) {
    fail(contractId, 'inProgress must be null or an object.');
  }
  const stats = asObjectRecord(payload.stats, contractId, 'stats');
  asInteger(stats.promotions, contractId, 'stats.promotions', { minimum: 0 });
  asInteger(stats.handoffs, contractId, 'stats.handoffs', { minimum: 0 });
  asInteger(stats.validationFailures, contractId, 'stats.validationFailures', { minimum: 0 });
  asInteger(stats.commits, contractId, 'stats.commits', { minimum: 0 });
  asInteger(payload.eventSequence, contractId, 'eventSequence', { minimum: 0 });
  return payload;
}

function migrateRunState(payload) {
  const source = asObject(payload, CONTRACT_IDS.runState, 'run state payload');
  if (Number.isInteger(source.schemaVersion)) {
    return {
      ...source,
      eventSequence: Number.isInteger(source.eventSequence) ? source.eventSequence : 0
    };
  }
  if (!Number.isInteger(source.version) || source.version < 1) {
    fail(CONTRACT_IDS.runState, "Missing supported schemaVersion/version field.");
  }
  return {
    ...source,
    schemaVersion: 1,
    eventSequence: Number.isInteger(source.eventSequence) ? source.eventSequence : 0
  };
}

function validateRunEvent(payload) {
  const contractId = CONTRACT_IDS.runEvent;
  asObject(payload, contractId, 'payload');
  ensureKnownSchemaVersion(contractId, payload, [1]);
  asInteger(payload.sequence, contractId, 'sequence', { minimum: 1 });
  asString(payload.timestamp, contractId, 'timestamp');
  asString(payload.runId, contractId, 'runId');
  asNullableString(payload.taskId, contractId, 'taskId');
  asString(payload.type, contractId, 'type');
  asString(payload.model, contractId, 'model');
  asString(payload.mode, contractId, 'mode');
  asObjectRecord(payload.details, contractId, 'details');
  return payload;
}

function migrateRunEvent(payload) {
  const source = asObject(payload, CONTRACT_IDS.runEvent, 'run event payload');
  if (Number.isInteger(source.schemaVersion) && source.schemaVersion !== 1) {
    return source;
  }
  const sequence = Number.isInteger(source.sequence)
    ? source.sequence
    : Number.isInteger(source.seq)
      ? source.seq
      : (typeof source.sequence === 'string' && NON_NEGATIVE_INTEGER.test(source.sequence)
          ? Number.parseInt(source.sequence, 10)
          : (typeof source.seq === 'string' && NON_NEGATIVE_INTEGER.test(source.seq)
              ? Number.parseInt(source.seq, 10)
              : null));
  if (Number.isInteger(source.schemaVersion) && sequence != null) {
    return {
      ...source,
      sequence,
      seq: undefined
    };
  }
  if (sequence == null) {
    fail(CONTRACT_IDS.runEvent, 'Legacy run-event payload requires sequence.');
  }
  return {
    schemaVersion: 1,
    sequence,
    timestamp: String(source.timestamp ?? '').trim(),
    runId: String(source.runId ?? '').trim(),
    taskId: source.taskId == null ? null : String(source.taskId),
    type: String(source.type ?? '').trim(),
    model: String(source.model ?? 'n/a').trim() || 'n/a',
    mode: String(source.mode ?? '').trim(),
    details: source.details && typeof source.details === 'object' && !Array.isArray(source.details) ? source.details : {}
  };
}

function migrateContinuityLatestState(payload) {
  const contractId = CONTRACT_IDS.continuityLatestState;
  const source = asObject(payload, contractId, 'continuity latest state payload');
  const reasoning = source.reasoning && typeof source.reasoning === 'object' && !Array.isArray(source.reasoning)
    ? source.reasoning
    : {};
  const evidence = source.evidence && typeof source.evidence === 'object' && !Array.isArray(source.evidence)
    ? source.evidence
    : {};
  const quality = source.quality && typeof source.quality === 'object' && !Array.isArray(source.quality)
    ? source.quality
    : {};
  return {
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 2,
    planId: String(source.planId ?? '').trim(),
    goal: String(source.goal ?? source.planId ?? 'legacy continuity state').trim() || 'legacy continuity state',
    currentSubtask: String(source.currentSubtask ?? '').trim(),
    status: String(source.status ?? '').trim(),
    roleCursor: {
      role: String(source.roleCursor?.role ?? source.role ?? 'worker').trim() || 'worker',
      stageIndex: Number.isInteger(source.roleCursor?.stageIndex) ? source.roleCursor.stageIndex : 1,
      stageTotal: Number.isInteger(source.roleCursor?.stageTotal) ? source.roleCursor.stageTotal : 1,
      session: Number.isInteger(source.roleCursor?.session) ? source.roleCursor.session : Math.max(1, Number(source.session ?? 1) || 1)
    },
    acceptedFacts: Array.isArray(source.acceptedFacts) ? source.acceptedFacts.map((entry) => String(entry)) : [],
    decisions: Array.isArray(source.decisions) ? source.decisions.map((entry) => String(entry)) : [],
    openQuestions: Array.isArray(source.openQuestions) ? source.openQuestions.map((entry) => String(entry)) : [],
    pendingActions: Array.isArray(source.pendingActions) ? source.pendingActions.map((entry) => String(entry)) : [],
    completedWork: Array.isArray(source.completedWork) ? source.completedWork.map((entry) => String(entry)) : [],
    recentResults: Array.isArray(source.recentResults) ? source.recentResults.map((entry) => String(entry)) : [],
    artifacts: Array.isArray(source.artifacts) ? source.artifacts.map((entry) => String(entry)) : [],
    risks: Array.isArray(source.risks) ? source.risks.map((entry) => String(entry)) : [],
    reasoning: {
      nextAction: String(source.nextAction ?? reasoning.nextAction ?? '').trim(),
      blockers: Array.isArray(reasoning.blockers) ? reasoning.blockers.map((entry) => String(entry)) : [],
      rationale: Array.isArray(reasoning.rationale) ? reasoning.rationale.map((entry) => String(entry)) : []
    },
    evidence: {
      artifactRefs: Array.isArray(evidence.artifactRefs) ? evidence.artifactRefs.map((entry) => String(entry)) : [],
      extractedFacts: Array.isArray(evidence.extractedFacts) ? evidence.extractedFacts.map((entry) => String(entry)) : [],
      logRefs: Array.isArray(evidence.logRefs) ? evidence.logRefs.map((entry) => String(entry)) : [],
      validationRefs: Array.isArray(evidence.validationRefs) ? evidence.validationRefs.map((entry) => String(entry)) : []
    },
    quality: {
      score: typeof quality.score === 'number' ? quality.score : 0,
      resumeSafe: quality.resumeSafe === true,
      missingFields: Array.isArray(quality.missingFields) ? quality.missingFields.map((entry) => String(entry)) : [],
      degradedReasons: Array.isArray(quality.degradedReasons) ? quality.degradedReasons.map((entry) => String(entry)) : []
    },
    updatedAt: String(source.updatedAt ?? source.createdAt ?? '1970-01-01T00:00:00.000Z').trim() || '1970-01-01T00:00:00.000Z'
  };
}

function migrateContinuityCheckpoint(payload) {
  const contractId = CONTRACT_IDS.continuityCheckpoint;
  const source = asObject(payload, contractId, 'continuity checkpoint payload');
  const stateDelta = source.stateDelta && typeof source.stateDelta === 'object' && !Array.isArray(source.stateDelta)
    ? source.stateDelta
    : {};
  const reasoning = stateDelta.reasoning && typeof stateDelta.reasoning === 'object' && !Array.isArray(stateDelta.reasoning)
    ? stateDelta.reasoning
    : {};
  const evidence = stateDelta.evidence && typeof stateDelta.evidence === 'object' && !Array.isArray(stateDelta.evidence)
    ? stateDelta.evidence
    : {};
  const quality = source.quality && typeof source.quality === 'object' && !Array.isArray(source.quality)
    ? source.quality
    : {};
  return {
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 2,
    createdAt: String(source.createdAt ?? '1970-01-01T00:00:00.000Z').trim() || '1970-01-01T00:00:00.000Z',
    planId: String(source.planId ?? '').trim(),
    runId: String(source.runId ?? 'legacy-run').trim() || 'legacy-run',
    session: Math.max(1, Number(source.session ?? 1) || 1),
    role: String(source.role ?? 'worker').trim() || 'worker',
    stageIndex: Math.max(1, Number(source.stageIndex ?? 1) || 1),
    stageTotal: Math.max(1, Number(source.stageTotal ?? 1) || 1),
    status: String(source.status ?? 'pending').trim() || 'pending',
    summary: String(source.summary ?? source.currentSubtask ?? '').trim(),
    reason: String(source.reason ?? '').trim(),
    currentSubtask: String(source.currentSubtask ?? '').trim(),
    nextAction: String(source.nextAction ?? reasoning.nextAction ?? '').trim(),
    contextRemaining: typeof source.contextRemaining === 'number' ? source.contextRemaining : null,
    contextWindow: typeof source.contextWindow === 'number' ? source.contextWindow : null,
    contextUsedRatio: typeof source.contextUsedRatio === 'number' ? source.contextUsedRatio : null,
    contactPackFile: String(source.contactPackFile ?? '').trim(),
    contactPackManifestFile: String(source.contactPackManifestFile ?? '').trim(),
    contactPackThin: source.contactPackThin === true,
    contactPackThinPackMissingCategories: Array.isArray(source.contactPackThinPackMissingCategories)
      ? source.contactPackThinPackMissingCategories.map((entry) => String(entry))
      : [],
    sessionLogPath: String(source.sessionLogPath ?? '').trim(),
    touchSamples: Array.isArray(source.touchSamples) ? source.touchSamples.map((entry) => String(entry)) : [],
    stateDelta: {
      completedWork: Array.isArray(stateDelta.completedWork) ? stateDelta.completedWork.map((entry) => String(entry)) : [],
      acceptedFacts: Array.isArray(stateDelta.acceptedFacts) ? stateDelta.acceptedFacts.map((entry) => String(entry)) : [],
      decisions: Array.isArray(stateDelta.decisions) ? stateDelta.decisions.map((entry) => String(entry)) : [],
      openQuestions: Array.isArray(stateDelta.openQuestions) ? stateDelta.openQuestions.map((entry) => String(entry)) : [],
      pendingActions: Array.isArray(stateDelta.pendingActions) ? stateDelta.pendingActions.map((entry) => String(entry)) : [],
      recentResults: Array.isArray(stateDelta.recentResults) ? stateDelta.recentResults.map((entry) => String(entry)) : [],
      artifacts: Array.isArray(stateDelta.artifacts) ? stateDelta.artifacts.map((entry) => String(entry)) : [],
      risks: Array.isArray(stateDelta.risks) ? stateDelta.risks.map((entry) => String(entry)) : [],
      reasoning: {
        nextAction: String(stateDelta.nextAction ?? reasoning.nextAction ?? '').trim(),
        blockers: Array.isArray(reasoning.blockers) ? reasoning.blockers.map((entry) => String(entry)) : [],
        rationale: Array.isArray(reasoning.rationale) ? reasoning.rationale.map((entry) => String(entry)) : []
      },
      evidence: {
        artifactRefs: Array.isArray(evidence.artifactRefs) ? evidence.artifactRefs.map((entry) => String(entry)) : [],
        extractedFacts: Array.isArray(evidence.extractedFacts) ? evidence.extractedFacts.map((entry) => String(entry)) : [],
        logRefs: Array.isArray(evidence.logRefs) ? evidence.logRefs.map((entry) => String(entry)) : [],
        validationRefs: Array.isArray(evidence.validationRefs) ? evidence.validationRefs.map((entry) => String(entry)) : []
      }
    },
    quality: {
      score: typeof quality.score === 'number' ? quality.score : 0,
      resumeSafe: quality.resumeSafe === true,
      missingFields: Array.isArray(quality.missingFields) ? quality.missingFields.map((entry) => String(entry)) : [],
      degradedReasons: Array.isArray(quality.degradedReasons) ? quality.degradedReasons.map((entry) => String(entry)) : []
    }
  };
}

function validateCheckpointQuality(value, contractId, label) {
  const quality = asObject(value, contractId, label);
  asNumber(quality.score, contractId, `${label}.score`, { minimum: 0, maximum: 1 });
  asBoolean(quality.resumeSafe, contractId, `${label}.resumeSafe`);
  asStringArray(quality.missingFields, contractId, `${label}.missingFields`);
  asStringArray(quality.degradedReasons, contractId, `${label}.degradedReasons`);
}

function validateContinuityDelta(value, contractId, label) {
  const delta = asObject(value, contractId, label);
  asStringArray(delta.completedWork, contractId, `${label}.completedWork`);
  asStringArray(delta.acceptedFacts, contractId, `${label}.acceptedFacts`);
  asStringArray(delta.decisions, contractId, `${label}.decisions`);
  asStringArray(delta.openQuestions, contractId, `${label}.openQuestions`);
  asStringArray(delta.pendingActions, contractId, `${label}.pendingActions`);
  asStringArray(delta.recentResults, contractId, `${label}.recentResults`);
  asStringArray(delta.artifacts, contractId, `${label}.artifacts`);
  asStringArray(delta.risks, contractId, `${label}.risks`);
  const reasoning = asObject(delta.reasoning, contractId, `${label}.reasoning`);
  asString(reasoning.nextAction, contractId, `${label}.reasoning.nextAction`, { allowEmpty: true });
  asStringArray(reasoning.blockers, contractId, `${label}.reasoning.blockers`);
  asStringArray(reasoning.rationale, contractId, `${label}.reasoning.rationale`);
  const evidence = asObject(delta.evidence, contractId, `${label}.evidence`);
  asStringArray(evidence.artifactRefs, contractId, `${label}.evidence.artifactRefs`);
  asStringArray(evidence.extractedFacts, contractId, `${label}.evidence.extractedFacts`);
  asStringArray(evidence.logRefs, contractId, `${label}.evidence.logRefs`);
  asStringArray(evidence.validationRefs, contractId, `${label}.evidence.validationRefs`);
}

function validateContinuityLatestState(payload) {
  const contractId = CONTRACT_IDS.continuityLatestState;
  asObject(payload, contractId, 'payload');
  ensureKnownSchemaVersion(contractId, payload, [1, 2]);
  asString(payload.planId, contractId, 'planId');
  asString(payload.goal, contractId, 'goal');
  asString(payload.currentSubtask, contractId, 'currentSubtask', { allowEmpty: true });
  asString(payload.status, contractId, 'status', { allowEmpty: true });
  const roleCursor = asObject(payload.roleCursor, contractId, 'roleCursor');
  asString(roleCursor.role, contractId, 'roleCursor.role');
  asInteger(roleCursor.stageIndex, contractId, 'roleCursor.stageIndex', { minimum: 1 });
  asInteger(roleCursor.stageTotal, contractId, 'roleCursor.stageTotal', { minimum: 1 });
  asInteger(roleCursor.session, contractId, 'roleCursor.session', { minimum: 1 });
  asStringArray(payload.acceptedFacts, contractId, 'acceptedFacts');
  asStringArray(payload.decisions, contractId, 'decisions');
  asStringArray(payload.openQuestions, contractId, 'openQuestions');
  asStringArray(payload.pendingActions, contractId, 'pendingActions');
  asStringArray(payload.completedWork, contractId, 'completedWork');
  asStringArray(payload.recentResults, contractId, 'recentResults');
  asStringArray(payload.artifacts, contractId, 'artifacts');
  asStringArray(payload.risks, contractId, 'risks');
  validateContinuityDelta({
    completedWork: payload.completedWork,
    acceptedFacts: payload.acceptedFacts,
    decisions: payload.decisions,
    openQuestions: payload.openQuestions,
    pendingActions: payload.pendingActions,
    recentResults: payload.recentResults,
    artifacts: payload.artifacts,
    risks: payload.risks,
    reasoning: payload.reasoning,
    evidence: payload.evidence
  }, contractId, 'continuity');
  validateCheckpointQuality(payload.quality, contractId, 'quality');
  asString(payload.updatedAt, contractId, 'updatedAt', { allowEmpty: true });
  return payload;
}

function validateContinuityCheckpoint(payload) {
  const contractId = CONTRACT_IDS.continuityCheckpoint;
  asObject(payload, contractId, 'payload');
  ensureKnownSchemaVersion(contractId, payload, [1, 2]);
  asString(payload.createdAt, contractId, 'createdAt', { allowEmpty: true });
  asString(payload.planId, contractId, 'planId');
  asString(payload.runId, contractId, 'runId', { allowEmpty: true });
  asInteger(payload.session, contractId, 'session', { minimum: 1 });
  asString(payload.role, contractId, 'role');
  asInteger(payload.stageIndex, contractId, 'stageIndex', { minimum: 1 });
  asInteger(payload.stageTotal, contractId, 'stageTotal', { minimum: 1 });
  asString(payload.status, contractId, 'status');
  asString(payload.summary, contractId, 'summary', { allowEmpty: true });
  asString(payload.reason, contractId, 'reason', { allowEmpty: true });
  asString(payload.currentSubtask, contractId, 'currentSubtask', { allowEmpty: true });
  asString(payload.nextAction, contractId, 'nextAction', { allowEmpty: true });
  if (payload.contextRemaining != null) {
    asNumber(payload.contextRemaining, contractId, 'contextRemaining');
  }
  if (payload.contextWindow != null) {
    asNumber(payload.contextWindow, contractId, 'contextWindow');
  }
  if (payload.contextUsedRatio != null) {
    asNumber(payload.contextUsedRatio, contractId, 'contextUsedRatio', { minimum: 0, maximum: 1 });
  }
  asString(payload.contactPackFile ?? '', contractId, 'contactPackFile', { allowEmpty: true });
  asString(payload.contactPackManifestFile ?? '', contractId, 'contactPackManifestFile', { allowEmpty: true });
  if ('contactPackThin' in payload) {
    asBoolean(payload.contactPackThin, contractId, 'contactPackThin');
  }
  if ('contactPackThinPackMissingCategories' in payload) {
    asStringArray(payload.contactPackThinPackMissingCategories, contractId, 'contactPackThinPackMissingCategories');
  }
  asString(payload.sessionLogPath ?? '', contractId, 'sessionLogPath', { allowEmpty: true });
  if ('touchSamples' in payload) {
    asStringArray(payload.touchSamples, contractId, 'touchSamples');
  }
  validateContinuityDelta(payload.stateDelta, contractId, 'stateDelta');
  validateCheckpointQuality(payload.quality, contractId, 'quality');
  return payload;
}

function validateValidationResult(payload) {
  const contractId = CONTRACT_IDS.validationResult;
  asObject(payload, contractId, 'payload');
  ensureKnownSchemaVersion(contractId, payload, [1]);
  asString(payload.validationId, contractId, 'validationId');
  asString(payload.command, contractId, 'command');
  asString(payload.lane, contractId, 'lane');
  asString(payload.type, contractId, 'type', { allowEmpty: true });
  const status = asString(payload.status, contractId, 'status');
  if (!['passed', 'failed', 'pending'].includes(status)) {
    fail(contractId, `Unsupported status '${status}'.`);
  }
  asString(payload.summary, contractId, 'summary', { allowEmpty: true });
  asString(payload.startedAt, contractId, 'startedAt', { allowEmpty: true });
  asString(payload.finishedAt, contractId, 'finishedAt', { allowEmpty: true });
  asStringArray(payload.evidenceRefs, contractId, 'evidenceRefs');
  asStringArray(payload.artifactRefs, contractId, 'artifactRefs');
  asStringArray(payload.findingFiles, contractId, 'findingFiles');
  asNullableString(payload.outputLogPath, contractId, 'outputLogPath');
  return payload;
}

const registry = {
  [CONTRACT_IDS.downstreamHarnessManifest]: {
    latestSchemaVersion: 1,
    migrate(payload) {
      return payload;
    },
    validate: validateDownstreamHarnessManifest
  },
  [CONTRACT_IDS.runState]: {
    latestSchemaVersion: 1,
    migrate: migrateRunState,
    validate: validateRunState
  },
  [CONTRACT_IDS.runEvent]: {
    latestSchemaVersion: 1,
    migrate: migrateRunEvent,
    validate: validateRunEvent
  },
  [CONTRACT_IDS.continuityLatestState]: {
    latestSchemaVersion: 2,
    migrate: migrateContinuityLatestState,
    validate: validateContinuityLatestState
  },
  [CONTRACT_IDS.continuityCheckpoint]: {
    latestSchemaVersion: 2,
    migrate: migrateContinuityCheckpoint,
    validate: validateContinuityCheckpoint
  },
  [CONTRACT_IDS.validationResult]: {
    latestSchemaVersion: 1,
    migrate: normalizeLegacyValidationResult,
    validate: validateValidationResult
  }
};

export function contractDescriptor(contractId) {
  const descriptor = registry[contractId];
  if (!descriptor) {
    throw new Error(`Unknown contract '${contractId}'.`);
  }
  return descriptor;
}

export function parseContractPayload(contractId, payload) {
  const descriptor = contractDescriptor(contractId);
  const migrated = descriptor.migrate(payload);
  descriptor.validate(migrated);
  return migrated;
}

export function prepareContractPayload(contractId, payload) {
  const descriptor = contractDescriptor(contractId);
  const normalized = {
    ...payload,
    schemaVersion: descriptor.latestSchemaVersion
  };
  descriptor.validate(normalized);
  return normalized;
}
