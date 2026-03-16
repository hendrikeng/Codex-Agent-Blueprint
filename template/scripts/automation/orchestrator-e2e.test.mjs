import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templateRoot = path.join(repoRoot, 'template');

async function copyTemplate(targetDir) {
  await fs.cp(templateRoot, targetDir, { recursive: true });
}

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'pipe'
  });
}

async function initGitRepo(rootDir) {
  assert.equal(run('git', ['init'], rootDir).status, 0);
  assert.equal(run('git', ['config', 'user.email', 'fixture@example.com'], rootDir).status, 0);
  assert.equal(run('git', ['config', 'user.name', 'Fixture'], rootDir).status, 0);
  assert.equal(run('git', ['add', '.'], rootDir).status, 0);
  assert.equal(run('git', ['commit', '-m', 'fixture baseline'], rootDir).status, 0);
}

async function configureFixtureRepo(rootDir, scenario) {
  await copyTemplate(rootDir);
  await fs.mkdir(path.join(rootDir, 'docs', 'product-specs'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'docs', 'spec.md'), '# Spec\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'docs', 'product-specs', 'CURRENT-STATE.md'), '# Current State\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'src', 'feature-a.js'), 'export const featureA = "baseline";\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'src', 'feature-b.js'), 'export const featureB = "baseline";\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'src', 'dirty-feature.js'), 'export const dirtyFeature = "baseline";\n', 'utf8');

  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.executor.provider = 'fixture';
  config.executor.providers.fixture = {
    command: 'node ./scripts/automation/fixtures/stub-provider.mjs --result-path {result_path} --plan-file {plan_file} --plan-id {plan_id} --role {role} --session {session} --stage-index {stage_index} --stage-total {stage_total} --run-id {run_id} --role-model {role_model} --prompt {prompt}'
  };
  config.validation.always = [
    { id: 'fixture:always', command: 'node ./scripts/automation/fixtures/stub-host-validation.mjs', type: 'integration' }
  ];
  config.validation.hostRequired = [
    { id: 'fixture:host', command: 'node ./scripts/automation/fixtures/stub-host-validation.mjs', type: 'host-required' }
  ];
  config.validation.host = {
    mode: 'local',
    local: {
      command: 'node ./scripts/automation/fixtures/stub-host-validation.mjs'
    }
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'fixture-scenario.json'),
    `${JSON.stringify(scenario, null, 2)}\n`,
    'utf8'
  );
}

