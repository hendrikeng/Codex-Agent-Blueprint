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
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-baseline-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });
  return rootDir;
}

async function writeJson(rootDir, relativePath, payload) {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('collect-performance-baseline carries sample sizes from run outcomes into perf samples', async () => {
  const rootDir = await createFixtureRoot();
  const outputPath = 'docs/generated/perf-comparison-test.json';
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      completion: {
        completedPlans: 14
      },
      memory: {
        sessions: 33
      },
      speed: {
        timeToFirstWorkerEditSeconds: {
          sampleSize: 28,
          median: 42.5
        }
      }
    }
  });

  const result = spawnSync(
    'node',
    ['./scripts/automation/collect-performance-baseline.mjs', '--stage', 'after', '--output', outputPath],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: process.env
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(await fs.readFile(path.join(rootDir, outputPath), 'utf8'));
  assert.equal(payload.samples.after.orchestration.completedPlansSampleSize, 14);
  assert.equal(payload.samples.after.orchestration.sessionSampleSize, 33);
  assert.equal(payload.samples.after.orchestration.timeToFirstWorkerEditSampleSize, 28);
  assert.equal(payload.samples.after.orchestration.timeToFirstWorkerEditMedianSeconds, 42.5);
});
