import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createTemplateRepo, runNode } from './test-helpers.mjs';

test('harness:verify fails when package.json keeps a retired harness script', async () => {
  const rootDir = await createTemplateRepo();
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  packageJson.scripts['automation:run:parallel'] =
    'node ./scripts/automation/orchestrator.mjs run-parallel';
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'check-harness-alignment.mjs'),
    [],
    rootDir
  );

  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /RETIRED_SCRIPT/);
  assert.match(String(result.stderr), /package\.json/);
});

test('harness:verify fails when package.json drifts from the managed harness fragment', async () => {
  const rootDir = await createTemplateRepo();
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  packageJson.scripts['automation:grind'] = 'node ./scripts/automation/orchestrator.mjs run';
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'check-harness-alignment.mjs'),
    [],
    rootDir
  );

  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /SCRIPT_MISMATCH/);
  assert.match(String(result.stderr), /automation:grind/);
});

test('harness:verify fails when canonical docs reference retired harness commands', async () => {
  const rootDir = await createTemplateRepo();
  const plansPath = path.join(rootDir, 'docs', 'PLANS.md');
  const plansDoc = await fs.readFile(plansPath, 'utf8');
  const drifted = `${plansDoc}\nLegacy fallback: \`automation:run:parallel\`.\n`;
  await fs.writeFile(plansPath, drifted, 'utf8');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'check-harness-alignment.mjs'),
    [],
    rootDir
  );

  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /RETIRED_DOC_REFERENCE/);
  assert.match(String(result.stderr), /docs\/PLANS\.md/);
});

test('harness:verify fails when codex executor command omits role sandbox wiring', async () => {
  const rootDir = await createTemplateRepo();
  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.executor.command =
    'codex -a never exec --json --full-auto -c model_reasoning_effort={reasoning_effort} -m {model} {prompt}';
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'check-harness-alignment.mjs'),
    [],
    rootDir
  );

  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /MISSING_SANDBOX_PLACEHOLDER/);
  assert.match(String(result.stderr), /MISSING_SANDBOX_FLAG/);
  assert.match(String(result.stderr), /INVALID_CODEX_FULL_AUTO/);
});

test('harness:verify fails when codex approval flag is placed after exec', async () => {
  const rootDir = await createTemplateRepo();
  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.executor.command =
    'codex exec --json -a never --sandbox {sandbox_mode} -c model_reasoning_effort={reasoning_effort} -m {model} {prompt}';
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'check-harness-alignment.mjs'),
    [],
    rootDir
  );

  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /MISPLACED_APPROVAL_FLAG/);
});
