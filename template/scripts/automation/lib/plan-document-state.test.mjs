import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completionGateReadyForValidation,
  documentStatusValue,
  documentValidationReadyValue,
  setPlanDocumentFields
} from './plan-document-state.mjs';

test('setPlanDocumentFields keeps top-level and metadata status fields aligned', () => {
  const content = [
    '# Example Plan',
    '',
    'Status: queued',
    'Validation-Ready: no',
    '',
    '## Metadata',
    '',
    '- Plan-ID: example-plan',
    '- Status: queued',
    '- Validation-Ready: no',
    ''
  ].join('\n');

  const updated = setPlanDocumentFields(content, {
    Status: 'validation',
    'Validation-Ready': 'host-required-only'
  });

  assert.match(updated, /^Status: validation$/m);
  assert.match(updated, /^Validation-Ready: host-required-only$/m);
  assert.match(updated, /^- Status: validation$/m);
  assert.match(updated, /^- Validation-Ready: host-required-only$/m);
  assert.equal(documentStatusValue(updated), 'validation');
  assert.equal(documentValidationReadyValue(updated), 'host-required-only');
});

test('completionGateReadyForValidation requires explicit validation-ready for validation state', () => {
  assert.equal(completionGateReadyForValidation('completed', ''), true);
  assert.equal(completionGateReadyForValidation('validation', 'yes'), true);
  assert.equal(completionGateReadyForValidation('validation', 'host-required-only'), true);
  assert.equal(completionGateReadyForValidation('validation', ''), false);
  assert.equal(completionGateReadyForValidation('in-progress', 'yes'), false);
});
