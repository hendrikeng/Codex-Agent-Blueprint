import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSemanticProofCoverage,
  normalizeValidationResultPayload
} from './validation-completion.mjs';

test('normalizeValidationResultPayload normalizes refs and status fields', () => {
  const result = normalizeValidationResultPayload(
    {
      validationId: 'repo:verify-fast',
      status: 'PASSED',
      startedAt: '2026-03-15T10:00:00Z',
      finishedAt: '2026-03-15T10:01:00Z',
      evidenceRefs: ['./docs/output.json'],
      artifactRefs: [' logs/run.log '],
      findingFiles: ['./src/app.ts']
    },
    {
      id: 'fallback-id',
      type: 'integration'
    },
    'always',
    'npm run verify:fast',
    'docs/output.log'
  );

  assert.equal(result.validationId, 'repo:verify-fast');
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.evidenceRefs, ['docs/output.json']);
  assert.deepEqual(result.artifactRefs, ['logs/run.log']);
  assert.deepEqual(result.findingFiles, ['src/app.ts']);
  assert.equal(result.outputLogPath, 'docs/output.log');
});

test('evaluateSemanticProofCoverage marks mapped must-land items as covered with fresh proof', () => {
  const plan = {
    planId: 'example-plan',
    deliveryClass: 'product',
    executionScope: 'slice',
    content: [
      '# Example Plan',
      '',
      '## Must-Land Checklist',
      '',
      '- [x] `ml-example` Ship example capability',
      '',
      '## Capability Proof Map',
      '',
      '| Capability ID | Must-Land IDs | Claim | Required Strength |',
      '| --- | --- | --- | --- |',
      '| cap-example | ml-example | Example capability ships | weak |',
      '',
      '| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |',
      '| --- | --- | --- | --- | --- | --- |',
      '| proof-example | cap-example | integration | always | repo:verify-fast | same-run |',
      ''
    ].join('\n')
  };
  const state = {
    implementationState: {
      'example-plan': {
        lastRecordedAt: '2026-03-15T10:00:00Z'
      }
    },
    validationResults: {
      'example-plan': {
        always: [
          {
            validationId: 'repo:verify-fast',
            status: 'passed',
            finishedAt: '2026-03-15T10:05:00Z',
            evidenceRefs: [],
            artifactRefs: []
          }
        ],
        'host-required': []
      }
    }
  };

  const report = evaluateSemanticProofCoverage(plan, state, {
    semanticProof: {
      mode: 'advisory'
    }
  });

  assert.equal(report.applicable, true);
  assert.equal(report.satisfied, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.mustLandCoverage, [
    {
      mustLandId: 'ml-example',
      satisfied: true,
      capabilities: ['cap-example']
    }
  ]);
});

test('evaluateSemanticProofCoverage accepts strong repo validation refs when the validation type is strong', () => {
  const plan = {
    planId: 'example-plan',
    deliveryClass: 'product',
    executionScope: 'slice',
    content: [
      '# Example Plan',
      '',
      '## Must-Land Checklist',
      '',
      '- [x] `ml-example` Ship example capability',
      '',
      '## Capability Proof Map',
      '',
      '| Capability ID | Must-Land IDs | Claim | Required Strength |',
      '| --- | --- | --- | --- |',
      '| cap-example | ml-example | Example capability ships | strong |',
      '',
      '| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |',
      '| --- | --- | --- | --- | --- | --- |',
      '| proof-example | cap-example | host-required | host-required | repo:verify-full | same-run |',
      ''
    ].join('\n')
  };
  const state = {
    implementationState: {
      'example-plan': {
        lastRecordedAt: '2026-03-15T10:00:00Z'
      }
    },
    validationResults: {
      'example-plan': {
        always: [],
        'host-required': [
          {
            validationId: 'repo:verify-full',
            status: 'passed',
            finishedAt: '2026-03-15T10:05:00Z',
            evidenceRefs: [],
            artifactRefs: []
          }
        ]
      }
    }
  };

  const report = evaluateSemanticProofCoverage(plan, state, {
    semanticProof: {
      mode: 'required'
    }
  });

  assert.equal(report.applicable, true);
  assert.equal(report.satisfied, true);
  assert.deepEqual(report.issues, []);
});
