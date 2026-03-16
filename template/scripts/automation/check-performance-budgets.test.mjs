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
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-budgets-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });
  return rootDir;
}

async function writeJson(rootDir, relativePath, payload) {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function basePerfReport(overrides = {}) {
  return {
    generatedAtUtc: new Date().toISOString(),
    samples: {
      baseline: {
        orchestration: {
          completedPlansSampleSize: 12,
          timeToFirstWorkerEditSampleSize: 30
        },
        validation: {
          verifyFastStatus: 0,
          verifyFullStatus: 0
        }
      },
      after: {
        orchestration: {
          completedPlansSampleSize: 12,
          timeToFirstWorkerEditSampleSize: 30
        },
        validation: {
          verifyFastStatus: 0,
          verifyFullStatus: 0
        }
      }
    },
    comparison: {
      runtimeContextTokens: { from: 100, to: 105, delta: 5, deltaPercent: 5 },
      verifyFastDurationMs: { from: 100, to: 110, delta: 10, deltaPercent: 10 },
      verifyFullDurationMs: { from: 100, to: 110, delta: 10, deltaPercent: 10 },
      timeToFirstWorkerEditMedianSeconds: { from: 100, to: 110, delta: 10, deltaPercent: 10 },
      averageSessionsPerCompletedPlan: { from: 2, to: 2.1, delta: 0.1, deltaPercent: 5 }
    },
    ...overrides
  };
}

function runCheck(rootDir, env = {}) {
  return spawnSync(
    'node',
    ['./scripts/automation/check-performance-budgets.mjs'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env
      }
    }
  );
}

test('perf budgets pass when regressions stay within the configured limits', async () => {
  const rootDir = await createFixtureRoot();
  await writeJson(rootDir, 'docs/generated/perf-comparison.json', basePerfReport());
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      speed: {
        timeToFirstWorkerEditSeconds: {
          sampleSize: 30
        }
      }
    }
  });

  const result = runCheck(rootDir, { CI: 'true' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[perf-verify\] passed\./);
});

test('perf budgets fail in CI when a comparable metric exceeds its budget', async () => {
  const rootDir = await createFixtureRoot();
  const report = basePerfReport();
  report.comparison.runtimeContextTokens.deltaPercent = 20;
  report.comparison.runtimeContextTokens.to = 120;
  await writeJson(rootDir, 'docs/generated/perf-comparison.json', report);
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      speed: {
        timeToFirstWorkerEditSeconds: {
          sampleSize: 30
        }
      }
    }
  });

  const result = runCheck(rootDir, { CI: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /runtimeContextTokens regressed 20%/);
});

test('perf budgets skip worker-edit gating when the sample is insufficient', async () => {
  const rootDir = await createFixtureRoot();
  const report = basePerfReport({
    samples: {
      baseline: {
        orchestration: {
          completedPlansSampleSize: 12,
          timeToFirstWorkerEditSampleSize: 5
        },
        validation: {
          verifyFastStatus: 0,
          verifyFullStatus: 0
        }
      },
      after: {
        orchestration: {
          completedPlansSampleSize: 12,
          timeToFirstWorkerEditSampleSize: 5
        },
        validation: {
          verifyFastStatus: 0,
          verifyFullStatus: 0
        }
      }
    }
  });
  await writeJson(rootDir, 'docs/generated/perf-comparison.json', report);
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      speed: {
        timeToFirstWorkerEditSeconds: {
          sampleSize: 5
        }
      }
    }
  });

  const result = runCheck(rootDir, { CI: 'true' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped timeToFirstWorkerEditMedianSeconds: insufficient time-to-first-worker-edit sample/);
});
