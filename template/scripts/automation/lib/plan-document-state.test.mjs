import test from 'node:test';
import assert from 'node:assert/strict';

import { appendToDeliveryLog, setPlanDocumentFields, upsertSection } from './plan-document-state.mjs';

test('setPlanDocumentFields keeps metadata status authoritative without a standalone status line', () => {
  const content = [
    '# Plan',
    '',
    'Status: queued',
    '',
    '## Metadata',
    '',
    '- Plan-ID: example-plan',
    '- Status: queued',
    '',
    '## Must-Land Checklist',
    '',
    '- [ ] `ml-example-plan` Ship it.'
  ].join('\n');

  const updated = setPlanDocumentFields(content, { Status: 'validation' });
  assert.match(updated, /^- Status: validation$/m);
  assert.doesNotMatch(updated, /^Status:\s+/m);
});

test('appendToDeliveryLog appends stable bullet entries', () => {
  const content = '# Plan\n';
  const updated = appendToDeliveryLog(content, 'Promoted from future.');
  assert.match(updated, /## Automated Delivery Log/);
  assert.match(updated, /- Promoted from future\./);
});

test('upsertSection creates or replaces a section body', () => {
  const created = upsertSection('# Plan\n', 'Blockers', ['- Waiting on review']);
  assert.match(created, /## Blockers/);
  const updated = upsertSection(created, 'Blockers', ['- Cleared']);
  assert.match(updated, /- Cleared/);
  assert.doesNotMatch(updated, /Waiting on review/);
});
