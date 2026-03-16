import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = path.join(repoRoot, 'template', 'scripts', 'agent-hardening', 'check-evals.mjs');

async function createFixtureRoot() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-evals-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'agent-hardening'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'docs', 'generated'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'AGENTS.md'),
    'Owner: Platform\nLast Updated: 2026-03-16\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'README.md'),
    'Owner: Platform\nLast Updated: 2026-03-16\nCurrent State Date: 2026-03-16\n',
    'utf8'
  );
  await fs.writeFile(path.join(rootDir, 'docs', 'evidence.md'), '# Evidence\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'docs', 'agent-hardening', 'continuity-fixtures.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'docs', 'agent-hardening', 'resilience-fixtures.json'), '{}\n', 'utf8');
  await fs.writeFile(
    path.join(rootDir, 'docs', 'agent-hardening', 'evals.config.json'),
    `${JSON.stringify({
      reportPath: 'docs/generated/evals-report.json',
      continuityReportPath: 'docs/generated/continuity-evals-report.json',
      resilienceReportPath: 'docs/generated/resilience-evals-report.json',
      maxAgeDays: 14,
      minimumPassRate: 0.9,
      continuityMinimumPassRate: 0.9,
      resilienceMinimumPassRate: 1,
      maxCriticalRegressions: 0,
      maxHighRegressions: 0,
      requiredSuites: [{ id: 'suite-a', status: 'pass' }],
      requiredContinuitySuites: [{ id: 'continuity-suite', status: 'pass' }],
      requiredResilienceSuites: [{ id: 'resilience-suite', status: 'pass' }],
      requireEvidencePaths: true
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

function validReport(generatedAtUtc) {
  return {
    generatedAtUtc,
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      passRate: 1
    },
    regressions: {
      criticalOpen: 0,
      highOpen: 0
    },
    suites: [
      {
        id: 'suite-a',
        status: 'pass',
        total: 1,
        passed: 1,
        failed: 0
      }
    ],
    evidence: ['docs/evidence.md']
  };
}

function validContinuityReport(generatedAtUtc) {
  return {
    generatedAtUtc,
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      passRate: 1
    },
    suites: [
      {
        id: 'continuity-suite',
        status: 'pass',
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0
      }
    ],
    evidence: ['docs/agent-hardening/continuity-fixtures.json']
  };
}

function validResilienceReport(generatedAtUtc) {
  return {
    generatedAtUtc,
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      passRate: 1,
      criticalTotal: 1,
      criticalPassed: 1,
      criticalPassRate: 1
    },
    suites: [
      {
        id: 'resilience-suite',
        status: 'pass',
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0
      }
    ],
    evidence: ['docs/agent-hardening/resilience-fixtures.json']
  };
}

test('check-evals fails future-dated primary reports', async () => {
  const rootDir = await createFixtureRoot();
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'evals-report.json'),
    `${JSON.stringify(validReport('2026-03-17T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'continuity-evals-report.json'),
    `${JSON.stringify(validContinuityReport('2026-03-16T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'resilience-evals-report.json'),
    `${JSON.stringify(validResilienceReport('2026-03-16T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );

  const result = spawnSync('node', [scriptPath], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /generatedAtUtc is in the future/);
});

test('check-evals fails future-dated continuity reports', async () => {
  const rootDir = await createFixtureRoot();
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'evals-report.json'),
    `${JSON.stringify(validReport('2026-03-16T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'continuity-evals-report.json'),
    `${JSON.stringify(validContinuityReport('2026-03-17T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'resilience-evals-report.json'),
    `${JSON.stringify(validResilienceReport('2026-03-16T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );

  const result = spawnSync('node', [scriptPath], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Continuity eval report generatedAtUtc is in the future/);
});

test('check-evals fails future-dated resilience reports', async () => {
  const rootDir = await createFixtureRoot();
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'evals-report.json'),
    `${JSON.stringify(validReport('2026-03-16T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'continuity-evals-report.json'),
    `${JSON.stringify(validContinuityReport('2026-03-16T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'generated', 'resilience-evals-report.json'),
    `${JSON.stringify(validResilienceReport('2026-03-17T00:00:00Z'), null, 2)}\n`,
    'utf8'
  );

  const result = spawnSync('node', [scriptPath], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Resilience eval report generatedAtUtc is in the future/);
});
