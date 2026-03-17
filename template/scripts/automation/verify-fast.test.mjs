import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createTemplateRepo, runNode } from './test-helpers.mjs';

test('verify-fast dry-run lists the flat queue safety checks', async () => {
  const rootDir = await createTemplateRepo();
  const result = runNode(path.join(rootDir, 'scripts', 'automation', 'verify-fast.mjs'), ['--dry-run'], rootDir);

  assert.equal(result.status, 0, String(result.stderr));
  const stdout = String(result.stdout);
  assert.match(stdout, /compile-runtime-context/);
  assert.match(stdout, /check-plan-metadata/);
  assert.match(stdout, /check-harness-alignment/);
  assert.doesNotMatch(stdout, /verify-orchestration-state/);
  assert.doesNotMatch(stdout, /check-performance-budgets/);
});

test('verify-fast adds architecture verification when architecture files changed', async () => {
  const rootDir = await createTemplateRepo();
  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'verify-fast.mjs'),
    ['--dry-run'],
    rootDir,
    { VERIFY_FAST_FILES: 'ARCHITECTURE.md' }
  );

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /check-dependencies/);
});

test('verify-fast uses dry-run plan reference repair during orchestrated validation', async () => {
  const rootDir = await createTemplateRepo();
  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'verify-fast.mjs'),
    ['--dry-run'],
    rootDir,
    { ORCH_PLAN_ID: 'red-inbox' }
  );

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /repair-plan-references\.mjs --dry-run/);
  assert.match(String(result.stdout), /check-plan-metadata\.mjs --plan-id red-inbox/);
});
