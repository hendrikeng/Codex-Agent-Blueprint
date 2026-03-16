import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templateRoot = path.join(repoRoot, 'template');

async function createFixtureRoot() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-full-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });
  return rootDir;
}

test('verify-full wires outcome and perf verifiers', async () => {
  const rootDir = await createFixtureRoot();

  const result = spawnSync(
    'node',
    ['./scripts/automation/verify-full.mjs', '--dry-run', 'true'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: process.env
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /summarize-run-outcomes\.mjs/);
  assert.match(result.stdout, /check-outcomes-thresholds\.mjs/);
  assert.match(result.stdout, /check-performance-budgets\.mjs/);
  assert.match(result.stdout, /verify-orchestration-state\.mjs/);
  assert.doesNotMatch(result.stdout, /check-outcomes-thresholds\.mjs --warn-only/);
});
