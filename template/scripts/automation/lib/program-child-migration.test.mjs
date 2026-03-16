import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseStructuredProgramChildDefinitions } from './program-child-compiler.mjs';
import { migrateLegacyProgramChildDefinitions } from './program-child-migration.mjs';

async function createFixtureRoot() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'program-child-migration-'));
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
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

function legacyParentContent() {
  return `# Parent Program

Status: ready-for-promotion
Validation-Ready: no

## Metadata

- Plan-ID: parent-program
- Status: ready-for-promotion
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Complete the child queue.
- Delivery-Class: product
- Execution-Scope: program
- Dependencies: none
- Autonomy-Allowed: guarded
- Risk-Tier: medium
- Security-Approval: not-required
- Spec-Targets: docs/spec.md, src/feature
- Done-Evidence: pending

## Already-True Baseline

- Parent baseline.

## Must-Land Checklist

- [ ] Keep the parent active while children execute.

## Deferred Follow-Ons

- Later.

## Master Plan Coverage

| Capability | Current Status | This Plan | Later |
| --- | --- | --- | --- |
| Parent queue | foundation only | yes | no |

## Prior Completed Plan Reconciliation

- None.

## Promotion Blockers

- None.

## Remaining Execution Slices

### 1. Lifecycle Workbench, Availability Graph, And Smart Calendar
### 2. Execution Assist And Collaboration
`;
}

test('migrateLegacyProgramChildDefinitions replaces legacy sections with structured definitions', () => {
  const result = migrateLegacyProgramChildDefinitions(legacyParentContent(), {
    validationIds: {
      always: ['repo:verify-fast'],
      'host-required': ['repo:verify-full']
    }
  });

  assert.equal(result.changed, true);
  assert.equal(result.legacyUnits.length, 2);
  assert.match(result.updatedContent, /- Authoring-Intent: executable-default/);
  assert.match(result.updatedContent, /## Child Slice Definitions/);
  assert.doesNotMatch(result.updatedContent, /## Remaining Execution Slices/);

  const parsed = parseStructuredProgramChildDefinitions(result.updatedContent);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.definitions.length, 2);
  assert.equal(parsed.definitions[0].planId, 'lifecycle-workbench-availability-graph-and-smart-calendar');
  assert.equal(parsed.definitions[0].title, 'Lifecycle Workbench, Availability Graph, And Smart Calendar');
  assert.deepEqual(parsed.definitions[0].implementationTargets, ['src/feature']);
  assert.deepEqual(parsed.definitions[0].validationLanes, ['always', 'host-required']);
  assert.match(parsed.definitions[0].proofMapBody, /repo:verify-fast/);
  assert.match(parsed.definitions[0].proofMapBody, /repo:verify-full/);
});

test('migrateLegacyProgramChildDefinitions preserves explicit plan-id hints from portfolio units', () => {
  const result = migrateLegacyProgramChildDefinitions(`
## Metadata

- Plan-ID: parent-program
- Delivery-Class: product
- Execution-Scope: program
- Spec-Targets: src/workflow

## 2026-2027 Portfolio Units

### PU-01 (Q2 2026): organizer-wizard-v2-step-ia-and-progress
### PU-02 (Q2 2026): organizer-wizard-v2-save-resume-center
`, {
    validationIds: {
      always: ['repo:verify-fast'],
      'host-required': []
    }
  });

  const parsed = parseStructuredProgramChildDefinitions(result.updatedContent);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(
    parsed.definitions.map((entry) => entry.planId),
    [
      'organizer-wizard-v2-step-ia-and-progress',
      'organizer-wizard-v2-save-resume-center'
    ]
  );
  assert.equal(parsed.definitions[0].title, 'Organizer Wizard V2 Step Ia And Progress');
  assert.deepEqual(parsed.definitions[0].validationLanes, ['always']);
});

test('migrateLegacyProgramChildDefinitions rejects blueprint-only parents', () => {
  assert.throws(
    () => migrateLegacyProgramChildDefinitions(`
## Metadata

- Plan-ID: parent-program
- Delivery-Class: product
- Execution-Scope: program
- Authoring-Intent: blueprint-only
- Spec-Targets: src/workflow

## Remaining Execution Slices

### 1. Legacy Child Slice
`),
    /blueprint-only/
  );
});

test('migrate-program-children CLI previews to stdout and writes only with --write true', async () => {
  const rootDir = await createFixtureRoot();
  const planFile = path.join(rootDir, 'docs', 'future', '2026-03-16-parent-program.md');
  await fs.writeFile(planFile, legacyParentContent(), 'utf8');
  const cliPath = path.join('/Users/hendrik/Projects/agent-orchestration-harness', 'template', 'scripts', 'automation', 'migrate-program-children.mjs');

  const preview = spawnSync(
    'node',
    [cliPath, '--plan-file', 'docs/future/2026-03-16-parent-program.md'],
    {
      cwd: rootDir,
      encoding: 'utf8'
    }
  );
  assert.equal(preview.status, 0);
  assert.match(preview.stderr, /preview generated 2 structured child definition/);
  assert.match(preview.stdout, /## Child Slice Definitions/);

  const untouched = await fs.readFile(planFile, 'utf8');
  assert.match(untouched, /## Remaining Execution Slices/);

  const write = spawnSync(
    'node',
    [cliPath, '--plan-file', 'docs/future/2026-03-16-parent-program.md', '--write', 'true'],
    {
      cwd: rootDir,
      encoding: 'utf8'
    }
  );
  assert.equal(write.status, 0);
  assert.match(write.stderr, /wrote docs\/future\/2026-03-16-parent-program.md/);

  const updated = await fs.readFile(planFile, 'utf8');
  assert.match(updated, /## Child Slice Definitions/);
  assert.doesNotMatch(updated, /## Remaining Execution Slices/);
});
