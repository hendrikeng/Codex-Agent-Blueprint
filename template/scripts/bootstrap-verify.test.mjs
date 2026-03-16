import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const syncScriptPath = path.join(repoRoot, 'scripts', 'harness-sync.mjs');

test('bootstrap-verify resolves repo root when invoked from a nested directory', async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-verify-'));
  const install = spawnSync('node', [syncScriptPath, 'install', '--target', targetDir], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(install.status, 0);

  const result = spawnSync('bash', ['../scripts/bootstrap-verify.sh'], {
    cwd: path.join(targetDir, 'docs'),
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /No such file or directory/);
  assert.match(result.stdout, /\[placeholder-check\]/);
});
