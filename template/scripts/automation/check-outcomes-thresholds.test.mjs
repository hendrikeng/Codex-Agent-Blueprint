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
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outcomes-thresholds-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });
  return rootDir;
}

async function writeJson(rootDir, relativePath, payload) {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runCheck(rootDir, env = {}) {
  return spawnSync(
    'node',
    ['./scripts/automation/check-outcomes-thresholds.mjs'],
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

test('outcome thresholds stay lenient when the session sample is insufficient', async () => {
  const rootDir = await createFixtureRoot();
  await writeJson(rootDir, 'docs/ops/automation/orchestrator.config.json', {
    continuity: {
      thresholds: {
        maxDerivedContinuityRate: 0.1,
        minResumeSafeCheckpointRate: 0.9,
        maxThinPackRate: 0.3,
        maxRepeatedHandoffLoopPlans: 0
      }
    }
  });
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      memory: {
        sessions: 12,
        derivedContinuityRate: 0.4,
        resumeSafeCheckpointRate: 0.5,
        contactPacks: {
          thinRate: 0.5
        }
      },
      rework: {
        repeatedHandoffLoopPlans: 2
      }
    }
  });

  const result = runCheck(rootDir, { CI: 'true' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /insufficient session sample \(12\/25\)/);
});

test('outcome thresholds fail in CI when the sample is sufficient and thresholds are breached', async () => {
  const rootDir = await createFixtureRoot();
  await writeJson(rootDir, 'docs/ops/automation/orchestrator.config.json', {
    continuity: {
      thresholds: {
        maxDerivedContinuityRate: 0.1,
        minResumeSafeCheckpointRate: 0.9,
        maxThinPackRate: 0.3,
        maxRepeatedHandoffLoopPlans: 0
      }
    }
  });
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      memory: {
        sessions: 30,
        derivedContinuityRate: 0.4,
        resumeSafeCheckpointRate: 0.5,
        contactPacks: {
          thinRate: 0.5
        }
      },
      rework: {
        repeatedHandoffLoopPlans: 2
      }
    }
  });

  const result = runCheck(rootDir, { CI: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[outcomes-verify\] failed:/);
});

test('outcome thresholds stay warning-only outside CI by default', async () => {
  const rootDir = await createFixtureRoot();
  await writeJson(rootDir, 'docs/ops/automation/orchestrator.config.json', {
    continuity: {
      thresholds: {
        maxDerivedContinuityRate: 0.1,
        minResumeSafeCheckpointRate: 0.9,
        maxThinPackRate: 0.3,
        maxRepeatedHandoffLoopPlans: 0
      }
    }
  });
  await writeJson(rootDir, 'docs/generated/run-outcomes.json', {
    summary: {
      memory: {
        sessions: 30,
        derivedContinuityRate: 0.4,
        resumeSafeCheckpointRate: 0.5,
        contactPacks: {
          thinRate: 0.5
        }
      },
      rework: {
        repeatedHandoffLoopPlans: 2
      }
    }
  });

  const result = runCheck(rootDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[outcomes-verify\] warning:/);
});
