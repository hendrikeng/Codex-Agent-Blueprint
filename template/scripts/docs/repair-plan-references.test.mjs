import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = path.join(repoRoot, 'template', 'scripts', 'docs', 'repair-plan-references.mjs');

function runRepair(rootDir, args = ['--dry-run']) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd: rootDir,
    encoding: 'utf8'
  });
}

test('repair-plan-references leaves existing future plan links untouched', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-plan-future-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-16-sample-plan.md'),
    '# Sample Plan\n\n## Metadata\n\n- Plan-ID: sample-plan\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'guide.md'),
    '[Plan](docs/future/2026-03-16-sample-plan.md)\n',
    'utf8'
  );

  const result = runRepair(rootDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /stale plan refs found: 0/);
  assert.match(result.stdout, /unresolved stale refs: 0/);
});

test('repair-plan-references treats existing active plan paths as valid even without a parseable plan id', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-plan-existing-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'exec-plans', 'active'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', 'custom-plan.md'),
    '# Custom Plan\n\nNo metadata here.\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'README.md'),
    '[Plan](docs/exec-plans/active/custom-plan.md)\n',
    'utf8'
  );

  const result = runRepair(rootDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /stale plan refs found: 0/);
  assert.match(result.stdout, /unresolved stale refs: 0/);
});
