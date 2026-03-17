import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNode } from './test-helpers.mjs';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-plan-metadata.mjs');

function validFuturePlan(extraMetadata = '', extraSections = '') {
  return `# Red Inbox

Status: ready-for-promotion

## Metadata

- Plan-ID: red-inbox
- Status: ready-for-promotion
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Inbox is red.
- Delivery-Class: product
- Dependencies: none
- Spec-Targets: docs/spec.md
- Implementation-Targets: src/inbox.js
- Risk-Tier: medium
- Validation-Lanes: always
- Security-Approval: not-required
- Done-Evidence: pending
${extraMetadata}

## Already-True Baseline

- Inbox exists.

## Must-Land Checklist

- [ ] \`ml-red-inbox\` Make the inbox red.

## Deferred Follow-Ons

- None.
${extraSections}
`;
}

test('plans:verify accepts a direct future slice without legacy program metadata', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plans-verify-valid-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'docs', 'future', '2026-03-17-red-inbox.md'), validFuturePlan(), 'utf8');

  const result = runNode(scriptPath, [], rootDir);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /\[plans:verify\] ok/);
});

test('plans:verify accepts dependencies that resolve to completed plans in default scope', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plans-verify-completed-deps-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'docs', 'exec-plans', 'completed'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-red-inbox.md'),
    validFuturePlan('\n- Dependencies: shipped-foundation'),
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-16-shipped-foundation.md'),
    validFuturePlan(
      '\n- Plan-ID: shipped-foundation\n- Status: completed\n- Done-Evidence: docs/exec-plans/evidence-index/shipped-foundation.md'
    )
      .replace(/^Status:\s+ready-for-promotion$/m, 'Status: completed')
      .replace(/^- Status:\s+ready-for-promotion$/m, '- Status: completed')
      .replace(/^- Dependencies:\s+none$/m, '- Dependencies: none')
      .replace(/- \[ \] `ml-red-inbox` Make the inbox red\./, '- [x] `ml-red-inbox` Make the inbox red.'),
    'utf8'
  );

  const result = runNode(scriptPath, [], rootDir);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /\[plans:verify\] ok/);
});

test('plans:verify rejects legacy execution-scope metadata and child sections', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plans-verify-legacy-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-red-inbox.md'),
    validFuturePlan(
      '\n- Execution-Scope: program',
      '\n## Child Slice Definitions\n\n### child-a\n- draft'
    ),
    'utf8'
  );

  const result = runNode(scriptPath, [], rootDir);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /LEGACY_METADATA_FIELD/);
  assert.match(String(result.stderr), /LEGACY_SECTION/);
});
