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
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-fast-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });
  return rootDir;
}

test('verify-fast preserves absolute ORCH_VALIDATION_RESULT_PATH values', async () => {
  const rootDir = await createFixtureRoot();
  const absResultPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'verify-fast-result-')), 'result.json');

  const result = spawnSync(
    'node',
    ['./scripts/automation/verify-fast.mjs', '--dry-run', 'true'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCH_VALIDATION_RESULT_PATH: absResultPath
      }
    }
  );

  assert.equal(result.status, 0);
  const payload = JSON.parse(await fs.readFile(absResultPath, 'utf8'));
  assert.equal(payload.status, 'passed');

  const repoShadowPath = path.join(rootDir, absResultPath.replace(/^\/+/, ''));
  await assert.rejects(fs.access(repoShadowPath));
});

test('verify-fast includes Program 3 gates for automation changes', async () => {
  const rootDir = await createFixtureRoot();

  const result = spawnSync(
    'node',
    ['./scripts/automation/verify-fast.mjs', '--dry-run', 'true'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        VERIFY_FAST_FILES: 'scripts/automation/verify-full.mjs'
      }
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /check-outcomes-thresholds\.mjs/);
  assert.match(result.stdout, /check-performance-budgets\.mjs/);
  assert.match(result.stdout, /verify-orchestration-state\.mjs/);
  assert.doesNotMatch(result.stdout, /check-outcomes-thresholds\.mjs --warn-only/);
});
