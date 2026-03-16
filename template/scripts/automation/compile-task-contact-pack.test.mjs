import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compileTaskContactPack } from './compile-task-contact-pack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templateRoot = path.join(repoRoot, 'template');
const cliPath = path.join(repoRoot, 'template', 'scripts', 'automation', 'compile-task-contact-pack.mjs');

async function createFixtureRoot() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contact-pack-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });
  const planPath = path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-16-sample-plan.md');
  await fs.writeFile(
    planPath,
    `# Sample Plan

Status: in-progress
Validation-Ready: no

## Metadata

- Plan-ID: sample-plan
- Status: in-progress
- Priority: p1
- Owner: worker
- Acceptance-Criteria: Keep continuity useful.
- Delivery-Class: product
- Execution-Scope: slice
- Dependencies: none
- Spec-Targets: docs/spec.md
- Implementation-Targets: src/sample.ts
- Risk-Tier: medium
- Done-Evidence: pending
`,
    'utf8'
  );
  const continuityDir = path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'state', 'sample-plan');
  await fs.mkdir(continuityDir, { recursive: true });
  await fs.writeFile(
    path.join(continuityDir, 'latest.json'),
    `${JSON.stringify({
      planId: 'sample-plan',
      role: 'worker',
      status: 'pending',
      currentSubtask: 'Finish the current slice',
      nextAction: 'Run the focused verification command',
      pendingActions: ['verify one path'],
      openQuestions: [],
      risks: [],
      completedWork: [],
      acceptedFacts: [],
      evidence: {
        artifactRefs: ['docs/evidence.md'],
        logRefs: [],
        validationRefs: []
      }
    }, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(continuityDir, 'checkpoints.jsonl'),
    [
      JSON.stringify({ planId: 'sample-plan', role: 'worker', status: 'pending', currentSubtask: 'one', nextAction: 'alpha' }),
      JSON.stringify({ planId: 'sample-plan', role: 'worker', status: 'pending', currentSubtask: 'two', nextAction: 'beta' }),
      JSON.stringify({ planId: 'sample-plan', role: 'reviewer', status: 'pending', currentSubtask: 'three', nextAction: 'gamma' })
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'continuity-analytics.json'),
    `${JSON.stringify({ schemaVersion: 1, updatedAt: '2026-03-16T00:00:00Z', items: {} }, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(path.join(rootDir, 'docs', 'evidence.md'), '# Evidence\n', 'utf8');
  return { rootDir, planPath };
}

test('compileTaskContactPack preserves top-level nextAction and caps rendered checkpoints', async () => {
  const { rootDir } = await createFixtureRoot();
  const result = await compileTaskContactPack({
    rootDir,
    planId: 'sample-plan',
    planFile: 'docs/exec-plans/active/2026-03-16-sample-plan.md',
    role: 'worker',
    maxRecentCheckpointItems: 1,
    outputPath: 'docs/ops/automation/runtime/contacts/manual/contact-pack.md'
  });

  const output = await fs.readFile(path.join(rootDir, result.outputPath), 'utf8');
  assert.match(output, /next action: Run the focused verification command/);
  assert.equal((output.match(/^- role=/gm) ?? []).length, 1);
});

test('compile-task-contact-pack CLI runs correctly through a symlinked repo path', async () => {
  const { rootDir } = await createFixtureRoot();
  const aliasRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'contact-pack-alias-')), 'repo-alias');
  await fs.symlink(rootDir, aliasRoot);

  const result = spawnSync(
    'node',
    [
      path.join(aliasRoot, 'scripts', 'automation', 'compile-task-contact-pack.mjs'),
      '--plan-id',
      'sample-plan',
      '--plan-file',
      'docs/exec-plans/active/2026-03-16-sample-plan.md',
      '--output',
      'docs/ops/automation/runtime/contacts/manual/contact-pack-cli.md'
    ],
    {
      cwd: aliasRoot,
      encoding: 'utf8'
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[contact-pack\] wrote/);
  const outputPath = path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'contacts', 'manual', 'contact-pack-cli.md');
  const output = await fs.readFile(outputPath, 'utf8');
  assert.match(output, /Plan-ID: sample-plan/);
});
