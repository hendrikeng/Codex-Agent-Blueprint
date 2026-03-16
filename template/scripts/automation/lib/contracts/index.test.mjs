import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_IDS,
  parseContractPayload,
  prepareContractPayload
} from './index.mjs';

test('run-state migrates legacy versioned payloads to schemaVersion 1', () => {
  const payload = parseContractPayload(CONTRACT_IDS.runState, {
    version: 7,
    runId: 'run-1',
    requestedMode: 'guarded',
    effectiveMode: 'guarded',
    startedAt: '2026-03-16T00:00:00.000Z',
    lastUpdated: '2026-03-16T00:00:00.000Z',
    queue: [],
    completedPlanIds: [],
    blockedPlanIds: [],
    failedPlanIds: [],
    capabilities: {},
    validationState: {},
    validationResults: {},
    recoveryState: {},
    continuationState: {},
    sessionState: {},
    evidenceState: {},
    implementationState: {},
    programState: {},
    roleState: {},
    orchestrationState: {},
    parallelState: { activeWorkers: {}, lastResults: {} },
    inProgress: null,
    stats: {
      promotions: 0,
      handoffs: 0,
      validationFailures: 0,
      commits: 0
    }
  });

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.eventSequence, 0);
});

test('run-event rejects unsupported schema versions', () => {
  assert.throws(
    () => parseContractPayload(CONTRACT_IDS.runEvent, { schemaVersion: 9 }),
    /Unsupported schemaVersion/
  );
});

test('run-event migrates legacy payload when sequence is supplied', () => {
  const payload = parseContractPayload(CONTRACT_IDS.runEvent, {
    sequence: 3,
    timestamp: '2026-03-16T00:00:00.000Z',
    runId: 'run-1',
    taskId: null,
    type: 'run_started',
    model: 'n/a',
    mode: 'guarded',
    details: {}
  });

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.sequence, 3);
});

test('validation-result upgrades unversioned payloads to schemaVersion 1', () => {
  const payload = parseContractPayload(CONTRACT_IDS.validationResult, {
    validationId: 'repo:verify-fast',
    command: 'npm run verify:fast',
    lane: 'always',
    type: 'integration',
    status: 'passed',
    summary: 'ok',
    evidenceRefs: ['docs/generated/run-outcomes.json'],
    artifactRefs: [],
    findingFiles: [],
    outputLogPath: null
  });

  assert.equal(payload.schemaVersion, 1);
});

test('prepareContractPayload injects latest schema version for contact-pack manifests', () => {
  const payload = prepareContractPayload(CONTRACT_IDS.contactPackManifest, {
    generatedAt: '2026-03-16T00:00:00.000Z',
    planId: 'plan-a',
    runId: 'run-1',
    role: 'worker',
    deliveryClass: 'product',
    executionScope: 'slice',
    parentPlanId: null,
    implementationTargets: ['src/index.js'],
    stageIndex: 1,
    stageTotal: 1,
    selectionMaxItems: 6,
    selectedInputs: [
      {
        itemId: 'checkpoint-1',
        category: 'checkpoint',
        type: 'same-role-checkpoint',
        score: 7,
        reasons: ['recency'],
        role: 'worker',
        stageIndex: 1,
        value: 'status=in-progress'
      }
    ],
    candidateCount: 1,
    thinPack: false,
    missingCategories: []
  });

  assert.equal(payload.schemaVersion, 1);
});

test('downstream harness manifest requires managedFiles entries with size', () => {
  assert.throws(
    () => parseContractPayload(CONTRACT_IDS.downstreamHarnessManifest, {
      schemaVersion: 1,
      ownershipMode: 'template-sync',
      sourceManifest: 'distribution/harness-ownership-manifest.json',
      sourceManifestSha256: 'abc',
      sourceRevision: 'deadbeef',
      installedAt: '2026-03-16T00:00:00.000Z',
      managedFiles: [{ sourcePath: 'template/README.md', targetPath: 'README.md', sha256: 'abc' }]
    }),
    /size/
  );
});
