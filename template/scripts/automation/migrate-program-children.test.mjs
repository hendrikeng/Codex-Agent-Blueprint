import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateProgramChildDefinitions } from './migrate-program-children.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('migrateProgramChildDefinitions converts legacy headings into structured child definitions', () => {
  const source = `# Parent Program

## Metadata

- Plan-ID: parent-program
- Delivery-Class: product
- Execution-Scope: program
- Spec-Targets: docs/spec.md, src/feature

## Remaining Execution Slices

### 1. Search Flow: search-flow

### PU-2 (later): Checkout Flow
`;

  const result = migrateProgramChildDefinitions(source);

  assert.equal(result.declarations.length, 2);
  assert.match(result.content, /## Child Slice Definitions/);
  assert.match(result.content, /### search-flow/);
  assert.match(result.content, /### checkout-flow/);
  assert.match(result.content, /- Implementation-Targets: src\/feature/);
  assert.doesNotMatch(result.content, /## Remaining Execution Slices/);
});

test('cli write mode rewrites the plan file in place', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-program-children-'));
  const planPath = path.join(rootDir, 'parent.md');
  await fs.writeFile(planPath, `# Parent Program

## Metadata

- Plan-ID: parent-program
- Delivery-Class: docs
- Execution-Scope: program
- Spec-Targets: docs/spec.md

## Portfolio Units

### 1. Docs Cleanup
`, 'utf8');

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('node', [
    './template/scripts/automation/migrate-program-children.mjs',
    '--plan-file',
    planPath,
    '--write',
    'true'
  ], {
    cwd: repoRoot,
    stdio: 'pipe'
  });

  assert.equal(result.status, 0);
  const updated = await fs.readFile(planPath, 'utf8');
  assert.match(updated, /## Child Slice Definitions/);
  assert.doesNotMatch(updated, /## Portfolio Units/);
});