async function updateFixtureConfig(rootDir, mutate) {
  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function todayDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function fullGraphScenario() {
  return {
    providerActions: {
      'child-a': {
        planner: [{ status: 'completed', summary: 'Planner complete for child-a.' }],
        worker: [
          {
            status: 'pending',
            summary: 'Child A implementation started.',
            reason: 'Continue child A implementation.',
            writeFiles: [{ path: 'src/feature-a.js', content: 'export const featureA = "pending";\n' }]
          },
          {
            status: 'completed',
            summary: 'Child A implementation complete.',
            writeFiles: [{ path: 'src/feature-a.js', content: 'export const featureA = "done";\n' }],
            plan: {
              checkMustLand: true,
              status: 'validation',
              validationReady: 'yes',
              validationEvidence: ['fixture child-a ready']
            }
          }
        ],
        reviewer: [{ status: 'completed', summary: 'Reviewer complete for child-a.' }]
      },
      'child-b': {
        planner: [{ status: 'completed', summary: 'Planner complete for child-b.' }],
        worker: [
          {
            status: 'failed',
            summary: 'Transient worker failure for child-b.',
            reason: 'simulated transient worker failure',
            writeFiles: [{ path: 'src/feature-b.js', content: 'export const featureB = "draft";\n' }]
          },
          {
            status: 'completed',
            summary: 'Child B implementation complete.',
            writeFiles: [{ path: 'src/feature-b.js', content: 'export const featureB = "ready";\n' }],
            plan: {
              checkMustLand: true,
              status: 'validation',
              validationReady: 'host-required-only',
              validationEvidence: ['fixture child-b ready']
            }
          }
        ],
        reviewer: [{ status: 'completed', summary: 'Reviewer complete for child-b.' }]
      }
    },
    hostValidationActions: {
      'child-b': [
        { status: 'pending', reason: 'host validation pending', evidence: ['host pending'] },
        { status: 'passed', reason: null, evidence: ['host passed'], results: [{ validationId: 'fixture:host', status: 'passed' }] }
      ]
    }
  };
}

function programParentDocument(options = {}) {
  const includeChildB = options.includeChildB !== false;
  const childAHostRequired = options.childAHostRequired === true;
  const childASourceTarget = options.childASourceTarget ?? 'src/feature-a.js';
  return `# Parent Program

Status: ready-for-promotion
Validation-Ready: no

## Metadata

- Plan-ID: parent-program
- Status: ready-for-promotion
- Priority: p1
- Owner: planner
- Acceptance-Criteria: Close the child graph and parent contract.
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

- Parent program exists.

## Must-Land Checklist

- [ ] Keep parent progress derived from children.

## Deferred Follow-Ons

- None.

## Master Plan Coverage

| Capability | Current Status | This Plan | Later |
| --- | --- | --- | --- |
| Parent queue | foundation only | yes | no |

## Prior Completed Plan Reconciliation

- Reviewed.

## Promotion Blockers

- None.

## Child Slice Definitions

### child-a
- Title: Child A
- Dependencies: none
- Spec-Targets: docs/spec.md, ${childASourceTarget}
- Implementation-Targets: ${childASourceTarget}
- Validation-Lanes: ${childAHostRequired ? 'always, host-required' : 'always'}
- Risk-Tier: medium

#### Must-Land Checklist
- [ ] \`ml-child-a\` Ship child A

#### Already-True Baseline
- Child A baseline exists.

#### Deferred Follow-Ons
- None.

#### Capability Proof Map
| Capability ID | Must-Land IDs | Claim | Required Strength |
| --- | --- | --- | --- |
| cap-child-a | ml-child-a | Child A is delivered. | strong |

| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |
| --- | --- | --- | --- | --- | --- |
| proof-child-a | cap-child-a | integration | always | fixture:always | same-run |
${childAHostRequired ? '| proof-child-a-host | cap-child-a | host-required | host-required | fixture:host | same-run |' : ''}
${includeChildB ? `
### child-b
- Title: Child B
- Dependencies: child-a
- Spec-Targets: docs/spec.md, src/feature-b.js
- Implementation-Targets: src/feature-b.js
- Validation-Lanes: always, host-required
- Risk-Tier: medium

#### Must-Land Checklist
- [ ] \`ml-child-b\` Ship child B

#### Already-True Baseline
- Child B baseline exists.

#### Deferred Follow-Ons
- None.

#### Capability Proof Map
| Capability ID | Must-Land IDs | Claim | Required Strength |
| --- | --- | --- | --- |
| cap-child-b | ml-child-b | Child B is delivered. | strong |

| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |
| --- | --- | --- | --- | --- | --- |
| proof-child-b-always | cap-child-b | integration | always | fixture:always | same-run |
| proof-child-b-host | cap-child-b | host-required | host-required | fixture:host | same-run |
` : ''}
`;
}

async function writeFutureParent(rootDir, options = {}) {
  const filePath = path.join(rootDir, 'docs', 'future', '2026-03-16-parent-program.md');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, programParentDocument(options), 'utf8');
}

async function findPlanFile(rootDir, phase, planId) {
  const dir = path.join(rootDir, 'docs', 'exec-plans', phase);
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    if (!entry.endsWith('.md')) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const content = await fs.readFile(filePath, 'utf8');
    if (content.includes(`- Plan-ID: ${planId}`)) {
      return filePath;
    }
  }
  return null;
}

function orchestratorArgs(subcommand, maxPlans) {
  return [
    './scripts/automation/orchestrator.mjs',
    subcommand,
    '--mode',
    'guarded',
    '--retry-failed',
    'true',
    '--auto-unblock',
    'true',
    '--max-failed-retries',
    '2',
    '--output',
    'minimal',
    '--allow-dirty',
    'false',
    '--commit',
    'false',
    '--max-plans',
    String(maxPlans)
  ];
}

function orchestratorArgsAllowDirty(subcommand, maxPlans) {
  const args = orchestratorArgs(subcommand, maxPlans);
  const allowDirtyIndex = args.findIndex((entry) => entry === '--allow-dirty');
  if (allowDirtyIndex !== -1) {
    args[allowDirtyIndex + 1] = 'true';
  }
  return args;
}

test('orchestrator end-to-end fixture covers resume, retry, host pending/pass, stale child recompilation, and parent closeout', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-e2e-'));
  const scenario = fullGraphScenario();

  await configureFixtureRepo(rootDir, scenario);
  await writeFutureParent(rootDir);
  await initGitRepo(rootDir);

  let result = run('node', orchestratorArgs('run', 1), rootDir, { ORCH_APPROVED_MEDIUM: '1' });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(run('git', ['add', '.'], rootDir).status, 0);
  assert.equal(run('git', ['commit', '-m', 'after run one'], rootDir).status, 0);

  const activeParentPath = await findPlanFile(rootDir, 'active', 'parent-program');
  assert.ok(activeParentPath, 'expected promoted active parent');
  const activeParentContent = await fs.readFile(activeParentPath, 'utf8');
  const updatedParent = activeParentContent.replace('Child B', 'Child B Updated');
  await fs.writeFile(activeParentPath, updatedParent, 'utf8');
  assert.equal(run('git', ['add', '.'], rootDir).status, 0);
  assert.equal(run('git', ['commit', '-m', 'update parent child definitions'], rootDir).status, 0);

  result = run('node', orchestratorArgsAllowDirty('resume', 3), rootDir, { ORCH_APPROVED_MEDIUM: '1' });
  assert.equal(result.status, 0, String(result.stderr));

  const childBActivePath = await findPlanFile(rootDir, 'active', 'child-b');
  assert.ok(childBActivePath, 'expected active child-b while host validation is pending');
  const childBActiveContent = await fs.readFile(childBActivePath, 'utf8');
  assert.match(childBActiveContent, /^# Child B Updated$/m);

  const auditPending = run('node', ['./scripts/automation/orchestrator.mjs', 'audit', '--json', 'true'], rootDir);
  assert.equal(auditPending.status, 0);
  const auditPendingPayload = JSON.parse(String(auditPending.stdout));
  const pendingProgram = auditPendingPayload.programStatuses.find((entry) => entry.planId === 'parent-program');
  assert.ok(pendingProgram);
  assert.equal(pendingProgram.completedChildren, 1);
  assert.equal(pendingProgram.validationChildren, 1);
  assert.deepEqual(pendingProgram.validationPendingChildPlanIds, ['child-b']);
  assert.ok(pendingProgram.closeoutBlockedReasons.some((entry) => entry.includes('Validation pending for child slices: child-b')));

  result = run('node', orchestratorArgsAllowDirty('resume', 3), rootDir, { ORCH_APPROVED_MEDIUM: '1' });
  assert.equal(result.status, 0, String(result.stderr));

  const completedParentPath = await findPlanFile(rootDir, 'completed', 'parent-program');
  assert.ok(completedParentPath, 'expected parent closeout');
  const completedParentContent = await fs.readFile(completedParentPath, 'utf8');
  assert.match(completedParentContent, /Role Pipeline: program-closeout/);
  assert.match(completedParentContent, /Program closeout derived from child graph state/);

  const runState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  assert.equal(runState.programState['parent-program'].completedChildren, 2);
  assert.equal(runState.programState['parent-program'].childCompilationCurrent, true);

  const auditCompleted = run('node', ['./scripts/automation/orchestrator.mjs', 'audit', '--json', 'true'], rootDir);
  assert.equal(auditCompleted.status, 0);
  const auditCompletedPayload = JSON.parse(String(auditCompleted.stdout));
  const completedProgram = auditCompletedPayload.programStatuses.find((entry) => entry.planId === 'parent-program');
  assert.ok(completedProgram);
  assert.equal(completedProgram.percentComplete, 100);
});

test('supervised grind drains the full program queue and auto-closes the parent', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-grind-'));
  await configureFixtureRepo(rootDir, fullGraphScenario());
  await writeFutureParent(rootDir);
  await initGitRepo(rootDir);

  const result = run(
    'node',
    [
      './scripts/automation/supervise-orchestrator.mjs',
      'run',
      '--mode',
      'guarded',
      '--retry-failed',
      'true',
      '--auto-unblock',
      'true',
      '--max-failed-retries',
      '2',
      '--output',
      'minimal',
      '--allow-dirty',
      'false',
      '--commit',
      'false',
      '--max-plans',
      '1'
    ],
    rootDir,
    {
      ORCH_APPROVED_MEDIUM: '1',
      ORCH_SUPERVISOR_ALLOW_DIRTY_RECOVERY: '1',
      ORCH_SUPERVISOR_MAX_CYCLES: '8',
      ORCH_SUPERVISOR_STABLE_LIMIT: '2'
    }
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const completedParentPath = await findPlanFile(rootDir, 'completed', 'parent-program');
  assert.ok(completedParentPath, 'expected grind to drain the full queue and close the parent');

  const runState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  assert.equal(runState.programState['parent-program'].percentComplete, 100);
});

test('active parent edits trigger child recompilation before validation', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-parent-recompile-'));
  const activeDate = todayDateStamp();
  const updatedParent = programParentDocument({ includeChildB: false })
    .replaceAll('ready-for-promotion', 'in-progress')
    .replace('Child A', 'Child A Updated');
  const scenario = {
    providerActions: {
      'child-a': {
        planner: [{ status: 'completed', summary: 'Planner complete for child-a.' }],
        worker: [{
          status: 'completed',
          summary: 'Child A implementation complete.',
          writeFiles: [{ path: 'src/feature-a.js', content: 'export const featureA = "done";\n' }],
          plan: {
            checkMustLand: true,
            status: 'in-progress'
          }
        }],
        reviewer: [{
          status: 'completed',
          summary: 'Reviewer updated the active parent definition.',
          plan: {
            status: 'validation',
            validationReady: 'yes',
            validationEvidence: ['fixture child-a ready']
          },
          writeFiles: [{
            path: `docs/exec-plans/active/${activeDate}-parent-program.md`,
            content: updatedParent
          }]
        }]
      }
    }
  };

  await configureFixtureRepo(rootDir, scenario);
  await writeFutureParent(rootDir, { includeChildB: false });
  await initGitRepo(rootDir);

  const result = run('node', orchestratorArgs('run', 1), rootDir, { ORCH_APPROVED_MEDIUM: '1' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const completedChildPath = await findPlanFile(rootDir, 'completed', 'child-a');
  assert.ok(completedChildPath, 'expected child-a completion after automatic recompilation');
  const completedChildContent = await fs.readFile(completedChildPath, 'utf8');
  assert.match(completedChildContent, /^# Child A Updated$/m);

  const completedParentPath = await findPlanFile(rootDir, 'completed', 'parent-program');
  assert.ok(completedParentPath, 'expected parent closeout after child recompilation');
});

test('host validation failure keeps parent incomplete and surfaces derived blockers', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-host-fail-'));
  const scenario = {
    providerActions: {
      'child-a': {
        planner: [{ status: 'completed', summary: 'Planner complete for child-a.' }],
        worker: [{
          status: 'completed',
          summary: 'Child A implementation complete.',
          writeFiles: [{ path: 'src/feature-a.js', content: 'export const featureA = "done";\n' }],
          plan: {
            checkMustLand: true,
            status: 'validation',
            validationReady: 'host-required-only',
            validationEvidence: ['fixture child-a ready']
          }
        }],
        reviewer: [{ status: 'completed', summary: 'Reviewer complete for child-a.' }]
      }
    },
    hostValidationActions: {
      'child-a': [
        { status: 'failed', reason: 'fixture host validation failed', evidence: ['host failed'], results: [] }
      ]
    }
  };

  await configureFixtureRepo(rootDir, scenario);
  await writeFutureParent(rootDir, { includeChildB: false, childAHostRequired: true });
  await initGitRepo(rootDir);

  const result = run('node', orchestratorArgs('run', 3), rootDir, { ORCH_APPROVED_MEDIUM: '1' });
  assert.equal(result.status, 0, String(result.stderr));

  const failedRunState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  assert.equal(failedRunState.failedPlanIds.includes('child-a'), true);

  const audit = run('node', ['./scripts/automation/orchestrator.mjs', 'audit', '--json', 'true'], rootDir);
  const payload = JSON.parse(String(audit.stdout));
  const parentStatus = payload.programStatuses.find((entry) => entry.planId === 'parent-program');
  assert.ok(parentStatus.closeoutBlockedReasons.some((entry) => entry.includes('Incomplete child slices remain')));
  assert.ok(parentStatus.closeoutBlockedReasons.some((entry) => entry.includes('Failed child slices require retry or unblock')));
});

test('supervisor stops on repeated identical residual validation blockers without repo progress', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-residual-blocker-'));
  const scenario = {
    providerActions: {
      'child-a': {
        planner: [{ status: 'completed', summary: 'Planner complete for child-a.' }],
        worker: [{
          status: 'completed',
          summary: 'Child A implementation complete.',
          writeFiles: [{ path: 'src/feature-a.js', content: 'export const featureA = "done";\n' }],
          plan: {
            checkMustLand: true,
            status: 'validation',
            validationReady: 'yes',
            validationEvidence: ['fixture child-a ready']
          }
        }],
        reviewer: [{ status: 'completed', summary: 'Reviewer complete for child-a.' }]
      }
    },
    validation: {
      'always:child-a': [
        {
          status: 'failed',
          summary: 'External validation blocker persists.',
          findingFiles: ['docs/generated/external-blocker.json']
        },
        {
          status: 'failed',
          summary: 'External validation blocker persists.',
          findingFiles: ['docs/generated/external-blocker.json']
        },
        {
          status: 'failed',
          summary: 'External validation blocker persists.',
          findingFiles: ['docs/generated/external-blocker.json']
        }
      ]
    }
  };

  await configureFixtureRepo(rootDir, scenario);
  await updateFixtureConfig(rootDir, (config) => {
    config.validation.always = [
      {
        id: 'fixture:always',
        command: 'node ./scripts/automation/fixtures/stub-validation-command.mjs --lane always',
        type: 'integration'
      }
    ];
  });
  await writeFutureParent(rootDir, { includeChildB: false });
  await initGitRepo(rootDir);

  const result = run(
    'node',
    [
      './scripts/automation/supervise-orchestrator.mjs',
      'run',
      '--mode',
      'guarded',
      '--retry-failed',
      'true',
      '--auto-unblock',
      'true',
      '--max-failed-retries',
      '2',
      '--output',
      'minimal',
      '--allow-dirty',
      'false',
      '--commit',
      'false',
      '--max-plans',
      '1'
    ],
    rootDir,
    {
      ORCH_APPROVED_MEDIUM: '1',
      ORCH_SUPERVISOR_BLOCKER_STREAK_LIMIT: '1',
      ORCH_SUPERVISOR_STABLE_LIMIT: '10'
    }
  );

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 2, combined);
  assert.match(combined, /repeated residual validation blocker/);
});

test('supervisor dirty recovery continues unresolved work on a dirty workspace', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-dirty-recovery-'));
  const scenario = {
    providerActions: {
      'child-a': {
        planner: [{ status: 'completed', summary: 'Planner complete for child-a.' }],
        worker: [
          {
            status: 'pending',
            summary: 'Dirty workspace continuation required.',
            reason: 'Continue with dirty recovery.',
            writeFiles: [{ path: 'src/dirty-feature.js', content: 'export const dirtyFeature = "dirty";\n' }]
          },
          {
            status: 'completed',
            summary: 'Dirty recovery complete.',
            writeFiles: [{ path: 'src/dirty-feature.js', content: 'export const dirtyFeature = "done";\n' }],
            plan: {
              checkMustLand: true,
              status: 'validation',
              validationReady: 'yes',
              validationEvidence: ['dirty recovery complete']
            }
          }
        ],
        reviewer: [{ status: 'completed', summary: 'Reviewer complete for child-a.' }]
      }
    }
  };

  await configureFixtureRepo(rootDir, scenario);
  await writeFutureParent(rootDir, { includeChildB: false, childASourceTarget: 'src/dirty-feature.js' });
  await initGitRepo(rootDir);

  const result = run(
    'node',
    [
      './scripts/automation/supervise-orchestrator.mjs',
      'run',
      '--mode',
      'guarded',
      '--retry-failed',
      'true',
      '--auto-unblock',
      'true',
      '--max-failed-retries',
      '1',
      '--output',
      'minimal',
      '--allow-dirty',
      'false',
      '--commit',
      'false',
      '--max-plans',
      '1'
    ],
    rootDir,
    {
      ORCH_APPROVED_MEDIUM: '1',
      ORCH_SUPERVISOR_ALLOW_DIRTY_RECOVERY: '1',
      ORCH_SUPERVISOR_MAX_CYCLES: '4',
      ORCH_SUPERVISOR_STABLE_LIMIT: '2'
    }
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, /enabling dirty recovery mode/);
  const completedChildPath = await findPlanFile(rootDir, 'completed', 'child-a');
  assert.ok(completedChildPath);
});

test('curate-evidence restores canonical evidence readme contracts', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-evidence-'));
  await copyTemplate(rootDir);

  const activeEvidenceDir = path.join(rootDir, 'docs', 'exec-plans', 'active', 'evidence');
  const evidenceIndexDir = path.join(rootDir, 'docs', 'exec-plans', 'evidence-index');
  await fs.mkdir(activeEvidenceDir, { recursive: true });
  await fs.mkdir(evidenceIndexDir, { recursive: true });

  await fs.writeFile(
    path.join(activeEvidenceDir, 'README.md'),
    [
      '# Evidence Evidence',
      '',
      'Path: `docs/exec-plans/active/evidence`',
      'Purpose: Canonical evidence artifacts for this execution area.',
      '',
      '## Result Summary',
      '',
      '- Keep this note.'
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(path.join(activeEvidenceDir, 'sample-plan.md'), '# Sample Evidence\n', 'utf8');
  await fs.writeFile(
    path.join(evidenceIndexDir, 'README.md'),
    [
      '# Evidence Index',
      '',
      'Purpose: Canonical, plan-scoped evidence references after curation/completion.'
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(path.join(evidenceIndexDir, 'sample-plan.md'), '# Evidence Index: sample-plan\n', 'utf8');

  const result = run(
    'node',
    ['./scripts/automation/orchestrator.mjs', 'curate-evidence', '--scope', 'active'],
    rootDir
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const activeReadme = await fs.readFile(path.join(activeEvidenceDir, 'README.md'), 'utf8');
  const indexReadme = await fs.readFile(path.join(evidenceIndexDir, 'README.md'), 'utf8');

  assert.match(activeReadme, /^# Active Evidence$/m);
  assert.match(activeReadme, /^Status: canonical$/m);
  assert.match(activeReadme, /^Owner: \{\{DOC_OWNER\}\}$/m);
  assert.match(activeReadme, /^Last Updated: \{\{LAST_UPDATED_ISO_DATE\}\}$/m);
  assert.match(activeReadme, /^Source of Truth: This directory\.$/m);
  assert.match(activeReadme, /^## Purpose$/m);
  assert.match(activeReadme, /Canonical evidence artifacts for active execution plans\./);
  assert.match(activeReadme, /^## Result Summary$/m);
  assert.match(activeReadme, /- Keep this note\./);
  assert.doesNotMatch(activeReadme, /^Path:/m);

  assert.match(indexReadme, /^# Evidence Index$/m);
  assert.match(indexReadme, /^Status: canonical$/m);
  assert.match(indexReadme, /^Owner: \{\{DOC_OWNER\}\}$/m);
  assert.match(indexReadme, /^Last Updated: \{\{LAST_UPDATED_ISO_DATE\}\}$/m);
  assert.match(indexReadme, /^Source of Truth: This directory\.$/m);
  assert.match(indexReadme, /^## Usage$/m);
  assert.match(indexReadme, /\[`sample-plan\.md`\]\(\.\/sample-plan\.md\)/);
  assert.doesNotMatch(indexReadme, /^Purpose: Canonical, plan-scoped evidence references after curation\/completion\.$/m);
});
