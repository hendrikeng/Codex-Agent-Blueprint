import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  compileProgramChildren,
  parseStructuredProgramChildDefinitions
} from './program-child-compiler.mjs';

async function createHarnessFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'program-child-compiler-'));
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

test('parseStructuredProgramChildDefinitions parses structured child definitions', () => {
  const parsed = parseStructuredProgramChildDefinitions(`
## Child Slice Definitions

### child-slice-one
- Title: Child Slice One
- Dependencies: none
- Spec-Targets: docs/spec.md
- Implementation-Targets: src/feature
- Validation-Lanes: always, host-required

#### Must-Land Checklist
- [ ] \`ml-child-slice-one\` Land the slice

#### Already-True Baseline
- Baseline.

#### Deferred Follow-Ons
- Follow on.

#### Capability Proof Map
| Capability ID | Must-Land IDs | Claim | Required Strength |
| --- | --- | --- | --- |
| cap-child | ml-child-slice-one | Claim | strong |

| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |
| --- | --- | --- | --- | --- | --- |
| proof-child | cap-child | integration | always | repo:verify-fast | same-run |
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.definitions.length, 1);
  assert.equal(parsed.definitions[0].planId, 'child-slice-one');
  assert.deepEqual(parsed.definitions[0].validationLanes, ['always', 'host-required']);
});

test('compileProgramChildren writes structured future children and detects stale generated output', async () => {
  const rootDir = await createHarnessFixture();
  const parentPath = path.join(rootDir, 'docs', 'future', '2026-03-15-parent-program.md');
  await fs.writeFile(parentPath, `# Parent Program

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
- Authoring-Intent: executable-default
- Dependencies: none
- Autonomy-Allowed: guarded
- Risk-Tier: medium
- Security-Approval: not-required
- Spec-Targets: docs/spec.md
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

## Child Slice Definitions

### child-slice-one
- Title: Child Slice One
- Dependencies: none
- Spec-Targets: docs/spec.md, src/feature
- Implementation-Targets: src/feature
- Validation-Lanes: always, host-required

#### Must-Land Checklist
- [ ] \`ml-child-slice-one\` Land the slice

#### Already-True Baseline
- Child baseline.

#### Deferred Follow-Ons
- Child follow on.

#### Capability Proof Map
| Capability ID | Must-Land IDs | Claim | Required Strength |
| --- | --- | --- | --- |
| cap-child | ml-child-slice-one | Claim | strong |

| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |
| --- | --- | --- | --- | --- | --- |
| proof-fast | cap-child | integration | always | repo:verify-fast | same-run |
| proof-full | cap-child | host-required | host-required | repo:verify-full | same-run |
`, 'utf8');

  const writeResult = await compileProgramChildren(rootDir, { write: true });
  assert.equal(writeResult.issues.length, 0);
  assert.equal(writeResult.writes.length, 1);
  assert.equal(writeResult.parentOutcomes[0]?.status, 'compiled-written');

  const childPath = path.join(rootDir, 'docs', 'future', writeResult.writes[0].filePath.split('/').pop());
  const childContent = await fs.readFile(childPath, 'utf8');
  assert.match(childContent, /Parent-Plan-ID: parent-program/);
  assert.match(childContent, /Validation-Lanes: always, host-required/);
  assert.match(childContent, /## Validation Contract/);
  assert.match(childContent, /repo:verify-fast/);
  assert.match(childContent, /repo:verify-full/);
  assert.doesNotMatch(childContent, /ORCH-GENERATED-END --> -->/);
  assert.doesNotMatch(childContent, /\n-->\n/);

  const activeParentPath = path.join(rootDir, 'docs', 'exec-plans', 'active', path.basename(parentPath));
  const activeChildPath = path.join(rootDir, 'docs', 'exec-plans', 'active', path.basename(childPath));
  await fs.rename(parentPath, activeParentPath);
  await fs.rename(childPath, activeChildPath);
  await fs.writeFile(
    activeParentPath,
    (await fs.readFile(activeParentPath, 'utf8')).replaceAll('ready-for-promotion', 'in-progress'),
    'utf8'
  );
  await fs.writeFile(
    activeChildPath,
    (await fs.readFile(activeChildPath, 'utf8'))
      .replaceAll('ready-for-promotion', 'validation')
      .replace('Validation-Ready: no', 'Validation-Ready: yes'),
    'utf8'
  );
  const preserveResult = await compileProgramChildren(rootDir, { write: true });
  assert.equal(preserveResult.issues.length, 0);
  const preservedChild = await fs.readFile(activeChildPath, 'utf8');
  assert.match(preservedChild, /^Validation-Ready: yes$/m);

  await fs.writeFile(
    activeChildPath,
    preservedChild.replace('- [ ] `ml-child-slice-one` Land the slice', '- [x] `ml-child-slice-one` Land the slice'),
    'utf8'
  );
  await compileProgramChildren(rootDir, { write: true });
  const preservedChecklistChild = await fs.readFile(activeChildPath, 'utf8');
  assert.match(preservedChecklistChild, /^- \[x\] `ml-child-slice-one` Land the slice$/m);

  await fs.writeFile(
    activeParentPath,
    (await fs.readFile(activeParentPath, 'utf8')).replace('Child Slice One', 'Child Slice One Updated'),
    'utf8'
  );
  const checkResult = await compileProgramChildren(rootDir, { write: false });
  assert.equal(checkResult.issues.some((issue) => issue.code === 'STALE_COMPILED_CHILD_PLAN'), true);
  assert.equal(checkResult.parentOutcomes[0]?.status, 'blocked-generated-child-drift');
});

test('compileProgramChildren derives new child filenames from the parent plan date prefix', async () => {
  const rootDir = await createHarnessFixture();
  const parentPath = path.join(rootDir, 'docs', 'future', '2024-12-31-parent-program.md');
  await fs.writeFile(parentPath, `# Parent Program

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
- Authoring-Intent: executable-default
- Dependencies: none
- Autonomy-Allowed: guarded
- Risk-Tier: medium
- Security-Approval: not-required
- Spec-Targets: docs/spec.md
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

## Child Slice Definitions

### child-slice-one
- Title: Child Slice One
- Dependencies: none
- Spec-Targets: docs/spec.md, src/feature
- Implementation-Targets: src/feature
- Validation-Lanes: always

#### Must-Land Checklist
- [ ] \`ml-child-slice-one\` Land the slice

#### Already-True Baseline
- Child baseline.

#### Deferred Follow-Ons
- Child follow on.

#### Capability Proof Map
| Capability ID | Must-Land IDs | Claim | Required Strength |
| --- | --- | --- | --- |
| cap-child | ml-child-slice-one | Claim | strong |

| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |
| --- | --- | --- | --- | --- | --- |
| proof-fast | cap-child | integration | always | repo:verify-fast | same-run |
`, 'utf8');

  const result = await compileProgramChildren(rootDir, { write: true });
  assert.equal(result.issues.length, 0);
  assert.equal(result.writes[0].filePath, 'docs/future/2024-12-31-child-slice-one.md');
});

test('compileProgramChildren fails on legacy heading-only parent schemas', async () => {
  const rootDir = await createHarnessFixture();
  await fs.writeFile(path.join(rootDir, 'docs', 'future', '2026-03-15-parent-program.md'), `# Parent Program

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
- Authoring-Intent: executable-default
- Dependencies: none
- Spec-Targets: docs/spec.md
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

### 1. Legacy Child Slice
`, 'utf8');

  const result = await compileProgramChildren(rootDir, { write: false });
  assert.equal(result.issues.some((entry) => entry.code === 'LEGACY_PROGRAM_CHILD_SCHEMA'), true);
  assert.equal(result.parentOutcomes[0]?.status, 'blocked-legacy-headings');
});

test('compileProgramChildren fails when a program parent omits Authoring-Intent and child definitions', async () => {
  const rootDir = await createHarnessFixture();
  await fs.writeFile(path.join(rootDir, 'docs', 'future', '2026-03-15-parent-program.md'), `# Parent Program

Status: draft
Validation-Ready: no

## Metadata

- Plan-ID: parent-program
- Status: draft
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Complete the child queue.
- Delivery-Class: product
- Execution-Scope: program
- Dependencies: none
- Spec-Targets: docs/spec.md
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
`, 'utf8');

  const result = await compileProgramChildren(rootDir, { write: false });
  assert.equal(result.issues.some((entry) => entry.code === 'MISSING_AUTHORING_INTENT'), true);
  assert.equal(result.parentOutcomes[0]?.status, 'blocked-missing-authoring-intent');
});
