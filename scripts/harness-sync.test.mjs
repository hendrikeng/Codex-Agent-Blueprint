import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/Users/hendrik/Projects/agent-orchestration-harness';
const scriptPath = path.join(repoRoot, 'scripts', 'harness-sync.mjs');

function run(args, cwd = repoRoot) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd,
    stdio: 'pipe'
  });
}

test('harness-sync install writes target files and downstream manifest', async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sync-install-'));
  const result = run(['install', '--target', targetDir]);
  assert.equal(result.status, 0);

  const readme = await fs.readFile(path.join(targetDir, 'README.md'), 'utf8');
  assert.match(readme, /This file is intended to become the adopted repository's root `README.md`/);

  const manifest = JSON.parse(
    await fs.readFile(path.join(targetDir, 'docs', 'ops', 'automation', 'harness-manifest.json'), 'utf8')
  );
  assert.equal(Array.isArray(manifest.managedFiles), true);
  assert.equal(manifest.managedFiles.length > 10, true);
  assert.equal(typeof manifest.sourceRevision, 'string');
  assert.notEqual(manifest.sourceRevision.length, 0);
});

test('harness-sync drift reports modified managed files', async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sync-drift-'));
  assert.equal(run(['install', '--target', targetDir]).status, 0);

  await fs.writeFile(path.join(targetDir, 'README.md'), '# Modified\n', 'utf8');
  const result = run(['drift', '--target', targetDir, '--json', 'true']);

  assert.equal(result.status, 2);
  const payload = JSON.parse(String(result.stdout));
  assert.equal(payload.modified.includes('README.md'), true);
});

test('harness-sync update restores managed files when invoked outside the harness repo', async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sync-update-'));
  const callerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sync-caller-'));

  assert.equal(run(['install', '--target', targetDir], callerDir).status, 0);
  await fs.writeFile(path.join(targetDir, 'README.md'), '# Drifted\n', 'utf8');

  const result = run(['update', '--target', targetDir], callerDir);
  assert.equal(result.status, 0);

  const readme = await fs.readFile(path.join(targetDir, 'README.md'), 'utf8');
  assert.match(readme, /This file is intended to become the adopted repository's root `README.md`/);
});

test('harness-sync preserves downstream .gitignore content', async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sync-gitignore-'));
  await fs.writeFile(
    path.join(targetDir, '.gitignore'),
    'node_modules\ncustom-cache\n',
    'utf8'
  );

  const result = run(['install', '--target', targetDir]);
  assert.equal(result.status, 0);

  const gitignore = await fs.readFile(path.join(targetDir, '.gitignore'), 'utf8');
  assert.equal(gitignore, 'node_modules\ncustom-cache\n');

  const manifest = JSON.parse(
    await fs.readFile(path.join(targetDir, 'docs', 'ops', 'automation', 'harness-manifest.json'), 'utf8')
  );
  assert.equal(
    manifest.managedFiles.some((entry) => entry.targetPath === '.gitignore'),
    false
  );
});

test('harness-sync drift reports unexpected managed files from the downstream manifest', async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sync-unexpected-'));
  assert.equal(run(['install', '--target', targetDir]).status, 0);

  const manifestPath = path.join(targetDir, 'docs', 'ops', 'automation', 'harness-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.managedFiles.push({
    targetPath: 'obsolete-managed-file.txt',
    sourcePath: 'template/obsolete-managed-file.txt',
    sha256: 'stale',
    size: 0
  });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = run(['drift', '--target', targetDir, '--json', 'true']);
  assert.equal(result.status, 2);

  const payload = JSON.parse(String(result.stdout));
  assert.deepEqual(payload.unexpectedManaged, ['obsolete-managed-file.txt']);
});
