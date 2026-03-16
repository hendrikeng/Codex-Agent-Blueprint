import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = path.join(repoRoot, 'template', 'scripts', 'automation', 'check-plan-metadata.mjs');

async function createFixtureRoot() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-plan-metadata-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'docs', 'exec-plans', 'active'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'docs', 'exec-plans', 'completed'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'docs', 'ops', 'automation'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json'),
    `${JSON.stringify({
      validation: {
        always: [{ id: 'repo:verify-fast', command: 'npm run verify:fast' }],
        hostRequired: [{ id: 'repo:verify-full', command: 'npm run verify:full' }]
      }
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

async function writeFuturePlan(rootDir, content) {
  const planPath = path.join(rootDir, 'docs', 'future', '2026-03-16-parent-program.md');
  await fs.writeFile(planPath, content, 'utf8');
  return planPath;
}

function runVerify(rootDir) {
  return spawnSync('node', [cliPath], {
    cwd: rootDir,
    encoding: 'utf8'
  });
}

function futureProgramPlan(metadataLines, bodyLines = []) {
  return [
    '# Parent Program',
    '',
    `Status: ${metadataLines.status ?? 'draft'}`,
    'Validation-Ready: no',
    '',
    '## Metadata',
    '',
    '- Plan-ID: parent-program',
    `- Status: ${metadataLines.status ?? 'draft'}`,
    '- Priority: p1',
    '- Owner: planner',
    '- Acceptance-Criteria: Complete the child queue.',
    '- Delivery-Class: product',
    '- Execution-Scope: program',
    ...(metadataLines.authoringIntent ? [`- Authoring-Intent: ${metadataLines.authoringIntent}`] : []),
    '- Dependencies: none',
    '- Autonomy-Allowed: guarded',
    '- Risk-Tier: medium',
    '- Security-Approval: not-required',
    '- Spec-Targets: docs/spec.md, src/feature',
    '- Done-Evidence: pending',
    '',
    '## Already-True Baseline',
    '',
    '- Parent baseline.',
    '',
    '## Must-Land Checklist',
    '',
    '- [ ] Keep the parent active while children execute.',
    '',
    '## Deferred Follow-Ons',
    '',
    '- Later.',
    '',
    '## Master Plan Coverage',
    '',
    '| Capability | Current Status | This Plan | Later |',
    '| --- | --- | --- | --- |',
    '| Parent queue | foundation only | yes | no |',
    '',
    '## Prior Completed Plan Reconciliation',
    '',
    '- Reviewed.',
    '',
    '## Promotion Blockers',
    '',
    '- None.',
    '',
    ...bodyLines,
    ''
  ].join('\n');
}

test('plans:verify fails future program parents that omit Authoring-Intent', async () => {
  const rootDir = await createFixtureRoot();
  await writeFuturePlan(rootDir, futureProgramPlan({}));

  const result = runVerify(rootDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[MISSING_AUTHORING_INTENT\]/);
});

test('plans:verify fails executable-default future program parents that omit child definitions', async () => {
  const rootDir = await createFixtureRoot();
  await writeFuturePlan(rootDir, futureProgramPlan({
    authoringIntent: 'executable-default'
  }));

  const result = runVerify(rootDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[PROGRAM_PARENT_MISSING_CHILD_DEFINITIONS\]/);
});

test('plans:verify fails blueprint-only parents marked ready-for-promotion', async () => {
  const rootDir = await createFixtureRoot();
  await writeFuturePlan(rootDir, futureProgramPlan({
    status: 'ready-for-promotion',
    authoringIntent: 'blueprint-only'
  }));

  const result = runVerify(rootDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[BLUEPRINT_ONLY_PROGRAM_NOT_DRAFT\]/);
});

test('plans:verify fails legacy-shaped executable-default parents', async () => {
  const rootDir = await createFixtureRoot();
  await writeFuturePlan(rootDir, futureProgramPlan(
    { authoringIntent: 'executable-default' },
    [
      '## Remaining Execution Slices',
      '',
      '### 1. Legacy Child Slice'
    ]
  ));

  const result = runVerify(rootDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[LEGACY_PROGRAM_CHILD_SCHEMA\]/);
});
